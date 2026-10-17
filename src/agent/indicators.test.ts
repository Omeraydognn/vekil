import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { D } from "../shared/money.js";
import { SimClock } from "../shared/time.js";
import {
  atrWilder, computeIndicators, ema, fmt, IndicatorError, makeIndicatorsFn, rsiWilder, stopDistancePct, suggestLevels, trendState,
} from "./indicators.js";
import { fakeMarket, makeCandles, T0 } from "./test-helpers.js";

const POLICY = { minStopDistancePct: "0.3", maxStopDistancePct: "3" };

describe("primitives (hand-computed)", () => {
  it("ema seeds with the SMA and then smooths with k = 2/(n+1)", () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(out[2]).toBeCloseTo(2, 12); // (1+2+3)/3
    expect(out[3]).toBeCloseTo(3, 12); // 4·0.5 + 2·0.5
    expect(out[4]).toBeCloseTo(4, 12);
  });

  it("rsiWilder: all gains → 100, all losses → 0, flat → 50, mixed by hand", () => {
    expect(rsiWilder([1, 2, 3, 4], 3)[3]).toBe(100);
    expect(rsiWilder([4, 3, 2, 1], 3)[3]).toBe(0);
    expect(rsiWilder([2, 2, 2, 2], 3)[3]).toBe(50);
    // changes +1, −1, +2 → avgGain 1, avgLoss 1/3 → RS 3 → 75; then change −1: gain 2/3, loss 5/9 → RS 1.2 → 54.545…
    const r = rsiWilder([10, 11, 10, 12, 11], 3);
    expect(r[3]).toBeCloseTo(75, 10);
    expect(r[4]).toBeCloseTo(100 - 100 / 2.2, 10);
  });

  it("atrWilder uses the true range incl. gaps", () => {
    const c = [
      { h: 10, l: 9, c: 9.5 },
      { h: 10, l: 9, c: 9.8 }, // TR 1
      { h: 12, l: 11, c: 11.5 }, // gap: TR = 12 − 9.8 = 2.2
      { h: 11.6, l: 11.2, c: 11.4 }, // TR = max(0.4, 0.1, 0.3) = 0.4
      { h: 11, l: 10, c: 10.5 }, // TR = max(1, 0.4, 1.4) = 1.4
    ];
    const a = atrWilder(c, 3);
    expect(a[3]).toBeCloseTo((1 + 2.2 + 0.4) / 3, 12);
    expect(a[4]).toBeCloseTo(((1.2 * 2) + 1.4) / 3, 12);
  });

  it("trendState and fmt", () => {
    expect(trendState(495, 490, 486)).toBe("up");
    expect(trendState(480, 485, 490)).toBe("down");
    expect(trendState(488, 490, 486)).toBe("up");
    expect(trendState(485, 490, 486)).toBe("flat");
    expect(fmt(2.345, 2)).toBe("2.35");
    expect(fmt(490, 1)).toBe("490");
    expect(() => fmt(NaN, 1)).toThrow(IndicatorError);
  });
});

