import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AdjustBodySchema, Address, AgentDecisionSchema, ChainPolicySchema, Dec8, ExecutorEventSchema, Hex32,
  LEDGER_KINDS, LEDGER_PAYLOAD_SCHEMAS, OrderRequestSchema, Pct2, PDec, PolicySchema, type Policy,
} from "./schemas.js";
import { VECTOR_ORDER_HASH, VECTOR_POLICY_DEFAULT, VECTOR_R1_REQ, VECTOR_REQ } from "./vectors.js";

const P: Policy = VECTOR_POLICY_DEFAULT;
const ok = (p: Partial<Policy>): boolean => PolicySchema.safeParse({ ...P, ...p }).success;

describe("primitives", () => {
  it("Pct2", () => {
    for (const s of ["0.3", "3", "0.05", "20.25"]) expect(Pct2.safeParse(s).success, s).toBe(true);
    for (const s of ["0", "0.00", "0.001", "-1", "1,5", ".5"]) expect(Pct2.safeParse(s).success, s).toBe(false);
  });
  it("PDec and Dec8", () => {
    expect(PDec.safeParse("0").success).toBe(false);
    expect(PDec.safeParse("0.1").success).toBe(true);
    expect(Dec8.safeParse("1.123456789").success).toBe(false);
    expect(Dec8.safeParse("1.12345678").success).toBe(true);
  });
  it("Hex32 and Address are lowercase only", () => {
    expect(Hex32.safeParse(VECTOR_ORDER_HASH).success).toBe(true);
    expect(Hex32.safeParse(VECTOR_ORDER_HASH.toUpperCase().replace("0X", "0x")).success).toBe(false);
    expect(Address.safeParse("0x5fbdb2315678afecb367f032d93f642f64180aa3").success).toBe(true);
    expect(Address.safeParse("0x5FbDB2315678afecb367f032d93F642f64180aa3").success).toBe(false);
  });
});

describe("PolicySchema (§9.1)", () => {
  it("accepts the default policy", () => {
    expect(ok({})).toBe(true);
  });
  it("rejects every bad range", () => {
    const bad: Partial<Policy>[] = [
      { instIds: [] },
      { instIds: Array.from({ length: 9 }, (_, i) => `C${i}X-TRY`) },
      { instIds: ["avax-try"] },
      { instIds: ["AVAX-TRY", "AVAX-TRY"] },
      { maxOrderQuote: "0" },
      { maxOrderQuote: "1000.01" },
      { maxOrderQuote: "1.123456789" },
      { dailyRiskBudgetQuote: "500.00000001" },
      { maxTradesPerHour: 0 },
      { maxTradesPerHour: 61, maxTradesPerDay: 100 },
      { maxTradesPerDay: 101 },
      { maxTradesPerHour: 5, maxTradesPerDay: 4 },
      { minStopDistancePct: "3", maxStopDistancePct: "3" },
      { maxStopDistancePct: "20.01" },
      { maxHoldMin: 14 },
      { maxHoldMin: 1441 },
      { feeBps: 101 },
      { slippageBps: 201 },
      { validUntil: P.validUntil + 1 },
      { sourceText: "x".repeat(1001) },
    ];
    for (const b of bad) expect(ok(b), JSON.stringify(b)).toBe(false);
  });
  it("accepts the boundaries", () => {
    expect(ok({ maxOrderQuote: "1000", dailyRiskBudgetQuote: "500", maxStopDistancePct: "20", maxHoldMin: 1440 })).toBe(true);
    expect(ok({ maxTradesPerHour: 60, maxTradesPerDay: 100, feeBps: 100, slippageBps: 200, maxHoldMin: 15 })).toBe(true);
  });
  it("ChainPolicySchema is looser (U4) but keeps the contract rules", () => {
    const chainOnly = { ...P, maxTradesPerHour: 61, maxTradesPerDay: 200, instIds: ["weird pair"] };
    expect(PolicySchema.safeParse(chainOnly).success).toBe(false);
    expect(ChainPolicySchema.safeParse(chainOnly).success).toBe(true);
    expect(ChainPolicySchema.safeParse({ ...P, maxOrderQuote: "1001" }).success).toBe(false);
  });
});

describe("safeParse never throws", () => {
  const schemas = { PolicySchema, ChainPolicySchema, OrderRequestSchema, AgentDecisionSchema, ExecutorEventSchema, Pct2, PDec, Dec8 };
  it("on malformed policies", () => {
    const junk: unknown[] = [
      { ...P, instIds: 5 }, { ...P, maxOrderQuote: "1,5", minStopDistancePct: "x" }, { ...P, validUntil: "soon" },
      { ...P, maxTradesPerHour: "1" }, null, "policy", [],
    ];
    for (const j of junk) {
      expect(() => PolicySchema.safeParse(j)).not.toThrow();
      expect(PolicySchema.safeParse(j).success).toBe(false);
      expect(() => ChainPolicySchema.safeParse(j)).not.toThrow();
    }
  });
  it("on arbitrary JSON (fast-check)", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.constantFrom(...Object.values(schemas)), (v, s) => {
        s.safeParse(v);
      }),
      { numRuns: 2000 },
    );
  });
  it("on policy-shaped objects with random field values (fast-check)", () => {
    const val = fc.oneof(fc.string(), fc.integer(), fc.double(), fc.constant(null), fc.array(fc.string()));
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom(...Object.keys(P)), val), (over) => {
        PolicySchema.safeParse({ ...P, ...over });
        ChainPolicySchema.safeParse({ ...P, ...over });
      }),
      { numRuns: 2000 },
    );
  });
});

