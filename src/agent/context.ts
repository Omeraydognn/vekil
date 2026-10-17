// get_market_context (SPEC §10.3): BTC-TRY trend and 24h change, top-20 book imbalance, trade flow over the
// last 200 trades, and 24h volume vs its average. Pure computation plus a thin async wrapper.
import type { Clock, MarketData } from "../shared/interfaces.js";
import { D, Dc, toDecString } from "../shared/money.js";
import type { Candle } from "../shared/schemas.js";
import { isoIstanbul } from "../shared/time.js";
import { ema, fmt, IndicatorError, trendState } from "./indicators.js";

export const CONTEXT_PAIR = "BTC-TRY";
export const BOOK_DEPTH = 20;
export const TRADE_COUNT = 200;
/** 1H candles for the volume baseline: 7 days. */
export const VOLUME_HOURS = 168;

export interface MarketContext {
  instId: string;
  asOf: string;
  btc: { instId: string; bar: "1H"; state: "up" | "down" | "flat"; close: string; ema20: string; ema50: string; changePct24h: string } | null;
  book: { depth: number; bidVol: string; askVol: string; imbalance: string; note: string };
  tradeFlow: { trades: number; buyVol: string; sellVol: string; buySellRatio: string | null; note: string };
  volume: { vol24h: string; avg24h: string; ratio: string | null; days: number };
}

const sumDec = (xs: readonly string[]): string => toDecString(xs.reduce((a, x) => a.add(D(x)), new Dc(0)));
const ratio = (a: string, b: string): string | null =>
  D(b).isZero() ? null : toDecString(D(a).div(D(b)).toDecimalPlaces(2, Dc.ROUND_HALF_UP));

export function btcTrend(candles: readonly Candle[]): MarketContext["btc"] {
  const cs = candles.filter((c) => c.confirmed);
  if (cs.length < 50) return null;
  const closes = cs.map((c) => Number(c.c));
  const close = closes[closes.length - 1] as number;
  const e20 = ema(closes, 20)[closes.length - 1] as number;
  const e50 = ema(closes, 50)[closes.length - 1] as number;
  const ref = closes[Math.max(0, closes.length - 25)] as number;
  return {
    instId: CONTEXT_PAIR,
    bar: "1H",
    state: trendState(close, e20, e50),
    close: fmt(close, 2),
    ema20: fmt(e20, 2),
    ema50: fmt(e50, 2),
    changePct24h: fmt(((close - ref) / ref) * 100, 2),
  };
}

/** Bid volume / ask volume over the top `depth` levels. > 1 means more resting buy interest. */
export function bookImbalance(book: { bids: [string, string][]; asks: [string, string][] }, depth = BOOK_DEPTH): MarketContext["book"] {
  const bidVol = sumDec(book.bids.slice(0, depth).map(([, sz]) => sz));
  const askVol = sumDec(book.asks.slice(0, depth).map(([, sz]) => sz));
  const r = ratio(bidVol, askVol);
  return { depth, bidVol, askVol, imbalance: r ?? "0", note: "bidVol / askVol over the top levels; > 1 = more buy interest" };
}

export function tradeFlow(trades: readonly { sz: string; side: "buy" | "sell" }[]): MarketContext["tradeFlow"] {
  const ts = trades.slice(0, TRADE_COUNT);
  const buyVol = sumDec(ts.filter((t) => t.side === "buy").map((t) => t.sz));
  const sellVol = sumDec(ts.filter((t) => t.side === "sell").map((t) => t.sz));
  return { trades: ts.length, buyVol, sellVol, buySellRatio: ratio(buyVol, sellVol), note: "taker buy volume / taker sell volume" };
}

/** Last-24h volume vs the average 24h volume over the 1H candles given (oldest first). */
export function volumeVsAverage(hourly: readonly Candle[]): MarketContext["volume"] {
  const cs = hourly.filter((c) => c.confirmed);
  if (cs.length < 24) throw new IndicatorError(`need ≥ 24 confirmed 1H candles, got ${cs.length}`);
  const vol24h = sumDec(cs.slice(-24).map((c) => c.vol));
  const days = cs.length / 24;
  const avg24h = toDecString(D(sumDec(cs.map((c) => c.vol))).div(days).toDecimalPlaces(8, Dc.ROUND_HALF_UP));
  return { vol24h, avg24h, ratio: ratio(vol24h, avg24h), days: Math.round(days * 100) / 100 };
}

export interface ContextInput {
  instId: string;
  now: number;
  btcCandles: readonly Candle[] | null;
  book: { bids: [string, string][]; asks: [string, string][] };
  trades: readonly { sz: string; side: "buy" | "sell" }[];
  hourly: readonly Candle[];
}

export function computeMarketContext(input: ContextInput): MarketContext {
  return {
    instId: input.instId,
    asOf: isoIstanbul(input.now),
    btc: input.btcCandles ? btcTrend(input.btcCandles) : null,
    book: bookImbalance(input.book),
    tradeFlow: tradeFlow(input.trades),
    volume: volumeVsAverage(input.hourly),
  };
}

/** Builds AgentDeps.marketContext. A failed BTC-TRY read degrades to `btc: null`; the rest must succeed. */
export function makeMarketContextFn(opts: { market: MarketData; clock: Clock }): (instId: string) => Promise<MarketContext> {
  return async (instId) => {
    const [btcCandles, book, trades, hourly] = await Promise.all([
      opts.market.getCandles(CONTEXT_PAIR, "1H", 100).catch(() => null),
      opts.market.getBook(instId, BOOK_DEPTH),
      opts.market.getTrades(instId, TRADE_COUNT),
      opts.market.getCandles(instId, "1H", VOLUME_HOURS),
    ]);
    return computeMarketContext({ instId, now: opts.clock.now(), btcCandles, book, trades, hourly });
  };
}
