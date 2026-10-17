// Core pipeline tests (SPEC §23.1 "core"): real modules in fake mode, FakePolicyChain, temp DATA_DIR.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FakePolicyChain } from "../chain/fake-policy-chain.js";
import { loadConfig } from "../shared/config.js";
import { ceilToTick, decMul, floorToTick } from "../shared/money.js";
import { defaultPolicy, type AgentDecision, type Hex32 } from "../shared/schemas.js";
import { runStartupChecks } from "./startup.js";
import { agentStateStore } from "./state-store.js";
import { Vekil } from "./vekil.js";
import { buildRuntime, type Runtime } from "./wiring.js";

const dirs: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(): Promise<Runtime & { fchain: FakePolicyChain; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "vekil-core-"));
  dirs.push(dataDir);
  const cfg = loadConfig({ dotenv: false, env: { EXECUTION_MODE: "fake", LLM_PROVIDER: "scripted", CHAIN: "fake", DATA_DIR: dataDir } });
  const rt = await buildRuntime(cfg, { executorLoops: false, wipeEphemeral: false });
  runtimes.push(rt);
  const rep = await rt.core.startup();
  expect(rep.ok).toBe(true);
  const fchain = rt.chain as FakePolicyChain;
  await fchain.setPolicy({ ...defaultPolicy(rt.clock.now()), maxTradesPerHour: 5, maxTradesPerDay: 10 });
  return { ...rt, fchain, dataDir };
}

const common = {
  regime: "TREND_UP", playbook: "TREND_PULLBACK", evidence: ["test"], scenarios: { bull: "b", bear: "b" }, thesis: "t", invalidation: "i", confidence: 50, nextCheckInMin: 10,
} as const;

async function buy(rt: Runtime, over: Partial<Extract<AgentDecision, { action: "BUY" }>> = {}): Promise<AgentDecision> {
  const s = await rt.market.getSnapshot("AVAX-TRY");
  const px = ceilToTick(decMul(s.ask, "1.001"), "0.1");
  return {
    action: "BUY", instId: "AVAX-TRY", ...common, evidence: ["test"], quoteAmount: "200",
    stopPx: floorToTick(decMul(px, "0.99"), "0.1"), tpPx: ceilToTick(decMul(px, "1.02"), "0.1"), timeStopMin: 240, ...over,
  };
}
const writes = (c: FakePolicyChain, fn: string): number => c.txLog.filter((t) => t.fn === fn).length;

