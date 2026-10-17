// pnpm smoke (SPEC §23.3): end to end on its own anvil with the REAL contract, the fake market, the scripted LLM, an
// in-process executor and a temp DATA_DIR. Ignores .env. No timers: core/executor methods are called directly. < 60 s.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreScheduler } from "../src/core/scheduler.js";
import { buildRuntime, type Runtime } from "../src/core/wiring.js";
import { loadConfig } from "../src/shared/config.js";
import { D, toDecString } from "../src/shared/money.js";
import { entryClOrdId, hashPrefix30 } from "../src/shared/order-hash.js";
import { sourceTextHash } from "../src/shared/policy-encode.js";
import type { CycleResult, Hex32, LedgerEntry } from "../src/shared/schemas.js";
import { msToSec } from "../src/shared/time.js";

const POLICY_TEXT =
  "Sadece AVAX işlem yap. İşlem başına en fazla 200 TL. Günlük risk en fazla 100 TL. Saatte en fazla 5, günde en fazla 10 işlem. Her işlemde zarar-kes olsun, en fazla %3.";

const rows: { step: string; ok: boolean; detail: string }[] = [];
class StepFailed extends Error {}

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    rows.push({ step: name, ok: true, detail: `${detail} (${Date.now() - t0} ms)` });
  } catch (e) {
    rows.push({ step: name, ok: false, detail: e instanceof Error ? e.message : String(e) });
    throw new StepFailed(name);
  }
}

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
const codes = (r: CycleResult): string[] => r.reasons.map((x) => x.code);
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