describe("OrderRequestSchema (§9.2)", () => {
  it("accepts the vectors, including R1 with zero stop", () => {
    expect(OrderRequestSchema.safeParse(VECTOR_REQ).success).toBe(true);
    expect(OrderRequestSchema.safeParse(VECTOR_R1_REQ).success).toBe(true);
    expect(OrderRequestSchema.safeParse({ ...VECTOR_REQ, px: "0", sz: "0" }).success).toBe(true);
  });
  it("rejects sell side and > 8 dp", () => {
    expect(OrderRequestSchema.safeParse({ ...VECTOR_REQ, side: "sell" }).success).toBe(false);
    expect(OrderRequestSchema.safeParse({ ...VECTOR_REQ, sz: "0.123456789" }).success).toBe(false);
  });
});

const common = {
  instId: "AVAX-TRY",
  regime: "TREND_UP",
  playbook: "TREND_PULLBACK",
  evidence: ["EMA20 > EMA50 (get_indicators)"],
  scenarios: { bull: "yukarı", bear: "aşağı" },
  thesis: "Geri çekilme alımı",
  invalidation: "EMA50 altı kapanış",
  confidence: 60,
  nextCheckInMin: 10,
};

describe("AgentDecisionSchema (§9.3)", () => {
  it("strips foreign fields", () => {
    const r = AgentDecisionSchema.parse({ action: "HOLD", ...common, playbook: "STAND_ASIDE", hack: "x" });
    expect("hack" in r).toBe(false);
  });
  it("lets the contract judge missing stops, foreign pairs and oversize amounts", () => {
    const rogue = { action: "BUY", ...common, instId: "DOGE-TRY", quoteAmount: "10000" };
    expect(AgentDecisionSchema.safeParse(rogue).success).toBe(true);
  });
  it("ADJUST_STOP needs at least one level", () => {
    expect(AgentDecisionSchema.safeParse({ action: "ADJUST_STOP", ...common }).success).toBe(false);
    expect(AgentDecisionSchema.safeParse({ action: "ADJUST_STOP", ...common, newStopPx: "490" }).success).toBe(true);
  });
  it("rejects bad shapes", () => {
    expect(AgentDecisionSchema.safeParse({ action: "SELL", ...common }).success).toBe(false);
    expect(AgentDecisionSchema.safeParse({ action: "BUY", ...common, quoteAmount: 200 }).success).toBe(false);
    expect(AgentDecisionSchema.safeParse({ action: "HOLD", ...common, evidence: [] }).success).toBe(false);
    expect(AgentDecisionSchema.safeParse({ action: "HOLD", ...common, confidence: 101 }).success).toBe(false);
    expect(AgentDecisionSchema.safeParse({ action: "BUY", ...common, quoteAmount: "200", stopPx: "0" }).success).toBe(false);
  });
});

describe("executor events and ledger payloads", () => {
  it("parses a FILL event", () => {
    const e = {
      n: 1,
      ts: 1,
      type: "FILL",
      data: {
        orderHash: VECTOR_ORDER_HASH, clOrdId: "v97c45554ff62e3d9cf7674f5c240d5", ordId: "1", state: "filled",
        accFillSz: "0.40428", avgPx: "494.6", fee: "-0.0004", feeCcy: "AVAX", cTime: 2, dust: false,
      },
    };
    expect(ExecutorEventSchema.safeParse(e).success).toBe(true);
    expect(ExecutorEventSchema.safeParse({ ...e, type: "EXIT" }).success).toBe(false);
  });
  it("has a payload schema for every ledger kind", () => {
    for (const k of LEDGER_KINDS) expect(LEDGER_PAYLOAD_SCHEMAS[k], k).toBeDefined();
    expect(LEDGER_PAYLOAD_SCHEMAS.RESUME.safeParse({ by: "human" }).success).toBe(true);
    expect(LEDGER_PAYLOAD_SCHEMAS.ANCHOR.safeParse({ index: 0, root: VECTOR_ORDER_HASH, fromSeq: 1, toSeq: 5, txHash: "0x" }).success).toBe(true);
    expect(LEDGER_PAYLOAD_SCHEMAS.KILL.safeParse({
      haltedAt: 1, source: "dashboard", reason: "x", alreadyHalted: false,
      steps: { localMs: 12, executorMs: 640, chainMs: null }, cancelled: [], flattened: false, pauseTx: null, errors: [],
    }).success).toBe(true);
  });
  it("adjust body needs a level", () => {
    expect(AdjustBodySchema.safeParse({ entryOrderHash: VECTOR_ORDER_HASH }).success).toBe(false);
  });
});
