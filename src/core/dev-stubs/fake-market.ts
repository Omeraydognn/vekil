// DEV STUB (deleted at M2): a tiny deterministic MarketData (AVAX-TRY ~494, DOGE-TRY ~7, BTC-TRY).
import type { Clock, MarketData } from "../../shared/interfaces.js";
import { ceilToTick, D, toDecString } from "../../shared/money.js";
import type { Candle, InstrumentSpec, MarketSnapshot } from "../../shared/schemas.js";

const SPECS: Record<string, Omit<InstrumentSpec, "instId">> = {
  "AVAX-TRY": { baseCcy: "AVAX", quoteCcy: "TRY", tickSz: "0.1", lotSz: "0.00001", minSz: "0.01", state: "live" },
  "DOGE-TRY": { baseCcy: "DOGE", quoteCcy: "TRY", tickSz: "0.001", lotSz: "0.01", minSz: "1", state: "live" },
  "BTC-TRY": { baseCcy: "BTC", quoteCcy: "TRY", tickSz: "1", lotSz: "0.00000001", minSz: "0.00001", state: "live" },
};

export class FakeMarket implements MarketData {
  private bids: Record<string, string> = { "AVAX-TRY": "494.1", "DOGE-TRY": "7.003", "BTC-TRY": "4410000" };
  private spreadPct = "0.12";
  failSnapshot = false;
  constructor(private readonly clock: Clock) {}

  /** Sets the bid; the ask keeps the current spread. */
  forcePrice(instId: string, bid: string): void {
    this.bids[instId] = bid;
  }

  async getInstrument(instId: string): Promise<InstrumentSpec> {
    const s = SPECS[instId];
    if (!s) throw new Error(`unknown instrument ${instId}`);
    return { instId, ...s };
  }

  async getSnapshot(instId: string): Promise<MarketSnapshot> {
    if (this.failSnapshot) throw new Error("market down");
    const spec = await this.getInstrument(instId);
    const bid = this.bids[instId] ?? "1";
    const ask = ceilToTick(toDecString(D(bid).mul(D(1).add(D(this.spreadPct).div(100)))), spec.tickSz);
    const now = this.clock.now();
    return { instId, bid, ask, last: bid, bidSz: "10", askSz: "10", exchTs: now, fetchedAt: now };
  }

  async getCandles(instId: string, _bar: "5m" | "15m" | "1H", limit: number): Promise<Candle[]> {
    const bid = this.bids[instId] ?? "1";
    const now = this.clock.now();
    return Array.from({ length: limit }, (_, i) => ({ ts: now - (limit - i) * 900_000, o: bid, h: bid, l: bid, c: bid, vol: "1", confirmed: true }));
  }

  async getBook(instId: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    const s = await this.getSnapshot(instId);
    return { bids: [[s.bid, "10"]], asks: [[s.ask, "10"]] };
  }

  async getTrades(instId: string, limit: number): Promise<{ px: string; sz: string; side: "buy" | "sell"; ts: number }[]> {
    const s = await this.getSnapshot(instId);
    return Array.from({ length: Math.min(limit, 5) }, (_, i) => ({ px: s.last, sz: "1", side: i % 2 ? "sell" : "buy", ts: s.fetchedAt - i * 1000 }));
  }
}
