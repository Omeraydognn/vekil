import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LlmRequest } from "../../shared/interfaces.js";
import { D } from "../../shared/money.js";
import { AgentDecisionSchema, type ToolDef } from "../../shared/schemas.js";
import { SimClock } from "../../shared/time.js";
import { T0 } from "../test-helpers.js";
import { SUBMIT_DECISION, SUBMIT_DECISION_DEF } from "../tools.js";
import { ScriptedLlm, ScriptError, type ScriptTurn } from "./scripted.js";

const IND = { instId: "AVAX-TRY", ask: "494.7", tickSz: "0.1", suggested: { entryPx: "495.2", stopPx: "490.8", tpPx: "504" } };
const resolver = { clock: new SimClock(T0 + 123), indicators: async () => IND, currentStopPx: () => "490.8", r1Pair: "DOGE-TRY" };
const req = (tools: ToolDef[] = [SUBMIT_DECISION_DEF]): LlmRequest => ({ system: "S", tools, messages: [], toolChoice: { type: "auto" }, maxTokens: 2000 });
const sig = new AbortController().signal;
const turn = (name: string, input: unknown): ScriptTurn => ({ content: [{ type: "tool_use", name, input }] });
const inputOf = async (llm: ScriptedLlm, r = req()): Promise<Record<string, unknown>> => {
  const resp = await llm.create(r, sig);
  const b = resp.content[0];
  if (b?.type !== "tool_use") throw new Error("expected tool_use");
  return b.input as Record<string, unknown>;
};

describe("ScriptedLlm relative values (§10.5)", () => {
  it("pctOfAsk: stops round down, TPs and limits round up", async () => {
    const llm = new ScriptedLlm([turn(SUBMIT_DECISION, { instId: "AVAX-TRY", stopPx: { pctOfAsk: "-1.2" }, tpPx: { pctOfAsk: "2.4" }, limitPx: { pctOfAsk: "0.1" } })], resolver);
    // 494.7 × 0.988 = 488.7636 → 488.7; × 1.024 = 506.5728 → 506.6; × 1.001 = 495.1947 → 495.2
    expect(await inputOf(llm)).toMatchObject({ stopPx: "488.7", tpPx: "506.6", limitPx: "495.2" });
  });

  it("pctOfStop uses the current stop; newStopPx rounds down, newTpPx up", async () => {
    const llm = new ScriptedLlm([turn(SUBMIT_DECISION, { instId: "AVAX-TRY", newStopPx: { pctOfStop: "-0.5" } }), turn(SUBMIT_DECISION, { instId: "AVAX-TRY", newStopPx: { pctOfStop: "0.5" }, newTpPx: { pctOfStop: "3" } })], resolver);
    expect((await inputOf(llm)).newStopPx).toBe("488.3"); // 490.8 × 0.995 = 488.346
    expect(await inputOf(llm)).toMatchObject({ newStopPx: "493.2", newTpPx: "505.6" }); // 493.254 ↓, 505.524 ↑
  });

  it("validUntilInHours is a whole second from clock.now(); ISO for *Iso keys", async () => {
    const llm = new ScriptedLlm([turn("propose_policy", { validUntilIso: { validUntilInHours: 24 }, validUntil: { validUntilInHours: 1 } })], resolver);
    const r = await inputOf(llm, req([]));
    expect(r.validUntilIso).toBe("2026-10-18T11:05:00+03:00");
    expect(r.validUntil).toBe(T0 + 3_600_000);
  });

  it("suggested levels and r1Pair", async () => {
    const llm = new ScriptedLlm([turn(SUBMIT_DECISION, { instId: { r1Pair: true }, stopPx: { suggested: "stopPx" } })], resolver);
    expect(await inputOf(llm)).toEqual({ instId: "DOGE-TRY", stopPx: "490.8" });
  });

  it("errors are explicit: no stop for pctOfStop, unknown suggested level, missing r1Pair", async () => {
    const noStop = new ScriptedLlm([turn(SUBMIT_DECISION, { newStopPx: { pctOfStop: "1" } })], { ...resolver, currentStopPx: () => null });
    await expect(noStop.create(req(), sig)).rejects.toThrow(ScriptError);
    const badLevel = new ScriptedLlm([turn(SUBMIT_DECISION, { stopPx: { suggested: "nope" } })], resolver);
    await expect(badLevel.create(req(), sig)).rejects.toThrow(/no suggested level/);
    const noPair = new ScriptedLlm([turn(SUBMIT_DECISION, { instId: { r1Pair: true } })], { clock: resolver.clock });
    await expect(noPair.create(req(), sig)).rejects.toThrow(/r1Pair/);
  });

  it("plain objects with other keys pass through; ids are generated", async () => {
    const llm = new ScriptedLlm([turn(SUBMIT_DECISION, { scenarios: { bull: "a", bear: "b" } })], resolver);
    const resp = await llm.create(req(), sig);
    expect(resp.content[0]).toMatchObject({ type: "tool_use", id: "toolu_scripted_1", input: { scenarios: { bull: "a", bear: "b" } } });
    expect(resp.model).toBe("scripted");
  });

  it("an exhausted script answers HOLD (valid) when submit_decision is offered, else empty text", async () => {
    const llm = new ScriptedLlm([], resolver);
    const r = await inputOf(llm);
    expect(AgentDecisionSchema.safeParse(r).success).toBe(true);
    expect(r.action).toBe("HOLD");
    expect((await llm.create(req([]), sig)).content).toEqual([{ type: "text", text: "" }]);
  });
});

describe("fixtures/smoke-script.json", () => {
  const file = JSON.parse(readFileSync(new URL("../../../fixtures/smoke-script.json", import.meta.url), "utf8")) as unknown;

  it("parses, and every decision resolves to a schema-valid AgentDecision", async () => {
    const llm = ScriptedLlm.fromFile(file, resolver);
    const total = llm.remaining();
    expect(total).toBe(10);
    const decisions: Record<string, unknown>[] = [];
    for (let i = 0; i < total; i++) {
      const resp = await llm.create(req(), sig);
      for (const b of resp.content) if (b.type === "tool_use" && b.name === SUBMIT_DECISION) decisions.push(b.input as Record<string, unknown>);
    }
    expect(decisions.map((d) => d.action)).toEqual(["HOLD", "BUY", "BUY", "ADJUST_STOP", "ADJUST_STOP", "BUY", "BUY"]);
    for (const d of decisions) expect(AgentDecisionSchema.safeParse(d).success).toBe(true);
    const step4 = decisions[1]!;
    expect(step4).toMatchObject({ quoteAmount: "200", stopPx: "488.7", tpPx: "506.6", timeStopMin: 240 });
    // stop distance from the preflight px (ceilToTick(ask × 1.001) = 495.2) is inside the default 0.3–3 %
    const dist = D("495.2").sub("488.7").div("495.2").mul(100);
    expect(dist.gt("0.3") && dist.lt("3")).toBe(true);
    const injected = decisions[6]!;
    expect(injected).toMatchObject({ instId: "DOGE-TRY", quoteAmount: "10000" });
    expect(injected.stopPx).toBeUndefined();
  });
});
