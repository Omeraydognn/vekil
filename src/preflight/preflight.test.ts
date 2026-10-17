import { describe, expect, it } from "vitest";
import { adjust, buy, close, H, hold, input, NOW, position } from "./fixtures.js";
import { preflight } from "./preflight.js";

describe("BUY: building the order", () => {
  it("clean BUY → CHAIN with exactly the derived order", () => {
    const r = preflight(input());
    expect(r).toEqual({
      route: "CHAIN",
      suspect: false,
      reasons: [],
      order: {
        instId: "AVAX-TRY",
        side: "buy",
        px: "495.2", // ceilToTick(494.7 × 1.001 = 495.1947, 0.1)
        sz: "0.20193", // floorToLot(100 / 495.2, 0.00001)
        stopPx: "490",
        tpPx: "505",
        timeStopMin: 480, // policy.maxHoldMin
        decisionHash: H("1"),
        nonce: H("2"),
      },
      adjust: null,
      exit: null,
    });
  });

  it("limitPx is rounded up to the tick; timeStopMin from the decision", () => {
    const r = preflight(input({ decision: buy({ limitPx: "494.71", timeStopMin: 60 }) }));
    expect(r.order?.px).toBe("494.8");
    expect(r.order?.timeStopMin).toBe(60);
  });

  it("missing stop/tp become \"0\"", () => {
    const r = preflight(input({ decision: buy({ stopPx: undefined, tpPx: undefined }) }));
    expect(r.order?.stopPx).toBe("0");
    expect(r.order?.tpPx).toBe("0");
  });

  it("no snapshot and no limitPx → px \"0\", sz \"0\"", () => {
    const r = preflight(input({ snapshot: null }));
    expect(r.order?.px).toBe("0");
    expect(r.order?.sz).toBe("0");
  });

  it("no spec → 8-decimal rounding (px up, sz down)", () => {
    const r = preflight(input({ spec: null, decision: buy({ limitPx: "3.123456789" }) }));
    expect(r.order?.px).toBe("3.12345679");
    expect(r.order?.sz).toBe("32.01581027"); // 100 / 3.12345679 = 32.0158102779…
  });

  it("null policy → timeStopMin 240", () => {
    expect(preflight(input({ policy: null })).order?.timeStopMin).toBe(240);
  });
});