async function main(): Promise<void> {
  const started = Date.now();
  const dataDir = mkdtempSync(join(tmpdir(), "vekil-smoke-"));
  // Forced settings; .env is ignored.
  const cfg = loadConfig({
    dotenv: false,
    env: { EXECUTION_MODE: "fake", LLM_PROVIDER: "scripted", CHAIN: "local", DATA_DIR: dataDir, PATH: process.env.PATH ?? "" },
  });
  let rt: Runtime | null = null;
  try {
    rt = await buildRuntime(cfg, { executorLoops: false, wipeEphemeral: false });
    const { core, chain, inProcess, fakeMarket } = rt;
    if (!inProcess || !fakeMarket) throw new Error("smoke needs fake mode");
    const ledger = rt.deps.ledger;
    const cycleEntries = (r: CycleResult): LedgerEntry[] => ledger.readAll().filter((e) => e.cycleId === r.cycleId);
    const noChainTx = (r: CycleResult): boolean => !cycleEntries(r).some((e) => e.kind === "CHAIN_REQUEST");
    let entryHash = "" as Hex32;
    let entryReqSeq = 0;
    let exitClOrdId = "";

    await step("1 startup()", async () => {
      const rep = await core.startup();
      expect(rep.ok, `startup failed: ${rep.checks.filter((c) => !c.ok).map((c) => `${c.id} ${c.details}`).join("; ")}`);
      return `${rep.checks.length} checks ok`;
    });

    await step("2 proposePolicy → applyPolicy", async () => {
      const p = await core.proposePolicy(POLICY_TEXT);
      expect(p.errors.length === 0, `errors: ${p.errors.join("; ")}`);
      const a = await core.applyPolicy(p.id);
      const v = await chain.readView();
      expect(a.version === 2 && v.policyVersion === 2, `policyVersion ${v.policyVersion}`);
      const q = p.policy;
      const fields = ["maxOrderQuote", "dailyRiskBudgetQuote", "maxTradesPerHour", "maxTradesPerDay", "minStopDistancePct", "maxStopDistancePct", "maxHoldMin", "feeBps", "slippageBps"] as const;
      for (const f of fields) expect(String(v.policy[f]) === String(q[f]) || D(String(v.policy[f])).eq(D(String(q[f]))), `${f}: ${v.policy[f]} ≠ ${q[f]}`);
      expect(same(v.policy.instIds, q.instIds), "instIds");
      expect(msToSec(v.policy.validUntil) === msToSec(q.validUntil), "validUntil (s)");
      expect(v.sourceTextHash === sourceTextHash(POLICY_TEXT), "sourceTextHash");
      expect(ledger.readAll().some((e) => e.kind === "POLICY" && (e.payload as { version: number }).version === 2), "POLICY entry");
      return `v${v.policyVersion}, tx ${a.txHash.slice(0, 10)}…`;
    });

    await step("3 cycle: HOLD", async () => {
      const r = await core.runCycle({ trigger: "manual" });
      expect(r.outcome === "HOLD", `outcome ${r.outcome}`);
      expect(noChainTx(r), "chain tx");
      return `HOLD, ${r.toolTrace.length} tool calls`;
    });

    await step("4 cycle: BUY 200 TL → EXECUTED", async () => {
      const r = await core.runCycle({ trigger: "manual" });
      expect(r.outcome === "EXECUTED", `outcome ${r.outcome} ${codes(r).join(",")} ${r.note ?? ""}`);
      const h = r.chain!.orderHash as Hex32;
      entryHash = h;
      const a = await chain.approval(h);
      expect(a.status === 1, "approval.status");
      expect(r.clOrdId === entryClOrdId(h), "clOrdId");
      expect((await chain.orderHashByPrefix(hashPrefix30(h))) === h, "orderHashByPrefix");
      const req = cycleEntries(r).find((e) => e.kind === "CHAIN_REQUEST")!;
      entryReqSeq = req.seq;
      const order = (req.payload as { order: { stopPx: string } }).order;
      const pos = (await rt!.executorApi.health()).positions.find((p) => p.entryOrderHash === h);
      expect(!!pos && pos.stopPx === order.stopPx, `position stop ${pos?.stopPx} ≠ ${order.stopPx}`);
      return `${r.clOrdId}, stop ${pos!.stopPx}`;
    });

    await step("5 cycle: BUY again → LOCAL_BLOCK", async () => {
      const r = await core.runCycle({ trigger: "manual" });
      expect(r.outcome === "LOCAL_BLOCK" && same(codes(r), ["POSITION_ALREADY_OPEN"]), `${r.outcome} ${codes(r).join(",")}`);
      expect(noChainTx(r), "chain tx");
      return "[POSITION_ALREADY_OPEN]";
    });

    await step("6 ADJUST_STOP −0.5 % then +0.5 %", async () => {
      const a = await core.runCycle({ trigger: "manual" });
      expect(a.outcome === "LOCAL_BLOCK" && same(codes(a), ["STOP_LOOSENED"]), `a: ${a.outcome} ${codes(a).join(",")}`);
      const b = await core.runCycle({ trigger: "manual" });
      expect(b.outcome === "ADJUSTED", `b: ${b.outcome} ${codes(b).join(",")}`);
      return "[STOP_LOOSENED], ADJUSTED";
    });

    await step("7 price below stop → STOP_HIT, exit on-chain", async () => {
      const pos = (await rt!.executorApi.health()).positions.find((p) => p.entryOrderHash === entryHash)!;
      fakeMarket.forcePrice("AVAX-TRY", toDecString(D(pos.stopPx).mul("0.995").toDecimalPlaces(1)));
      await inProcess.executor.monitorTick();
      await core.syncExecutor();
      const exit = ledger.readAll().find((e) => e.kind === "EXIT");
      expect(!!exit && (exit.payload as { reason: string }).reason === "STOP_HIT", "EXIT STOP_HIT");
      exitClOrdId = (exit!.payload as { exitClOrdId: string }).exitClOrdId;
      expect((await chain.exitRecordedAt(entryHash)) > 0, "exitRecordedAt");
      expect((await chain.entryByExitPrefix(exitClOrdId.slice(1))) === entryHash, "entryByExitPrefix");
      return `${exitClOrdId}, PnL ${(exit!.payload as { pnlQuote: string }).pnlQuote}`;
    });

    await step("8 cycle: valid BUY → [COOLDOWN_ACTIVE]", async () => {
      const r = await core.runCycle({ trigger: "manual" });
      expect(r.outcome === "LOCAL_BLOCK" && same(codes(r), ["COOLDOWN_ACTIVE"]), `${r.outcome} ${codes(r).join(",")}`);
      expect(noChainTx(r), "chain tx");
      return "[COOLDOWN_ACTIVE]";
    });

    await step("9 runRogue(R3) → [ORDER_TOO_LARGE]", async () => {
      const r = await core.runRogue("R3");
      expect(r.outcome === "TEST_CYCLE", `outcome ${r.outcome}`);
      expect(r.chain?.status === "REJECTED" && same(r.chain.reasons, ["ORDER_TOO_LARGE"]) && !r.chain.critical, `chain ${JSON.stringify(r.chain)}`);
      expect((await chain.readView()).paused === false, "paused");
      return "REJECTED, not critical, not paused";
    });

    await step("10 runInjectionTest() → critical reject + brake", async () => {
      const r = await core.runInjectionTest();
      expect(r.naive.outcome === "TEST_CYCLE", `naive ${r.naive.outcome}`);
      const c = r.naive.chain;
      expect(!!c && c.status === "REJECTED" && same(c.reasons, ["INSTRUMENT_NOT_ALLOWED", "ORDER_TOO_LARGE", "STOP_MISSING"]) && c.critical, `chain ${JSON.stringify(c)}`);
      expect(r.fallback === null, "fallback");
      expect((await chain.readView()).paused, "paused");
      const st = core.getState();
      expect(st.status === "HALTED", `status ${st.status}`);
      const kill = ledger.readAll().filter((e) => e.kind === "KILL").at(-1);
      expect((kill?.payload as { source?: string } | undefined)?.source === "chain", "kill source chain");
      return `[${c!.reasons.join(", ")}], Kontrat freni çekti, HALTED`;
    });

    await step("10b injected resting order → pause watcher cancels", async () => {
      const injected = `v${"5".repeat(30)}`;
      inProcess.exchange.injectRestingOrder(injected);
      await inProcess.executor.pauseWatchTick();
      const st = inProcess.executor.state;
      const cancel = st.events.filter((e) => e.type === "CANCEL").at(-1);
      expect(!!cancel && (cancel.data as { by: string; clOrdIds: string[] }).by === "pause-watch" && (cancel.data as { clOrdIds: string[] }).clOrdIds.includes(injected), "CANCEL by pause-watch");
      expect(st.events.some((e) => e.type === "PAUSE_SEEN"), "PAUSE_SEEN");
      expect(st.halted, "executor halted");
      return `${injected} cancelled`;
    });

    await step("11 scheduler.tick() → SKIPPED", async () => {
      const r = await new CoreScheduler(core, rt!.clock).tick();
      expect(r?.outcome === "SKIPPED", `outcome ${r?.outcome}`);
      return "SKIPPED";
    });

    await step("12 anchor + verify + proof + tamper", async () => {
      await core.syncExecutor();
      await core.anchorNow();
      const v = await core.verify();
      expect(v.ok && v.checks.length === 6, `verify: ${v.checks.filter((c) => !c.ok).map((c) => `${c.id} ${c.details}`).join("; ")} ${v.failures.map((f) => f.message).join("; ")}`);
      const p = await core.verify({ proveSeq: entryReqSeq });
      expect(p.proof?.onChainVerified === true, "proof not verified on-chain");
      const t = await core.verify({ tamperSeq: entryReqSeq });
      expect(!t.ok && t.failures[0]?.seq === entryReqSeq, `tamper first failure ${t.failures[0]?.seq}`);
      return `V1–V6 ✓, proof #${entryReqSeq} on-chain ✓, tamper caught at #${t.failures[0]?.seq}`;
    });

    await step("13 audit() (fake source)", async () => {
      const a = await core.audit();
      const by = (id: string) => a.items.find((i) => i.clOrdId === id)?.status;
      expect(by(entryClOrdId(entryHash)) === "OK", "entry not OK");
      expect(by(exitClOrdId) === "OK", "exit not OK");
      expect(by(`v${"5".repeat(30)}`) === "VIOLATION", "injected order not flagged");
      return `${a.checkedOrders} orders: entry OK, exit OK, injected VIOLATION`;
    });
  } catch (e) {
    if (!(e instanceof StepFailed)) rows.push({ step: "setup", ok: false, detail: e instanceof Error ? e.message : String(e) });
  } finally {
    await rt?.stop().catch(() => undefined);
    rows.push({ step: "14 stop anvil", ok: true, detail: "" });
    rmSync(dataDir, { recursive: true, force: true });
  }
  const width = Math.max(...rows.map((r) => r.step.length));
  for (const r of rows) console.log(`${r.ok ? "✓" : "✗"} ${r.step.padEnd(width)}  ${r.detail}`);
  const ok = rows.every((r) => r.ok) && rows.length >= 15;
  console.log(`${ok ? "SMOKE OK" : "SMOKE FAILED"} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  process.exit(ok ? 0 : 1);
}

void main();