describe("suggestLevels (§22.2)", () => {
  it("matches the worked example shape: entry = ceilToTick(ask × 1.001), stop 1.5 ATR, TP 2R", () => {
    // ask 494.7 → 495.1947 → 495.2; ATR 2.9 → raw stop 490.85 (0.878%) → floor 490.8; TP 495.2 + 2·4.4 = 504.0
    const s = suggestLevels("494.7", "2.9", "0.1", POLICY);
    expect(s).toEqual({ entryPx: "495.2", stopPx: "490.8", tpPx: "504", stopDistancePct: "0.89" });
  });

  it("clamps a tiny ATR up to minStop + 0.05 and a huge ATR down to maxStop − 0.05", () => {
    const tight = suggestLevels("494.7", "0.01", "0.1", POLICY);
    expect(D(tight.stopDistancePct).gte("0.3")).toBe(true);
    expect(D(stopDistancePct(tight.entryPx, tight.stopPx)).gte("0.35")).toBe(true);
    const wide = suggestLevels("494.7", "100", "0.1", POLICY);
    expect(D(stopDistancePct(wide.entryPx, wide.stopPx)).lte("3")).toBe(true);
    expect(D(stopDistancePct(wide.entryPx, wide.stopPx)).gte("2.9")).toBe(true);
  });

  it("property: suggested stop distance is always inside the on-chain policy; TP > entry > stop", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 2_000_000 }), // ask × 10 (100.0 .. 200000.0)
        fc.integer({ min: 1, max: 100_000 }), // ATR × 100
        fc.integer({ min: 30, max: 500 }), // minStop bps
        fc.integer({ min: 20, max: 1500 }), // extra bps above min
        (ask10, atr100, minBps, extra) => {
          const policy = { minStopDistancePct: (minBps / 100).toString(), maxStopDistancePct: ((minBps + extra) / 100).toString() };
          const s = suggestLevels((ask10 / 10).toString(), (atr100 / 100).toString(), "0.1", policy);
          const d = D(stopDistancePct(s.entryPx, s.stopPx));
          expect(d.gte(policy.minStopDistancePct)).toBe(true);
          expect(d.lte(policy.maxStopDistancePct)).toBe(true);
          expect(D(s.tpPx).gt(s.entryPx)).toBe(true);
          expect(D(s.entryPx).gt(s.stopPx)).toBe(true);
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe("computeIndicators", () => {
  const input = {
    instId: "AVAX-TRY",
    profile: "standard" as const,
    now: T0,
    tickSz: "0.1",
    bid: "494.1",
    ask: "494.7",
    trend: makeCandles(100, "1H"),
    entry: makeCandles(200, "15m"),
    policy: POLICY,
  };

  it("produces the §22.2 shape with the profile's bars and string numbers", () => {
    const r = computeIndicators(input);
    expect(r.asOf).toBe("2026-10-17T11:05:00+03:00");
    expect(r.spreadPct).toBe("0.12");
    expect(r.trend.bar).toBe("1H");
    expect(r.entry.bar).toBe("15m");
    expect(r.entry.last8).toHaveLength(8);
    expect(r.entry.last8[7]?.[0]).toBe("10:50");
    for (const v of [r.trend.close, r.trend.ema20, r.entry.rsi14, r.entry.atr14, r.entry.atrPct, r.entry.rangeHigh24h]) {
      expect(v).toMatch(/^-?\d+(\.\d+)?$/);
    }
    expect(D(r.entry.rangeHigh24h).gte(r.entry.rangeLow24h)).toBe(true);
    const d = D(stopDistancePct(r.suggested.entryPx, r.suggested.stopPx));
    expect(d.gte("0.3") && d.lte("3")).toBe(true);
  });

  it("the active profile uses 15m trend + 5m entries", () => {
    const r = computeIndicators({ ...input, profile: "active", trend: makeCandles(200, "15m"), entry: makeCandles(300, "5m") });
    expect(r.trend.bar).toBe("15m");
    expect(r.entry.bar).toBe("5m");
  });

  it("ignores unconfirmed candles and refuses too little data", () => {
    const entry = [...input.entry, { ...makeCandles(1, "15m")[0]!, c: "999", confirmed: false }];
    expect(computeIndicators({ ...input, entry }).entry.close).toBe(computeIndicators(input).entry.close);
    expect(() => computeIndicators({ ...input, trend: makeCandles(10, "1H") })).toThrow(IndicatorError);
  });

  it("makeIndicatorsFn reads spec, snapshot, both timeframes and the on-chain policy", async () => {
    const market = fakeMarket();
    const fn = makeIndicatorsFn({ market, policy: async () => POLICY, profile: "standard", clock: new SimClock(T0) });
    const r = await fn("AVAX-TRY");
    expect(r.ask).toBe("494.7");
    expect(market.calls).toEqual(expect.arrayContaining(["spec:AVAX-TRY", "snap:AVAX-TRY", "candles:AVAX-TRY:1H:100", "candles:AVAX-TRY:15m:200"]));
  });
});
