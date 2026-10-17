import { describe, expect, it } from "vitest";
import type { LlmClient } from "../shared/interfaces.js";
import type { InstrumentSpec } from "../shared/schemas.js";
import { SimClock } from "../shared/time.js";
import { ScriptedLlm } from "./llm/scripted.js";
import { makePolicyParser, PROPOSE_POLICY } from "./policy-parser.js";

const NOW = Date.parse("2026-10-17T08:00:00Z");
const clock = new SimClock(NOW);
const LIVE = new Set(["AVAX-TRY", "DOGE-TRY", "BTC-TRY"]);
const instrument = async (instId: string): Promise<InstrumentSpec | null> =>
  LIVE.has(instId) ? { instId, baseCcy: instId.split("-")[0]!, quoteCcy: "TRY", tickSz: "0.1", lotSz: "0.001", minSz: "0.1", state: "live" } : null;

function llmWith(input: Record<string, unknown>): LlmClient & { requests: unknown[] } {
  return new ScriptedLlm([{ content: [{ type: "tool_use", name: PROPOSE_POLICY, input }] }], { clock });
}

const base = {
  instIds: ["AVAX-TRY"], maxOrderQuote: "200", dailyRiskBudgetQuote: "100", maxTradesPerHour: 1, maxTradesPerDay: 4,
  minStopDistancePct: "0.3", maxStopDistancePct: "3", maxHoldMin: 480, feeBps: 20, slippageBps: 30,
  validUntilIso: "2026-10-17T23:59:59+03:00", mapping: [{ phrase: "varsayılan", field: "maxHoldMin", value: "480" }],
  assumptions: ["Süre varsayılan."], questions: [], summaryTr: "Sadece AVAX.",
};

describe("policy-parser", () => {
  it("forces propose_policy and returns a valid policy with the source text", async () => {
    const llm = llmWith(base);
    const p = await makePolicyParser({ llm, clock, instrument })("Sadece AVAX al.", { nowMs: NOW });
    expect(p.errors).toEqual([]);
    expect(p.policy).toMatchObject({ instIds: ["AVAX-TRY"], sourceText: "Sadece AVAX al.", validUntil: Date.parse("2026-10-17T20:59:59Z") });
    const req = (llm as unknown as ScriptedLlm).requests[0]!;
    expect(req.toolChoice).toEqual({ type: "tool", name: PROPOSE_POLICY });
    expect(req.tools.map((t) => t.name)).toEqual([PROPOSE_POLICY]);
  });

  it("caps above the hard limits and asks", async () => {
    const p = await makePolicyParser({ llm: llmWith({ ...base, maxOrderQuote: "5000", dailyRiskBudgetQuote: "900" }), clock, instrument })("x", { nowMs: NOW });
    expect(p.policy.maxOrderQuote).toBe("1000");
    expect(p.policy.dailyRiskBudgetQuote).toBe("500");
    expect(p.questions.length).toBe(2);
    expect(p.errors).toEqual([]);
  });

  it("reports errors: Pct2 with 3 decimals, min ≥ max, perDay < perHour, unknown instrument, validUntil too far / not whole", async () => {
    const parse = (o: Record<string, unknown>) => makePolicyParser({ llm: llmWith({ ...base, ...o }), clock, instrument })("x", { nowMs: NOW });
    expect((await parse({ minStopDistancePct: "0.305" })).errors.join()).toMatch(/minStopDistancePct/);
    expect((await parse({ minStopDistancePct: "3", maxStopDistancePct: "2" })).errors.length).toBeGreaterThan(0);
    expect((await parse({ maxTradesPerHour: 5, maxTradesPerDay: 2 })).errors.length).toBeGreaterThan(0);
    expect((await parse({ instIds: ["FOO-TRY"] })).errors.join()).toMatch(/FOO-TRY/);
    expect((await parse({ validUntilIso: "2026-10-30T10:00:00+03:00" })).errors.join()).toMatch(/7 gün/);
    expect((await parse({ validUntilIso: "2026-10-17T23:59:59.500+03:00" })).errors.join()).toMatch(/tam saniye/);
  });

  it("keeps the model's questions and always adds the code guards (leverage, no stop, amount over the cap)", async () => {
    const p = await makePolicyParser({ llm: llmWith({ ...base, questions: ["Stopsuz işlem desteklenmiyor."] }), clock, instrument })("Kaldıraçlı al, zarar-kes koyma, işlem başına 2000 TL.", { nowMs: NOW });
    expect(p.questions[0]).toBe("Stopsuz işlem desteklenmiyor.");
    expect(p.questions.join(" ")).toMatch(/Kaldıraç/);
    expect(p.questions.join(" ")).toMatch(/zarar-kes zorunludur/);
    expect(p.questions.join(" ")).toMatch(/üst sınırı aşıyor/);
    const plain = await makePolicyParser({ llm: llmWith(base), clock, instrument })("Sadece AVAX al, işlem başına 200 TL.", { nowMs: NOW });
    expect(plain.questions).toEqual([]);
  });

  it("builds a Turkish summary when the model leaves it empty", async () => {
    const p = await makePolicyParser({ llm: llmWith({ ...base, summaryTr: "" }), clock, instrument })("Sadece AVAX al.", { nowMs: NOW });
    expect(p.summaryTr).toMatch(/^Yalnızca AVAX-TRY spot alım\. İşlem başına en fazla 200 TL/);
  });

  it("retries once when the model answers in text, and accepts a JSON object from the text", async () => {
    const retried = new ScriptedLlm([{ content: [{ type: "text", text: "Tamam." }] }, { content: [{ type: "tool_use", name: PROPOSE_POLICY, input: base }] }], { clock });
    expect((await makePolicyParser({ llm: retried, clock, instrument })("Sadece AVAX al.", { nowMs: NOW })).errors).toEqual([]);
    expect(retried.requests[1]!.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("propose_policy") });
    const asText = new ScriptedLlm([{ content: [{ type: "text", text: "x" }] }, { content: [{ type: "text", text: "```json\n" + JSON.stringify({ ...base, maxOrderQuote: "5000" }) + "\n```" }] }], { clock });
    const p = await makePolicyParser({ llm: asText, clock, instrument })("Sadece AVAX al.", { nowMs: NOW });
    expect(p.policy.maxOrderQuote).toBe("1000"); // still validated and capped in code
  });

  it("throws when the model does not call the tool or the text is too long", async () => {
    const none = new ScriptedLlm([{ content: [{ type: "text", text: "hayır" }] }, { content: [{ type: "text", text: "yine hayır" }] }], { clock });
    await expect(makePolicyParser({ llm: none, clock, instrument })("x", { nowMs: NOW })).rejects.toThrow(/propose_policy/);
    await expect(makePolicyParser({ llm: llmWith(base), clock, instrument })("a".repeat(1001), { nowMs: NOW })).rejects.toThrow(/1000/);
  });
});