describe("core pipeline", () => {
  it("BUY → APPROVED → EXECUTED; FILL synced into the ledger", async () => {
    const rt = await setup();
    const r = await rt.core.runCycle({ trigger: "manual", rogue: await buy(rt) });
    expect(r.outcome).toBe("EXECUTED");
    expect(rt.deps.ledger.readAll().map((e) => e.kind)).toContain("FILL");
    expect(rt.core.getState().executor.positions).toHaveLength(1);
  });

  it("LOCAL_BLOCK sends no chain tx", async () => {
    const rt = await setup();
    await rt.core.runCycle({ trigger: "manual", rogue: await buy(rt) });
    const before = writes(rt.fchain, "requestApproval");
    const r = await rt.core.runCycle({ trigger: "manual", rogue: await buy(rt) });
    expect(r.outcome).toBe("LOCAL_BLOCK");
    expect(r.reasons.map((x) => x.code)).toEqual(["POSITION_ALREADY_OPEN"]);
    expect(writes(rt.fchain, "requestApproval")).toBe(before);
  });

  it("REJECTED never executes; a critical rejection kills (HALTED, source chain)", async () => {
    const rt = await setup();
    rt.fchain.scriptNext({ reasons: ["STOP_TOO_WIDE"], critical: false });
    const a = await rt.core.runCycle({ trigger: "manual", rogue: await buy(rt) });
    expect(a.outcome).toBe("REJECTED");
    expect(rt.deps.ledger.readAll().some((e) => e.kind === "EXECUTE")).toBe(false);
    // Suspect (foreign pair, no stop) → goes to the chain even though not a test → critical.
    const { stopPx: _s, ...noStop } = (await buy(rt)) as Extract<AgentDecision, { action: "BUY" }>;
    const b = await rt.core.runCycle({ trigger: "manual", rogue: { ...noStop, instId: "DOGE-TRY", quoteAmount: "10000" } });
    expect(b.outcome).toBe("REJECTED");
    expect(b.chain?.critical).toBe(true);
    expect(rt.core.getState().status).toBe("HALTED");
    const kill = rt.deps.ledger.readAll().filter((e) => e.kind === "KILL").at(-1)!;
    expect((kill.payload as { source: string }).source).toBe("chain");
  });

  it("an APPROVED test request never executes and raises TEST BAŞARISIZ", async () => {
    const rt = await setup();
    const r = await rt.core.runCycle({ trigger: "redteam-rogue", test: true, rogue: await buy(rt), forceChain: true });
    expect(r.outcome).toBe("TEST_CYCLE");
    expect(r.chain?.status).toBe("APPROVED");
    expect(r.note).toBe("TEST BAŞARISIZ");
    expect(rt.deps.ledger.readAll().some((e) => e.kind === "EXECUTE")).toBe(false);
  });

  it("UNKNOWN order state halts", async () => {
    const rt = await setup();
    const ex = rt.inProcess!.executor;
    const orig = ex.execute.bind(ex);
    ex.execute = async (...args) => ({ ...(await orig(...args)), result: "UNKNOWN" as const });
    const r = await rt.core.runCycle({ trigger: "manual", rogue: await buy(rt) });
    expect(r.outcome).toBe("ORDER_STATE_UNKNOWN");
    expect(rt.core.getState().status).toBe("HALTED");
  });

  it("kill never waits for the entry mutex and is idempotent", async () => {
    const rt = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = rt.fchain.requestApproval.bind(rt.fchain);
    rt.fchain.requestApproval = async (...a) => {
      await gate;
      return orig(...a);
    };
    const cycle = rt.core.runCycle({ trigger: "manual", rogue: await buy(rt) });
    await new Promise((r) => setTimeout(r, 20)); // the cycle now holds the mutex, waiting on the chain
    const k = await rt.core.kill({ source: "cli", reason: "test", pauseOnChain: true });
    expect(k.alreadyHalted).toBe(false);
    expect(Number.isInteger(k.steps.localMs)).toBe(true);
    expect(rt.core.getState().status).toBe("HALTED");
    release();
    const r = await cycle;
    expect(["ENTRY_ABORTED", "REJECTED"]).toContain(r.outcome); // never EXECUTED after a kill
    const kills = rt.deps.ledger.readAll().filter((e) => e.kind === "KILL").length;
    const k2 = await rt.core.kill({ source: "cli", reason: "again" });
    expect(k2.alreadyHalted).toBe(true);
    expect(rt.deps.ledger.readAll().filter((e) => e.kind === "KILL").length).toBe(kills); // nothing new → no entry
  });

  it("owner close works while HALTED; sync awaits the first recordExit", async () => {
    const rt = await setup();
    const r = await rt.core.runCycle({ trigger: "manual", rogue: await buy(rt) });
    await rt.core.kill({ source: "dashboard", reason: "test", pauseOnChain: true });
    const ex = await rt.core.ownerClose(r.chain!.orderHash as Hex32);
    expect(ex.result).toBe("FILLED");
    await rt.core.syncExecutor();
    const kinds = rt.deps.ledger.readAll().map((e) => e.kind);
    expect(kinds.indexOf("EXIT_RECORDED")).toBeGreaterThan(kinds.indexOf("EXIT"));
    expect(await rt.fchain.exitRecordedAt(r.chain!.orderHash as Hex32)).toBeGreaterThan(0);
  });

  it("flatten closes every position in every status", async () => {
    const rt = await setup();
    await rt.core.runCycle({ trigger: "manual", rogue: await buy(rt) });
    const k = await rt.core.kill({ source: "dashboard", reason: "flatten", flatten: true, pauseOnChain: false });
    expect(k.flattened).toBe(true);
    await rt.core.idle();
    expect((await rt.executorApi.health()).positions).toEqual([]);
  });

  it("anchor ranges come from the chain at send time", async () => {
    const rt = await setup();
    await rt.core.anchorNow();
    const first = await rt.fchain.readAnchors();
    expect(first).toHaveLength(1);
    expect(first[0]!.fromSeq).toBe(1);
    rt.core.setOwnerNote("not");
    await rt.core.anchorNow();
    const all = await rt.fchain.readAnchors();
    expect(all[1]!.fromSeq).toBe(first[0]!.toSeq + 1);
    expect((await rt.core.verify()).checks.find((c) => c.id === "V2")?.ok).toBe(true);
  });

  it("SC13: a data dir from another run fails startup and is not overwritten", async () => {
    const rt = await setup();
    const store = agentStateStore(join(rt.dataDir, "state.json"));
    const st = store.load()!;
    store.save({ ...st, chainId: 43113 });
    const again = new Vekil(rt.deps);
    const rep = await again.startup();
    expect(rep.ok).toBe(false);
    expect(rep.checks.find((c) => c.id === "SC13")?.ok).toBe(false);
    expect(store.load()!.chainId).toBe(43113);
    expect(again.getState().status).toBe("STARTUP_FAILED");
  });

  it("SC6: live needs I_CONFIRM_NO_WITHDRAW=yes; paper/fake skip it", async () => {
    const rt = await setup();
    expect((await rt.core.startup()).checks.find((c) => c.id === "SC6")).toBeUndefined();
    const live = (yes: boolean) => runStartupChecks({ ...rt.deps, cfg: { ...rt.deps.cfg, mode: "live", iConfirmNoWithdraw: yes } }, { state: null, loadError: null });
    const no = (await live(false)).report.checks.find((c) => c.id === "SC6");
    expect(no).toMatchObject({ ok: false, level: "fail" });
    expect((await live(false)).report.ok).toBe(false);
    expect((await live(true)).report.checks.find((c) => c.id === "SC6")?.ok).toBe(true);
  });

  it("HALTED → scheduler-style cycles are SKIPPED without an LLM call", async () => {
    const rt = await setup();
    await rt.core.kill({ source: "cli", reason: "x" });
    const r = await rt.core.runCycle({ trigger: "schedule" });
    expect(r.outcome).toBe("SKIPPED");
  });
});
