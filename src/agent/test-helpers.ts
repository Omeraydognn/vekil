// Test fixtures shared by the agent tests (not a test file itself).
import type { Bar, MarketData } from "../shared/interfaces.js";
import type { Candle, InstrumentSpec, MarketSnapshot } from "../shared/schemas.js";

export const T0 = Date.parse("2026-10-17T08:05:00Z"); // 11:05 Istanbul
export const BAR_MS: Record<Bar, number> = { "5m": 300_000, "15m": 900_000, "1H": 3_600_000 };

/** Deterministic candles: a gentle sine around a drift, oldest first, all confirmed. */
export function makeCandles(n: number, bar: Bar, opts: { start?: number; drift?: number; amp?: number; endTs?: number } = {}): Candle[] {
  const start = opts.start ?? 480;
  const drift = opts.drift ?? 0.05;
  const amp = opts.amp ?? 2;
  const endTs = opts.endTs ?? T0 - BAR_MS[bar];
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const base = start + drift * i + amp * Math.sin(i / 3);
    const o = base;
    const c = base + 0.3 * Math.cos(i / 2);
    const h = Math.max(o, c) + 0.6;
    const l = Math.min(o, c) - 0.6;
    const f = (x: number): string => x.toFixed(1);
    out.push({ ts: endTs - (n - 1 - i) * BAR_MS[bar], o: f(o), h: f(h), l: f(l), c: f(c), vol: (100 + (i % 7) * 10).toString(), confirmed: true });
  }
  return out;
}

export interface FakeMarketOpts {
  ask?: string;
  bid?: string;
  tickSz?: string;
}

/** Minimal in-memory MarketData for agent tests. */
export function fakeMarket(opts: FakeMarketOpts = {}): MarketData & { calls: string[] } {
  const calls: string[] = [];
  const bid = opts.bid ?? "494.1";
  const ask = opts.ask ?? "494.7";
  const tickSz = opts.tickSz ?? "0.1";
  return {
    calls,
    async getInstrument(instId): Promise<InstrumentSpec> {
      calls.push(`spec:${instId}`);
      return { instId, baseCcy: instId.split("-")[0] ?? "", quoteCcy: "TRY", tickSz, lotSz: "0.00001", minSz: "0.01", state: "live" };
    },
    async getSnapshot(instId): Promise<MarketSnapshot> {
      calls.push(`snap:${instId}`);
      return { instId, bid, ask, last: bid, bidSz: "10", askSz: "12", exchTs: T0, fetchedAt: T0 };
    },
    async getCandles(instId, bar, limit): Promise<Candle[]> {
      calls.push(`candles:${instId}:${bar}:${limit}`);
      return makeCandles(limit, bar);
    },
    async getBook(instId, depth) {
      calls.push(`book:${instId}:${depth}`);
      const bids: [string, string][] = Array.from({ length: depth }, (_, i) => [(494.1 - i * 0.1).toFixed(1), "2"]);
      const asks: [string, string][] = Array.from({ length: depth }, (_, i) => [(494.7 + i * 0.1).toFixed(1), "1"]);
      return { bids, asks };
    },
    async getTrades(instId, limit) {
      calls.push(`trades:${instId}:${limit}`);
      return Array.from({ length: limit }, (_, i) => ({ px: "494.5", sz: "1", side: i % 4 === 0 ? ("sell" as const) : ("buy" as const), ts: T0 - i * 1000 }));
    },
  };
}