describe("BUY: every local reason", () => {
  const reasonsOf = (o: Parameters<typeof input>[0]) => preflight(input(o)).reasons;

  it("HALTED", () => expect(reasonsOf({ halted: true })).toEqual(["HALTED"]));
  it("POLICY_PAUSED", () => expect(reasonsOf({ chain: { paused: true, policyVersion: 1, checkedAt: NOW } })).toEqual(["POLICY_PAUSED"]));
  it("CHAIN_STATE_STALE: old check", () => expect(reasonsOf({ chain: { paused: false, policyVersion: 1, checkedAt: NOW - 30_001 } })).toEqual(["CHAIN_STATE_STALE"]));
  it("not stale at exactly 30 s", () => expect(reasonsOf({ chain: { paused: false, policyVersion: 1, checkedAt: NOW - 30_000 } })).toEqual([]));
  it("CHAIN_STATE_STALE: null chain or policy", () => {
    expect(reasonsOf({ chain: null })).toEqual(["CHAIN_STATE_STALE"]);
    expect(reasonsOf({ policy: null })).toEqual(["CHAIN_STATE_STALE"]);
  });

  it("MARKET_DATA_MISSING (and the ‡ checks are skipped)", () => {
    const base = input();
    expect(reasonsOf({ snapshot: null })).toEqual(["MARKET_DATA_MISSING"]);
    expect(reasonsOf({ spec: null })).toEqual(["MARKET_DATA_MISSING"]);
    expect(reasonsOf({ account: null })).toEqual(["MARKET_DATA_MISSING"]);
    expect(reasonsOf({ snapshot: { ...base.snapshot!, instId: "DOGE-TRY" } })).toEqual(["MARKET_DATA_MISSING"]);
    expect(reasonsOf({ spec: { ...base.spec!, instId: "DOGE-TRY" } })).toEqual(["MARKET_DATA_MISSING"]);
    // crossed book, also very stale and wide: only MARKET_DATA_MISSING
    expect(reasonsOf({ snapshot: { ...base.snapshot!, bid: "500", ask: "490", fetchedAt: 0 } })).toEqual(["MARKET_DATA_MISSING"]);
  });

  it("INSTRUMENT_NOT_LIVE", () => expect(reasonsOf({ spec: { ...input().spec!, state: "suspend" } })).toEqual(["INSTRUMENT_NOT_LIVE"]));

  it("STALE_MARKET_DATA uses seconds → ms", () => {
    const s = input().snapshot!;
    expect(reasonsOf({ snapshot: { ...s, fetchedAt: NOW - 15_000 } })).toEqual([]);
    expect(reasonsOf({ snapshot: { ...s, fetchedAt: NOW - 15_001 } })).toEqual(["STALE_MARKET_DATA"]);
  });

  it("SPREAD_TOO_WIDE over mid", () => {
    const s = input().snapshot!;
    // (ask − bid)/mid × 100: 1.5/499.25 = 0.3004 % > 0.3
    expect(reasonsOf({ snapshot: { ...s, bid: "498.5", ask: "500" }, decision: buy({ limitPx: "500" }) })).toEqual(["SPREAD_TOO_WIDE"]);
    // 1.4/499.3 = 0.2804 % ≤ 0.3
    expect(reasonsOf({ snapshot: { ...s, bid: "498.6", ask: "500" }, decision: buy({ limitPx: "500" }) })).toEqual([]);
  });

  it("POSITION_ALREADY_OPEN only for the same instId", () => {
    expect(reasonsOf({ positions: [position()] })).toEqual(["POSITION_ALREADY_OPEN"]);
    expect(reasonsOf({ positions: [position({ instId: "DOGE-TRY" })] })).toEqual([]);
  });

  it("PRICE_FAR_FROM_MARKET (exact)", () => {
    expect(reasonsOf({ decision: buy({ limitPx: "499.6" }) })).toEqual([]); // 4.9/494.7 = 0.9905 %
    expect(reasonsOf({ decision: buy({ limitPx: "499.7" }) })).toEqual(["PRICE_FAR_FROM_MARKET"]); // 1.0107 %
    expect(reasonsOf({ decision: buy({ limitPx: "489.7" }) })).toEqual(["PRICE_FAR_FROM_MARKET"]); // below too
  });

  it("ORDER_BELOW_MIN_SIZE: raw size or net of fee", () => {
    // 49.5 / 495.2 = 0.09995… < 0.1
    expect(reasonsOf({ decision: buy({ quoteAmount: "49.5" }) })).toEqual(["ORDER_BELOW_MIN_SIZE"]);
    // limit 495: 49.55/495 → 0.1001 ≥ 0.1, but floorToLot(0.1001 × 0.998 = 0.0998998) < 0.1
    expect(reasonsOf({ decision: buy({ quoteAmount: "49.55", limitPx: "495" }) })).toEqual(["ORDER_BELOW_MIN_SIZE"]);
    expect(reasonsOf({ decision: buy({ quoteAmount: "60", limitPx: "495" }) })).toEqual([]);
  });

  it("INSUFFICIENT_BALANCE includes the fee", () => {
    // px 495.2 × sz 0.20193 = 99.995736; × 1.002 = 100.19572…
    expect(reasonsOf({ account: { quoteAvail: "100.19", baseAvail: "0", fetchedAt: NOW } })).toEqual(["INSUFFICIENT_BALANCE"]);
    expect(reasonsOf({ account: { quoteAvail: "100.2", baseAvail: "0", fetchedAt: NOW } })).toEqual([]);
  });

  it("COOLDOWN_ACTIVE uses minutes → ms", () => {
    expect(reasonsOf({ lastLossExitAt: NOW - 59 * 60_000 })).toEqual(["COOLDOWN_ACTIVE"]);
    expect(reasonsOf({ lastLossExitAt: NOW - 60 * 60_000 })).toEqual([]);
  });

  it("collects several reasons in table order", () => {
    expect(reasonsOf({ halted: true, chain: null, positions: [position()], lastLossExitAt: NOW })).toEqual([
      "HALTED",
      "CHAIN_STATE_STALE",
      "POSITION_ALREADY_OPEN",
      "COOLDOWN_ACTIVE",
    ]);
  });
});

