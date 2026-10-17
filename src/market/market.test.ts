import { describe, expect, it } from "vitest";
import { D } from "../shared/money.js";
import { SimClock } from "../shared/time.js";
import { AtkToolError } from "../atk/parse.js";
import { AtkMarket, type AtkDataSource } from "./atk-market.js";
import { FakeMarket, MarketDataError } from "./fake-market.js";
import { midAt, instrumentFor } from "./synthetic.js";

const T0 = 1_792_219_459_000;
const isMultiple = (x: string, u: string) => D(x).mod(D(u)).isZero();

describe("FakeMarket", () => {
  it("serves the real TR specs for AVAX-TRY, DOGE-TRY and BTC-TRY, and any other instId", async () => {
    const m = new FakeMarket(new SimClock(T0));
    expect(await m.getInstrument("AVAX-TRY")).toEqual({ instId: "AVAX-TRY", baseCcy: "AVAX", quoteCcy: "TRY", tickSz: "0.1", lotSz: "0.00001", minSz: "0.1", state: "live" });
    expect((await m.getInstrument("DOGE-TRY")).minSz).toBe("10");
    expect((await m.getInstrument("BTC-TRY")).lotSz).toBe("0.000000001");
    expect((await m.getInstrument("SOL-TRY")).quoteCcy).toBe("TRY");
  });

  it("snapshots are deterministic per seed and time, on the tick, bid < ask", async () => {
    const a = new FakeMarket(new SimClock(T0), 7);
    const b = new FakeMarket(new SimClock(T0), 7);
    for (const inst of ["AVAX-TRY", "DOGE-TRY", "BTC-TRY", "SOL-TRY"]) {
      const s = await a.getSnapshot(inst);
      expect(s).toEqual(await b.getSnapshot(inst));
      const tick = instrumentFor(inst).tickSz;
      expect(isMultiple(s.bid, tick) && isMultiple(s.ask, tick)).toBe(true);
      expect(D(s.bid).lt(D(s.ask))).toBe(true);
      expect(s.fetchedAt).toBe(T0);
    }
  });

  it("forcePrice pins the mid and keeps the spread", async () => {
    const clock = new SimClock(T0);
    const m = new FakeMarket(clock);
    const before = await m.getSnapshot("AVAX-TRY");
    const spread = D(before.ask).sub(D(before.bid));
    m.forcePrice("AVAX-TRY", "480");
    const s = await m.getSnapshot("AVAX-TRY");
    expect(D(s.ask).sub(D(s.bid)).eq(spread)).toBe(true);
    expect(s.bid).toBe("479.7");
    expect(s.ask).toBe("480.3");
    expect(s.last).toBe("480");
    clock.advance(3 * 60_000);
    expect((await m.getSnapshot("AVAX-TRY")).bid).toBe("479.7");
    m.clearForcedPrice("AVAX-TRY");
    expect((await m.getSnapshot("AVAX-TRY")).last).toBe(midAt(instrumentFor("AVAX-TRY"), 42, Math.floor(clock.now() / 60_000)));
  });

  it("candles: confirmed only, oldest first, aligned, h ≥ o,c ≥ l", async () => {
    const m = new FakeMarket(new SimClock(T0));
    for (const [bar, len] of [["5m", 5], ["15m", 15], ["1H", 60]] as const) {
      const cs = await m.getCandles("AVAX-TRY", bar, 50);
      expect(cs).toHaveLength(50);
      for (let k = 0; k < cs.length; k++) {
        const c = cs[k]!;
        expect(c.confirmed).toBe(true);
        expect(c.ts % (len * 60_000)).toBe(0);
        expect(c.ts + len * 60_000).toBeLessThanOrEqual(T0);
        if (k > 0) expect(c.ts - cs[k - 1]!.ts).toBe(len * 60_000);
        expect(D(c.h).gte(D(c.o)) && D(c.h).gte(D(c.c)) && D(c.l).lte(D(c.o)) && D(c.l).lte(D(c.c))).toBe(true);
      }
    }
  });

  it("book and trades", async () => {
    const m = new FakeMarket(new SimClock(T0));
    const s = await m.getSnapshot("AVAX-TRY");
    const b = await m.getBook("AVAX-TRY", 20);
    expect(b.bids).toHaveLength(20);
    expect(b.asks[0]![0]).toBe(s.ask);
    expect(b.bids[0]![0]).toBe(s.bid);
    expect(D(b.asks[1]![0]).sub(D(b.asks[0]![0])).toFixed()).toBe("0.1");
    const t = await m.getTrades("AVAX-TRY", 200);
    expect(t).toHaveLength(200);
    expect(t.every((x) => x.ts <= T0)).toBe(true);
    expect(new Set(t.map((x) => x.side)).size).toBe(2);
  });

  it("setFailing makes every call throw; setInstrumentState changes the spec", async () => {
    const m = new FakeMarket(new SimClock(T0));
    m.setFailing("AVAX-TRY", true);
    await expect(m.getSnapshot("AVAX-TRY")).rejects.toBeInstanceOf(MarketDataError);
    m.setFailing("AVAX-TRY", false);
    m.setInstrumentState("AVAX-TRY", "suspend");
    expect((await m.getInstrument("AVAX-TRY")).state).toBe("suspend");
  });
});

