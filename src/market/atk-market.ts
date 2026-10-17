// AtkMarket: MarketData over the read-only ATK instance (core's, or the paper executor's). Tool names: ATK_NOTES §2.
// Every response is validated; "" prices (empty book) are rejected as missing data, never coerced.
import type { Bar, Clock, MarketData } from "../shared/interfaces.js";
import type { Candle, Dec, InstrumentSpec, MarketSnapshot, Ms } from "../shared/schemas.js";
import { OkxBookRow, OkxCandleRow, OkxInstrumentRow, OkxTickerRow, OkxTradeRow, rows } from "../atk/parse.js";
import { MarketDataError } from "./fake-market.js";

/** The slice of AtkClient that market data needs. */
export interface AtkDataSource {
  callData(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export const SPEC_CACHE_MS = 5 * 60_000;

export class AtkMarket implements MarketData {
  private readonly specs = new Map<string, { spec: InstrumentSpec; at: Ms }>();

  constructor(
    private readonly atk: AtkDataSource,
    private readonly clock: Clock,
  ) {}

  async getInstrument(instId: string): Promise<InstrumentSpec> {
    const cached = this.specs.get(instId);
    if (cached && this.clock.now() - cached.at < SPEC_CACHE_MS) return cached.spec;
    const tool = "market_get_instruments";
    const r = rows(tool, await this.atk.callData(tool, { instType: "SPOT", instId }), OkxInstrumentRow).find((x) => x.instId === instId);
    if (!r) throw new MarketDataError(`${instId}: instrument not found`);
    const spec: InstrumentSpec = { instId, baseCcy: r.baseCcy, quoteCcy: r.quoteCcy, tickSz: r.tickSz, lotSz: r.lotSz, minSz: r.minSz, state: r.state };
    this.specs.set(instId, { spec, at: this.clock.now() });
    return spec;
  }

  async getSnapshot(instId: string): Promise<MarketSnapshot> {
    const tool = "market_get_ticker";
    const t = rows(tool, await this.atk.callData(tool, { instId }), OkxTickerRow)[0];
    if (!t || t.instId !== instId) throw new MarketDataError(`${instId}: no ticker`);
    return { instId, bid: t.bidPx, ask: t.askPx, last: t.last, bidSz: t.bidSz, askSz: t.askSz, exchTs: msOf(t.ts), fetchedAt: this.clock.now() };
  }

  async getCandles(instId: string, bar: Bar, limit: number): Promise<Candle[]> {
    const tool = "market_get_candles";
    const n = Math.max(1, Math.min(300, Math.floor(limit)));
    const data = rows(tool, await this.atk.callData(tool, { instId, bar, limit: n + 1 }), OkxCandleRow);
    // OKX: newest first; confirm "0" = the open candle. Keep confirmed, oldest first.
    const out = data
      .filter((c) => c[8] === "1")
      .map((c): Candle => ({ ts: msOf(c[0]), o: c[1], h: c[2], l: c[3], c: c[4], vol: c[5], confirmed: true }))
      .sort((a, b) => a.ts - b.ts);
    return out.slice(-n);
  }

  async getBook(instId: string, depth: number): Promise<{ bids: [Dec, Dec][]; asks: [Dec, Dec][] }> {
    const tool = "market_get_orderbook";
    const b = rows(tool, await this.atk.callData(tool, { instId, sz: Math.max(1, Math.min(400, Math.floor(depth))) }), OkxBookRow)[0];
    if (!b) throw new MarketDataError(`${instId}: no order book`);
    return { bids: b.bids.map((l) => [l[0], l[1]]), asks: b.asks.map((l) => [l[0], l[1]]) };
  }

  /** Recent trades, newest first (as OKX returns them). */
  async getTrades(instId: string, limit: number): Promise<{ px: Dec; sz: Dec; side: "buy" | "sell"; ts: Ms }[]> {
    const tool = "market_get_trades";
    const data = rows(tool, await this.atk.callData(tool, { instId, limit: Math.max(1, Math.min(500, Math.floor(limit))) }), OkxTradeRow);
    return data.map((t) => ({ px: t.px, sz: t.sz, side: t.side, ts: msOf(t.ts) }));
  }
}

function msOf(s: string): Ms {
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new MarketDataError(`bad timestamp ${s}`);
  return n;
}
