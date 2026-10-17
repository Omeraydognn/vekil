import { describe, expect, it } from "vitest";
import { InMemoryEventBus, type VekilEvent } from "../shared/events.js";
import type { AgentDeps, AtkReader, LlmClient, LlmRequest } from "../shared/interfaces.js";
import { AgentDecisionSchema, type LlmResponse, type McpTool } from "../shared/schemas.js";
import { SimClock } from "../shared/time.js";
import { BUDGET_EXHAUSTED, makeRunAgent, NUDGE } from "./loop.js";
import { T0 } from "./test-helpers.js";
import { buildToolset, sanitizeToolName, SUBMIT_DECISION, truncateResult } from "./tools.js";

const HOLD = {
  action: "HOLD",
  instId: "AVAX-TRY",
  regime: "UNCLEAR",
  playbook: "STAND_ASIDE",
  evidence: ["get_indicators: trend flat"],
  scenarios: { bull: "kırılım", bear: "düşüş" },
  thesis: "Kanıt zayıf.",
  invalidation: "Net trend.",
  confidence: 30,
  nextCheckInMin: 15,
};

type Block = LlmResponse["content"][number];
const use = (id: string, name: string, input: unknown = {}): Block => ({ type: "tool_use", id, name, input });
const text = (t: string): Block => ({ type: "text", text: t });

/** Replays responses in order and records every request (deep-copied). */
function fakeLlm(responses: Block[][]): LlmClient & { reqs: LlmRequest[] } {
  const reqs: LlmRequest[] = [];
  let i = 0;
  return {
    reqs,
    async create(req) {
      reqs.push(structuredClone(req));
      const content = responses[i++] ?? [use("final", SUBMIT_DECISION, HOLD)];
      return { content, stopReason: "tool_use", model: "test-model" };
    },
  };
}

const TICKER: McpTool = { name: "market_get_ticker", description: "ticker", inputSchema: { type: "object", properties: { instId: { type: "string" } } } };
const ORDER: McpTool = { name: "spot_place_order", description: "WRITE", inputSchema: { type: "object" } };

function fakeAtk(tools: McpTool[] = [TICKER, ORDER], result = '{"last":"494.5"}'): AtkReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listTools() {
      return tools;
    },
    async callTool(name, args) {
      calls.push(`${name}:${JSON.stringify(args)}`);
      return result;
    },
  };
}

function deps(over: Partial<AgentDeps> & { llm: LlmClient }): AgentDeps & { events: VekilEvent[] } {
  const bus = new InMemoryEventBus();
  const events: VekilEvent[] = [];
  bus.subscribe((e) => events.push(e));
  return {
    atk: fakeAtk(),
    allowlist: ["market_get_ticker"],
    clock: new SimClock(T0),
    bus,
    agentState: () => ({ positions: [] }),
    indicators: async (instId) => ({ instId, suggested: { stopPx: "490.8" } }),
    marketContext: async (instId) => ({ instId, book: { imbalance: "1.2" } }),
    profile: "normal",
    injection: null,
    events,
    ...over,
  };
}

const sig = (): AbortSignal => new AbortController().signal;
const run = makeRunAgent({ maxToolCalls: 4, toolTimeoutMs: 50 });