/** Fake ATK data source returning discovery-time payloads (ATK_NOTES §2, §4). */
function source(over: Record<string, unknown> = {}): AtkDataSource & { calls: { name: string; args: Record<string, unknown> }[] } {
  const data: Record<string, unknown> = {
    market_get_instruments: [{ instId: "AVAX-TRY", baseCcy: "AVAX", quoteCcy: "TRY", tickSz: "0.1", lotSz: "0.00001", minSz: "0.1", state: "live", instType: "SPOT" }],
    market_get_ticker: [{ instType: "SPOT", instId: "AVAX-TRY", last: "494.6", lastSz: "0.20218", askPx: "494.7", askSz: "100.1163", bidPx: "494.1", bidSz: "496.00993", ts: "1792219459765" }],
    market_get_candles: [
      ["1792219500000", "494.6", "494.6", "494.6", "494.6", "0", "0", "0", "0"],
      ["1792218600000", "494.6", "494.7", "494.5", "494.6", "1.2", "0", "0", "1"],
      ["1792217700000", "494.0", "494.9", "493.9", "494.6", "3", "0", "0", "1"],
    ],
    market_get_orderbook: [{ asks: [["494.8", "100.08541", "0", "1"]], bids: [["494.3", "100.13573", "0", "1"], ["494.2", "395.76457", "0", "2"]], ts: "1792219534251" }],
    market_get_trades: [{ instId: "AVAX-TRY", tradeId: "28046", px: "494.6", sz: "0.20218", side: "buy", ts: "1792215658540" }],
    ...over,
  };
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    async callData(name, args) {
      calls.push({ name, args });
      return data[name];
    },
  };
}

describe("AtkMarket", () => {
  it("maps instrument, ticker, book and trades; caches specs", async () => {
    const clock = new SimClock(T0);
    const src = source();
    const m = new AtkMarket(src, clock);
    expect(await m.getInstrument("AVAX-TRY")).toMatchObject({ tickSz: "0.1", lotSz: "0.00001", minSz: "0.1", state: "live" });
    await m.getInstrument("AVAX-TRY");
    expect(src.calls.filter((c) => c.name === "market_get_instruments")).toHaveLength(1);
    expect(src.calls[0]!.args).toEqual({ instType: "SPOT", instId: "AVAX-TRY" });
    expect(await m.getSnapshot("AVAX-TRY")).toEqual({ instId: "AVAX-TRY", bid: "494.1", ask: "494.7", last: "494.6", bidSz: "496.00993", askSz: "100.1163", exchTs: 1792219459765, fetchedAt: T0 });
    expect(await m.getBook("AVAX-TRY", 2)).toEqual({ bids: [["494.3", "100.13573"], ["494.2", "395.76457"]], asks: [["494.8", "100.08541"]] });
    expect(await m.getTrades("AVAX-TRY", 1)).toEqual([{ px: "494.6", sz: "0.20218", side: "buy", ts: 1792215658540 }]);
  });

  it("candles: drops the open candle, reverses to oldest first", async () => {
    const m = new AtkMarket(source(), new SimClock(T0));
    const cs = await m.getCandles("AVAX-TRY", "15m", 2);
    expect(cs.map((c) => c.ts)).toEqual([1792217700000, 1792218600000]);
    expect(cs[0]).toEqual({ ts: 1792217700000, o: "494.0", h: "494.9", l: "493.9", c: "494.6", vol: "3", confirmed: true });
  });

  it("an empty book (demo: askPx \"\") is an error, not a zero price", async () => {
    const m = new AtkMarket(source({ market_get_ticker: [{ instId: "AVAX-TRY", last: "595.2", askPx: "", askSz: "0", bidPx: "", bidSz: "0", ts: "1" }] }), new SimClock(T0));
    await expect(m.getSnapshot("AVAX-TRY")).rejects.toBeInstanceOf(AtkToolError);
  });

  it("unknown instrument / wrong instId are errors", async () => {
    const m = new AtkMarket(source({ market_get_instruments: [] }), new SimClock(T0));
    await expect(m.getInstrument("AVAX-TRY")).rejects.toBeInstanceOf(MarketDataError);
    await expect(m.getSnapshot("DOGE-TRY")).rejects.toBeInstanceOf(MarketDataError);
  });
});
