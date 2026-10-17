import { describe, expect, it } from "vitest";
import { fromChainPolicy, policyHash, sourceTextHash, toChainPolicy } from "./policy-encode.js";
import { defaultPolicy, PolicySchema } from "./schemas.js";
import {
  VECTOR_POLICY_2, VECTOR_POLICY_2_HASH, VECTOR_POLICY_2_SOURCE_TEXT_HASH, VECTOR_POLICY_DEFAULT,
  VECTOR_POLICY_DEFAULT_HASH, VECTOR_VALID_UNTIL_MS,
} from "./vectors.js";

describe("policyHash (frozen)", () => {
  it("default policy", () => {
    expect(policyHash(VECTOR_POLICY_DEFAULT)).toBe(VECTOR_POLICY_DEFAULT_HASH);
  });
  it("two instruments and Turkish source text", () => {
    expect(sourceTextHash(VECTOR_POLICY_2.sourceText)).toBe(VECTOR_POLICY_2_SOURCE_TEXT_HASH);
    expect(policyHash(VECTOR_POLICY_2)).toBe(VECTOR_POLICY_2_HASH);
  });
  it("the vectors are valid owner policies", () => {
    expect(PolicySchema.safeParse(VECTOR_POLICY_DEFAULT).success).toBe(true);
    expect(PolicySchema.safeParse(VECTOR_POLICY_2).success).toBe(true);
  });
  it("defaultPolicy() equals the vector policy for the same day", () => {
    expect(defaultPolicy(VECTOR_VALID_UNTIL_MS - 3_600_000)).toEqual(VECTOR_POLICY_DEFAULT);
  });
});

describe("chain encoding", () => {
  it("converts units exactly", () => {
    const c = toChainPolicy(VECTOR_POLICY_DEFAULT);
    expect(c).toEqual({
      maxOrderQuote: 20_000_000_000n,
      dailyRiskBudget: 10_000_000_000n,
      maxTradesPerHour: 1,
      maxTradesPerDay: 4,
      minStopBps: 30,
      maxStopBps: 300,
      maxHoldMin: 480,
      feeBps: 20,
      slippageBps: 30,
      validUntil: 1_792_270_799n,
    });
  });
  it("round-trips", () => {
    const c = toChainPolicy(VECTOR_POLICY_2);
    expect(fromChainPolicy(c, VECTOR_POLICY_2.instIds, VECTOR_POLICY_2.sourceText)).toEqual(VECTOR_POLICY_2);
  });
  it("is sensitive to instId order and text", () => {
    expect(policyHash({ ...VECTOR_POLICY_2, instIds: ["BTC-TRY", "AVAX-TRY"] })).not.toBe(VECTOR_POLICY_2_HASH);
    expect(policyHash({ ...VECTOR_POLICY_2, sourceText: `${VECTOR_POLICY_2.sourceText} ` })).not.toBe(VECTOR_POLICY_2_HASH);
  });
  it("rejects a fractional-second validUntil", () => {
    expect(() => toChainPolicy({ ...VECTOR_POLICY_DEFAULT, validUntil: VECTOR_VALID_UNTIL_MS + 1 })).toThrow();
  });
});
