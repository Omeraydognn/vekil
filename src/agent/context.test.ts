import { describe, expect, it } from "vitest";
import { SimClock } from "../shared/time.js";
import { bookImbalance, btcTrend, computeMarketContext, makeMarketContextFn, tradeFlow, volumeVsAverage } from "./context.js";
import { IndicatorError } from "./indicators.js";
import { fakeMarket, makeCandles, T0 } from "./test-helpers.js";

describe("market context (hand-computed)", () => {
  it("book imbalance = top-20 bid volume / ask volume", () => {
    const bids: [string, string][] = Array.from({ length: 25 }, () => ["1", "2"]);
    const asks: [string, string][] = Array.from({ length: 25 }, () => ["1", "0.5"]);
    expect(bookImbalance({ bids, asks })).toMatchObject({ depth: 20, bidVol: "40", askVol: "10", imbalance: "4" });
    expect(bookImbalance({ bids, asks: [] }).imbalance).toBe("0");
  });

  it("trade flow counts at most 200 trades", () => {
    const trades = [
      ...Array.from({ length: 150 }, () => ({ sz: "1", side: "buy" as const })),
      ...Array.from({ length: 50 }, () => ({ sz: "2", side: "sell" as const })),
      ...Array.from({ length: 100 }, () => ({ sz: "9", side: "sell" as const })),
    ];
    expect(tradeFlow(trades)).toMatchObject({ trades: 200, buyVol: "150", sellVol: "100", buySellRatio: "1.5" });
    expect(tradeFlow([{ sz: "1", side: "buy" }]).buySellRatio).toBeNull();
  });

  it("24h volume vs its average over the window", () => {
    const hourly = makeCandles(48, "1H").map((c, i) => ({ ...c, vol: i < 24 ? "1" : "3" }));
    expect(volumeVsAverage(hourly)).toEqual({ vol24h: "72", avg24h: "48", ratio: "1.5", days: 2 });
    expect(() => volumeVsAverage(makeCandles(10, "1H"))).toThrow(IndicatorError);
  });

  it("btc trend: rising series is up; too short is null", () => {
    expect(btcTrend(makeCandles(100, "1H", { drift: 1, amp: 0.1 }))?.state).toBe("up");
    expect(btcTrend(makeCandles(100, "1H", { start: 900, drift: -1, amp: 0.1 }))?.state).toBe("down");
    expect(btcTrend(makeCandles(10, "1H"))).toBeNull();
  });

  it("computeMarketContext + makeMarketContextFn degrade a failed BTC read to null", async () => {
    const r = computeMarketContext({ instId: "AVAX-TRY", now: T0, btcCandles: null, book: { bids: [], asks: [] }, trades: [], hourly: makeCandles(168, "1H") });
    expect(r.btc).toBeNull();
    const market = fakeMarket();
    const orig = market.getCandles.bind(market);
    market.getCandles = async (instId, bar, limit) => {
      if (instId === "BTC-TRY") throw new Error("down");
      return orig(instId, bar, limit);
    };
    const ctx = await makeMarketContextFn({ market, clock: new SimClock(T0) })("AVAX-TRY");
    expect(ctx.btc).toBeNull();
    expect(ctx.book.imbalance).toBe("2");
    expect(ctx.tradeFlow.buySellRatio).toBe("3");
  });
});