describe("BUY: suspicion and routing", () => {
  it("suspect: foreign instrument, oversize, missing stop", () => {
    expect(preflight(input({ decision: buy({ instId: "DOGE-TRY" }) })).suspect).toBe(true);
    expect(preflight(input({ decision: buy({ quoteAmount: "200.00000001" }) })).suspect).toBe(true);
    expect(preflight(input({ decision: buy({ quoteAmount: "200" }) })).suspect).toBe(false);
    expect(preflight(input({ decision: buy({ stopPx: undefined }) })).suspect).toBe(true);
  });

  it("suspect → CHAIN even with local failures (reasons kept as a report)", () => {
    const r = preflight(input({ decision: buy({ instId: "DOGE-TRY", stopPx: undefined, quoteAmount: "1000" }) }));
    expect(r.route).toBe("CHAIN");
    expect(r.suspect).toBe(true);
    expect(r.reasons).toContain("MARKET_DATA_MISSING"); // snapshot/spec are AVAX-TRY
    expect(r.order?.instId).toBe("DOGE-TRY");
  });

  it("halted / paused → LOCAL_BLOCK even when suspect (not a test)", () => {
    expect(preflight(input({ halted: true, decision: buy({ stopPx: undefined }) })).route).toBe("LOCAL_BLOCK");
    expect(preflight(input({ chain: { paused: true, policyVersion: 1, checkedAt: NOW }, decision: buy({ stopPx: undefined }) })).route).toBe("LOCAL_BLOCK");
  });

  it("forceChain → CHAIN even when halted", () => {
    expect(preflight(input({ halted: true, forceChain: true })).route).toBe("CHAIN");
  });

  it("test + suspect → CHAIN, even when halted", () => {
    expect(preflight(input({ test: true, halted: true, decision: buy({ instId: "DOGE-TRY" }) })).route).toBe("CHAIN");
  });

  it("test + not suspect → NONE (Ajan kanmadı), even with local reasons", () => {
    expect(preflight(input({ test: true })).route).toBe("NONE");
    expect(preflight(input({ test: true, positions: [position()] })).route).toBe("NONE");
  });

  it("local reasons, not suspect → LOCAL_BLOCK", () => {
    expect(preflight(input({ positions: [position()] })).route).toBe("LOCAL_BLOCK");
  });

  it("null chain/policy → CHAIN_STATE_STALE, not suspect, LOCAL_BLOCK", () => {
    const r = preflight(input({ chain: null, decision: buy({ instId: "DOGE-TRY", stopPx: undefined }) }));
    expect(r.suspect).toBe(false);
    expect(r.reasons).toContain("CHAIN_STATE_STALE");
    expect(r.route).toBe("LOCAL_BLOCK");
  });
});

describe("other actions", () => {
  it("HOLD → NONE", () => {
    expect(preflight(input({ decision: hold() }))).toMatchObject({ route: "NONE", reasons: [], order: null, exit: null, adjust: null });
  });

  it("CLOSE: no position → NO_POSITION; else an AGENT_CLOSE exit", () => {
    expect(preflight(input({ decision: close() }))).toMatchObject({ route: "LOCAL_BLOCK", reasons: ["NO_POSITION"], exit: null });
    expect(preflight(input({ decision: close(), positions: [position({ instId: "DOGE-TRY" })] })).reasons).toEqual(["NO_POSITION"]);
    expect(preflight(input({ decision: close(), positions: [position()] }))).toMatchObject({
      route: "NONE",
      reasons: [],
      exit: { entryOrderHash: H("a"), reason: "AGENT_CLOSE" },
    });
  });

  it("ADJUST_STOP: every reason", () => {
    const p = [position()]; // stop 490, bid 494.1
    expect(preflight(input({ decision: adjust({ newStopPx: "491" }) })).reasons).toEqual(["NO_POSITION"]);
    expect(preflight(input({ decision: adjust({ newStopPx: "489" }), positions: p })).reasons).toEqual(["STOP_LOOSENED"]);
    expect(preflight(input({ decision: adjust({ newStopPx: "494.1" }), positions: p })).reasons).toEqual(["STOP_ABOVE_MARKET"]);
    expect(preflight(input({ decision: adjust({ newTpPx: "494.1" }), positions: p })).reasons).toEqual(["TP_BELOW_MARKET"]);
    expect(preflight(input({ decision: adjust({ newStopPx: "491" }), positions: p, snapshot: null })).reasons).toEqual(["MARKET_DATA_MISSING"]);
    for (const d of [adjust({ newStopPx: "489" }), adjust({ newStopPx: "494.1" })]) expect(preflight(input({ decision: d, positions: p })).route).toBe("LOCAL_BLOCK");
  });

  it("ADJUST_STOP ok → adjust payload with only the given fields", () => {
    const r = preflight(input({ decision: adjust({ newStopPx: "491", newTpPx: "510" }), positions: [position()] }));
    expect(r).toMatchObject({ route: "NONE", reasons: [], adjust: { entryOrderHash: H("a"), newStopPx: "491", newTpPx: "510" } });
    const r2 = preflight(input({ decision: adjust({ newTpPx: "510" }), positions: [position()] }));
    expect(r2.adjust).toEqual({ entryOrderHash: H("a"), newTpPx: "510" });
  });
});
