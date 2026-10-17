// pnpm probe:agent — one real agent cycle on real ATK data (core read instance, allowlist "llm"), printing the tool
// trace, the reasoning fields and the zod result. It never touches the chain or the executor: the "on-chain" view is
// the default policy built locally and labelled as such. LLM_PROVIDER=scripted + EXECUTION_MODE=fake runs offline.
import { readFileSync } from "node:fs";
import { AtkClient, stdioSpawner } from "../src/atk/client.js";
import { readAllowlist } from "../src/atk/manifest.js";
import { makeAgentPort } from "../src/agent/agent.js";
import { makeMarketContextFn } from "../src/agent/context.js";
import { makeIndicatorsFn } from "../src/agent/indicators.js";
import { AnthropicLlm } from "../src/agent/llm/anthropic.js";
import { ScriptedLlm } from "../src/agent/llm/scripted.js";
import { AtkMarket } from "../src/market/atk-market.js";
import { FakeMarket } from "../src/market/fake-market.js";
import { loadConfig } from "../src/shared/config.js";
import { InMemoryEventBus } from "../src/shared/events.js";
import { keccakUtf8, ZERO_HASH } from "../src/shared/hash.js";
import type { AtkReader, ChainView, LlmClient, MarketData } from "../src/shared/interfaces.js";
import { AgentDecisionSchema, defaultPolicy, type AgentState } from "../src/shared/schemas.js";
import { SystemClock, dayKey } from "../src/shared/time.js";

async function main(): Promise<void> {
  const cfg = loadConfig({ env: { CHAIN: "fake", ...process.env } });
  const clock = new SystemClock();
  const bus = new InMemoryEventBus();
  bus.subscribe((e) => {
    if (e.type === "tool_call") {
      const d = e.data as { name: string; argsJson: string; ok: boolean; ms: number; preview: string };
      console.log(`tool ${d.ok ? "✓" : "✗"} ${d.name}(${d.argsJson}) ${d.ms} ms → ${d.preview.slice(0, 160).replace(/\s+/g, " ")}`);
    }
  });
  const allow = readAllowlist("config/atk-allowlist.json");
  let market: MarketData;
  let atk: AtkReader;
  let llm: LlmClient;
  let close = async (): Promise<void> => undefined;
  const policy = defaultPolicy(clock.now());
  if (cfg.mode === "fake") {
    market = new FakeMarket(clock);
    atk = { listTools: async () => [], callTool: async () => "{}" };
    console.log("(offline: fake market, no ATK tools)");
  } else {
    const read = await AtkClient.start(
      { profile: cfg.atk.readProfile, modules: cfg.atk.readModules, readOnly: true, allow: [...new Set([...allow.core, ...allow.llm])] },
      { spawner: stdioSpawner, mode: cfg.mode },
    );
    close = () => read.close();
    market = new AtkMarket(read, clock);
    atk = read;
  }
  const indicators = makeIndicatorsFn({ market, policy: async () => policy, profile: cfg.strategyProfile, clock });
  if (cfg.llmProvider === "scripted") {
    const script = JSON.parse(readFileSync("fixtures/smoke-script.json", "utf8")) as { turns: unknown[] };
    // The HOLD cycle of the smoke script (turns 2–3).
    llm = ScriptedLlm.fromFile({ turns: script.turns.slice(1, 3) }, { clock, indicators, defaultInstId: cfg.instId });
  } else {
    llm = new AnthropicLlm({ model: cfg.llm.model, apiKey: cfg.llm.apiKey ?? undefined, clock });
  }
  const view: ChainView = {
    paused: false, policyVersion: 0, policy, policyHash: ZERO_HASH, sourceTextHash: keccakUtf8(""), agent: `0x${"0".repeat(40)}`,
    owner: `0x${"0".repeat(40)}`, agentId: 0, checkedAt: clock.now(), blockTimestamp: Math.floor(clock.now() / 1000),
  };
  const state: AgentState = {
    mode: cfg.mode, chainId: 0, policy: null, status: "RUNNING", haltReason: null, haltedAt: null, lastExecutorEventN: 0, lastLossExitAt: null,
    realizedPnlTodayQuote: "0", dayKey: dayKey(clock.now()), lastDecisions: [], lastLesson: null, pendingOwnerNote: null, nextCheckInAt: 0,
  };
  const agent = makeAgentPort({
    llm, model: cfg.llmProvider === "scripted" ? "scripted" : cfg.llm.model, atk, allowlist: allow.llm, clock, bus, instId: cfg.instId,
    mode: cfg.mode, maxToolCalls: cfg.llm.maxToolCalls, cooldownAfterLossMin: cfg.preflight.cooldownAfterLossMin,
    indicators, marketContext: makeMarketContextFn({ market, clock }), positions: async () => [],
  });
  console.log(`probe:agent: ${cfg.instId}, model ${agent.model}, default policy (local, NOT read from the chain), no executor`);
  try {
    const r = await agent.decide({
      profile: "normal", injection: null, view, counters: { hourIndex: 0, dayIndex: 0, tradesInHour: 0, tradesInDay: 0, riskUsedToday: "0" },
      state, ownerNote: null, signal: AbortSignal.timeout(cfg.llm.cycleTimeoutSec * 1000),
    });
    console.log(`model: ${r.model}; tool calls: ${r.toolTrace.length}; error: ${r.error ?? "none"}`);
    const z = AgentDecisionSchema.safeParse(r.rawDecision);
    if (!z.success) {
      console.log(`zod: INVALID (${z.error.issues.map((i) => i.path.join(".")).join(", ")}) raw=${JSON.stringify(r.rawDecision)}`);
      process.exitCode = 1;
      return;
    }
    const d = z.data;
    console.log(`zod: OK → ${d.action} ${d.instId}`);
    console.log(`Rejim: ${d.regime} · Oyun planı: ${d.playbook} · Güven: ${d.confidence} · Sonraki kontrol: ${d.nextCheckInMin} dk`);
    for (const e of d.evidence) console.log(`  Kanıt: ${e}`);
    console.log(`  Yükseliş: ${d.scenarios.bull}\n  Düşüş: ${d.scenarios.bear}\n  Gerekçe: ${d.thesis}\n  Bu fikri bozan durum: ${d.invalidation}`);
    if (d.action === "BUY") console.log(`  BUY ${d.quoteAmount} TL limit=${d.limitPx ?? "-"} stop=${d.stopPx ?? "-"} tp=${d.tpPx ?? "-"} time=${d.timeStopMin ?? "-"}`);
  } finally {
    await close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