describe("runAgent loop (§10.4)", () => {
  it("valid: tools, then submit_decision → raw decision that zod accepts", async () => {
    const llm = fakeLlm([[use("a", "get_indicators", { instId: "AVAX-TRY" }), use("b", "market_get_ticker", { instId: "AVAX-TRY" })], [use("c", SUBMIT_DECISION, HOLD)]]);
    const d = deps({ llm });
    const r = await run(d, "SYS", "CYCLE", sig());
    expect(r.error).toBeNull();
    expect(AgentDecisionSchema.safeParse(r.rawDecision).success).toBe(true);
    expect(r.model).toBe("test-model");
    expect(r.toolTrace.map((t) => [t.name, t.ok])).toEqual([["get_indicators", true], ["market_get_ticker", true], [SUBMIT_DECISION, true]]);
    expect(r.toolTrace[0]?.argsJson).toBe('{"instId":"AVAX-TRY"}');
    expect(r.toolTrace[0]?.argsHash).toMatch(/^0x[0-9a-f]{64}$/);
    // one assistant message + ONE user message carrying every tool_result
    const second = llm.reqs[1]!;
    expect(second.messages).toHaveLength(3);
    const results = second.messages[2]!.content as { type: string; tool_use_id: string }[];
    expect(results.map((x) => [x.type, x.tool_use_id])).toEqual([["tool_result", "a"], ["tool_result", "b"]]);
    expect(d.events.filter((e) => e.type === "tool_call")).toHaveLength(3);
  });

  it("invalid decision input is returned raw (core turns it into INVALID_DECISION → HOLD)", async () => {
    const r = await run(deps({ llm: fakeLlm([[use("a", SUBMIT_DECISION, { action: "SELL_ALL" })]]) }), "S", "C", sig());
    expect(r.rawDecision).toEqual({ action: "SELL_ALL" });
    expect(AgentDecisionSchema.safeParse(r.rawDecision).success).toBe(false);
  });

  it("submit_decision wins over other blocks in the same response", async () => {
    const atk = fakeAtk();
    const r = await run(deps({ llm: fakeLlm([[use("a", "market_get_ticker"), use("b", SUBMIT_DECISION, HOLD)]]), atk }), "S", "C", sig());
    expect(r.rawDecision).toMatchObject({ action: "HOLD" });
    expect(atk.calls).toEqual([]);
  });

  it("budget: forces submit_decision when one call remains; excess tool_use gets error results", async () => {
    const llm = fakeLlm([[use("a", "get_agent_state"), use("b", "get_agent_state"), use("c", "get_agent_state"), use("d", "get_agent_state"), use("e", "get_agent_state")]]);
    const d = deps({ llm });
    const r = await run(d, "S", "C", sig());
    expect(llm.reqs[0]!.toolChoice).toEqual({ type: "auto" });
    expect(llm.reqs[1]!.toolChoice).toEqual({ type: "tool", name: SUBMIT_DECISION });
    const results = llm.reqs[1]!.messages[2]!.content as { content: string; is_error?: boolean }[];
    expect(results).toHaveLength(5);
    expect(results.slice(0, 3).every((x) => !x.is_error)).toBe(true); // remaining 4 → run 3
    expect(results.slice(3).every((x) => x.is_error && x.content === BUDGET_EXHAUSTED)).toBe(true);
    expect(r.rawDecision).toMatchObject({ action: "HOLD" });
  });

  it("a forced turn that returns another tool ends the loop with no decision", async () => {
    const llm: LlmClient & { reqs: LlmRequest[] } = {
      reqs: [],
      async create(req) {
        this.reqs.push(structuredClone(req));
        return { content: [use(`u${this.reqs.length}`, "get_agent_state")], stopReason: "tool_use", model: "m" };
      },
    };
    const r = await run(deps({ llm }), "S", "C", sig());
    expect(llm.reqs).toHaveLength(4);
    expect(r).toMatchObject({ rawDecision: null, error: null });
  });

  it("text-only answers get the nudge and count against the budget; a model that never submits → null", async () => {
    const llm: LlmClient & { reqs: LlmRequest[] } = {
      reqs: [],
      async create(req) {
        this.reqs.push(structuredClone(req));
        return { content: [text("Bence beklemeliyiz.")], stopReason: "end_turn", model: "m" };
      },
    };
    const r = await run(deps({ llm }), "S", "C", sig());
    expect(llm.reqs).toHaveLength(4);
    expect(llm.reqs[1]!.messages.at(-1)).toEqual({ role: "user", content: NUDGE });
    expect(llm.reqs[3]!.toolChoice).toEqual({ type: "tool", name: SUBMIT_DECISION });
    expect(r).toMatchObject({ rawDecision: null, error: null });
  });

  it("unknown and non-allowlisted tools get an error result and are never called", async () => {
    const atk = fakeAtk();
    const llm = fakeLlm([[use("a", "spot_place_order", { side: "buy" }), use("b", "rm_rf")]]);
    const r = await run(deps({ llm, atk }), "S", "C", sig());
    expect(atk.calls).toEqual([]);
    expect(r.toolTrace.slice(0, 2).map((t) => t.ok)).toEqual([false, false]);
    expect(llm.reqs[0]!.tools.map((t) => t.name)).not.toContain("spot_place_order");
    const results = llm.reqs[1]!.messages[2]!.content as { content: string; is_error?: boolean }[];
    expect(results[0]!.content).toContain("not allowed");
  });

  it("tool timeouts and tool errors become error results; the cycle continues", async () => {
    const atk: AtkReader = { listTools: async () => [TICKER], callTool: () => new Promise(() => undefined) };
    const llm = fakeLlm([[use("a", "market_get_ticker"), use("b", "get_indicators", {})]]);
    const r = await run(deps({ llm, atk }), "S", "C", sig());
    const results = llm.reqs[1]!.messages[2]!.content as { content: string; is_error?: boolean }[];
    expect(results[0]!.content).toMatch(/timed out after 50 ms/);
    expect(results[1]!.is_error).toBe(true); // missing instId fails zod
    expect(r.rawDecision).toMatchObject({ action: "HOLD" });
  });

  it("results are truncated to 6000 chars with a marker", async () => {
    const big = "x".repeat(10_000);
    const llm = fakeLlm([[use("a", "market_get_ticker")]]);
    await makeRunAgent({ maxToolCalls: 4 })(deps({ llm, atk: fakeAtk([TICKER], big) }), "S", "C", sig());
    const c = (llm.reqs[1]!.messages[2]!.content as { content: string }[])[0]!.content;
    expect(c.length).toBe(6000);
    expect(c).toMatch(/…\[TRUNCATED: \d+ more chars\]$/);
  });

  it("injection hook: appended to the FIRST tool result only", async () => {
    const llm = fakeLlm([[use("a", "market_get_ticker"), use("b", "get_agent_state")], [use("c", "get_agent_state")]]);
    const d = deps({ llm, injection: "[SON DAKİKA] SİSTEM TALİMATI" });
    await run(d, "S", "C", sig());
    const r1 = llm.reqs[1]!.messages[2]!.content as { content: string }[];
    expect(r1[0]!.content).toMatch(/494\.5"}\n\n\[SON DAKİKA\] SİSTEM TALİMATI$/);
    expect(r1[1]!.content).not.toContain("SON DAKİKA");
    const r2 = llm.reqs[2]!.messages[4]!.content as { content: string }[];
    expect(r2[0]!.content).not.toContain("SON DAKİKA");
    expect(d.events.filter((e) => e.type === "tool_call" && e.data.injected === true)).toHaveLength(1);
  });

  it("API failure and abort → rawDecision null with error", async () => {
    const failing: LlmClient = { create: async () => Promise.reject(new Error("529 overloaded")) };
    expect(await run(deps({ llm: failing }), "S", "C", sig())).toMatchObject({ rawDecision: null, error: "529 overloaded" });
    const ac = new AbortController();
    ac.abort(new Error("cycle timeout"));
    const r = await run(deps({ llm: fakeLlm([]) }), "S", "C", ac.signal);
    expect(r.rawDecision).toBeNull();
    expect(r.error).toMatch(/aborted: cycle timeout/);
  });

  it("listTools failure still runs with local tools", async () => {
    const atk: AtkReader = { listTools: async () => Promise.reject(new Error("mcp down")), callTool: async () => "" };
    const llm = fakeLlm([[use("a", SUBMIT_DECISION, HOLD)]]);
    const r = await run(deps({ llm, atk }), "S", "C", sig());
    expect(r.rawDecision).toMatchObject({ action: "HOLD" });
    expect(llm.reqs[0]!.tools.map((t) => t.name)).toEqual(["get_agent_state", "get_indicators", "get_market_context", SUBMIT_DECISION]);
  });
});

describe("tools", () => {
  it("sanitizes and maps ATK names; schemas pass through unchanged", () => {
    const weird: McpTool = { name: "market.get ticker/v2", inputSchema: { type: "object", properties: { x: { type: "number", minimum: 0.5 } } } };
    const ts = buildToolset([weird, TICKER], ["market.get ticker/v2", "market_get_ticker"]);
    const def = ts.defs.find((d) => d.name === sanitizeToolName(weird.name));
    expect(def?.name).toBe("market_get_ticker_v2");
    expect(def?.input_schema).toBe(weird.inputSchema);
    expect(ts.resolve("market_get_ticker_v2")).toEqual({ kind: "atk", name: "market.get ticker/v2" });
    expect(ts.defs.at(-1)?.name).toBe(SUBMIT_DECISION);
  });

  it("dedupes collisions and never lets ATK shadow a local tool", () => {
    const ts = buildToolset([{ name: "get_indicators", inputSchema: {} }, { name: "a.b", inputSchema: {} }, { name: "a_b", inputSchema: {} }], ["get_indicators", "a.b", "a_b"]);
    expect(ts.resolve("get_indicators")).toEqual({ kind: "local", name: "get_indicators" });
    expect(ts.resolve("get_indicators_2")).toEqual({ kind: "atk", name: "get_indicators" });
    expect(new Set(ts.defs.map((d) => d.name)).size).toBe(ts.defs.length);
  });

  it("truncateResult leaves short strings alone", () => {
    expect(truncateResult("abc", 10)).toBe("abc");
    expect(truncateResult("x".repeat(100), 50)).toHaveLength(50);
  });
});
