// get_indicators (SPEC §22.2). The math is a pure function over confirmed candles; floats are allowed here
// and every output is rounded to a string. Suggested levels use Decimal and the ON-CHAIN policy.
import type { Bar, Clock, MarketData } from "../shared/interfaces.js";
import { ceilToTick, D, decSub, Dc, floorToTick, toDecString } from "../shared/money.js";
import type { Candle, Policy } from "../shared/schemas.js";
import { isoIstanbul } from "../shared/time.js";

export type StrategyProfile = "standard" | "active";

export const PROFILE_BARS: Record<StrategyProfile, { trend: Bar; entry: Bar }> = {
  standard: { trend: "1H", entry: "15m" },
  active: { trend: "15m", entry: "5m" },
};
export const BARS_PER_24H: Record<Bar, number> = { "1H": 24, "15m": 96, "5m": 288 };
/** Candle counts fetched per timeframe: enough for EMA50 / Wilder warm-up plus a 24h window. */
export const FETCH_LIMIT: Record<Bar, number> = { "1H": 100, "15m": 200, "5m": 300 };

export class IndicatorError extends Error {
  override name = "IndicatorError";
}

// ---------------------------------------------------------------- primitives

/** Standard EMA seeded with the SMA of the first `period` values. NaN before the seed. */
export function ema(values: readonly number[], period: number): number[] {
  const out: number[] = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (values[i] as number) * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder RSI. NaN until `period` changes are available. */
export function rsiWilder(closes: readonly number[], period = 14): number[] {
  const out: number[] = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = (closes[i] as number) - (closes[i - 1] as number);
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const rsi = (g: number, l: number): number => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[period] = rsi(gain, loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = (closes[i] as number) - (closes[i - 1] as number);
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = rsi(gain, loss);
  }
  return out;
}

export interface Hlc {
  h: number;
  l: number;
  c: number;
}

/** Wilder ATR: the first value is the SMA of the first `period` true ranges (from the 2nd candle). */
export function atrWilder(candles: readonly Hlc[], period = 14): number[] {
  const out: number[] = new Array<number>(candles.length).fill(NaN);
  if (candles.length <= period) return out;
  const tr = (i: number): number => {
    const c = candles[i] as Hlc;
    const pc = (candles[i - 1] as Hlc).c;
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  };
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += tr(i);
  atr /= period;
  out[period] = atr;
  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + tr(i)) / period;
    out[i] = atr;
  }
  return out;
}

// ---------------------------------------------------------------- formatting

/** Number of decimals in a tick size ("0.1" → 1, "1" → 0). */
export function decimalsOf(step: string): number {
  const i = step.indexOf(".");
  return i < 0 ? 0 : step.length - i - 1;
}

/** Round a float to `dp` decimals and print it as a plain decimal string. */
export function fmt(n: number, dp: number): string {
  if (!Number.isFinite(n)) throw new IndicatorError(`not a finite number: ${n}`);
  return toDecString(new Dc(n).toDecimalPlaces(dp, Dc.ROUND_HALF_UP));
}

const num = (s: string): number => Number(s);
const last = <T>(xs: readonly T[]): T => {
  const v = xs[xs.length - 1];
  if (v === undefined) throw new IndicatorError("empty series");
  return v;
};

/** Trend state per §22.2: up if EMA20 > EMA50 and close > EMA50; down if both below; otherwise flat. */
export function trendState(close: number, ema20: number, ema50: number): "up" | "down" | "flat" {
  if (ema20 > ema50 && close > ema50) return "up";
  if (ema20 < ema50 && close < ema50) return "down";
  return "flat";
}

// ---------------------------------------------------------------- suggested levels

export interface SuggestedLevels {
  entryPx: string;
  stopPx: string;
  tpPx: string;
  stopDistancePct: string;
}

/** Stop distance in percent of px, at full precision. */
export function stopDistancePct(px: string, stopPx: string): string {
  return toDecString(D(decSub(px, stopPx)).div(D(px)).mul(100));
}

/**
 * §22.2: entryPx = ceilToTick(ask × 1.001); stopPx = floorToTick(entryPx − 1.5 × ATR) with its distance clamped to
 * [minStop + 0.05, maxStop − 0.05] % of the on-chain policy; tpPx = ceilToTick(entryPx + 2 × (entryPx − stopPx)).
 * If tick rounding pushes the distance outside [minStop, maxStop], the stop is rounded the other way.
 */
export function suggestLevels(
  ask: string,
  atr: string,
  tickSz: string,
  policy: Pick<Policy, "minStopDistancePct" | "maxStopDistancePct">,
): SuggestedLevels {
  const entryPx = ceilToTick(toDecString(D(ask).mul("1.001")), tickSz);
  const min = D(policy.minStopDistancePct);
  const max = D(policy.maxStopDistancePct);
  let lo = min.add("0.05");
  let hi = max.sub("0.05");
  if (lo.gt(hi)) lo = hi = min.add(max).div(2);
  const rawDist = D(atr).mul("1.5").div(D(entryPx)).mul(100);
  const dist = Dc.min(Dc.max(rawDist, lo), hi);
  const target = toDecString(D(entryPx).mul(new Dc(1).sub(dist.div(100))));
  let stopPx = floorToTick(target, tickSz);
  const inside = (s: string): boolean => {
    if (D(s).lte(0)) return false;
    const d = D(stopDistancePct(entryPx, s));
    return d.gte(min) && d.lte(max);
  };
  if (!inside(stopPx)) {
    const up = ceilToTick(target, tickSz);
    if (inside(up)) stopPx = up;
  }
  const tpPx = ceilToTick(toDecString(D(entryPx).add(D(entryPx).sub(D(stopPx)).mul(2))), tickSz);
  return {
    entryPx,
    stopPx,
    tpPx,
    stopDistancePct: toDecString(D(stopDistancePct(entryPx, stopPx)).toDecimalPlaces(2, Dc.ROUND_HALF_UP)),
  };
}

// ---------------------------------------------------------------- the get_indicators output

export interface IndicatorsInput {
  instId: string;
  profile: StrategyProfile;
  now: number;
  tickSz: string;
  bid: string;
  ask: string;
  /** Confirmed candles, oldest first. */
  trend: readonly Candle[];
  entry: readonly Candle[];
  policy: Pick<Policy, "minStopDistancePct" | "maxStopDistancePct">;
}

export interface Indicators {
  instId: string;
  asOf: string;
  profile: StrategyProfile;
  tickSz: string;
  bid: string;
  ask: string;
  spreadPct: string;
  trend: { bar: Bar; close: string; ema20: string; ema50: string; state: "up" | "down" | "flat"; changePct24h: string };
  entry: {
    bar: Bar;
    close: string;
    ema20: string;
    rsi14: string;
    atr14: string;
    atrPct: string;
    atrPctAvg24h: string;
    rangeHigh24h: string;
    rangeLow24h: string;
    last8: [string, string, string, string, string][];
  };
  suggested: SuggestedLevels;
}

const hhmm = (ms: number): string => isoIstanbul(ms).slice(11, 16);

export function computeIndicators(input: IndicatorsInput): Indicators {
  const bars = PROFILE_BARS[input.profile];
  const trend = input.trend.filter((c) => c.confirmed);
  const entry = input.entry.filter((c) => c.confirmed);
  if (trend.length < 50) throw new IndicatorError(`need ≥ 50 confirmed ${bars.trend} candles, got ${trend.length}`);
  if (entry.length < 21) throw new IndicatorError(`need ≥ 21 confirmed ${bars.entry} candles, got ${entry.length}`);
  const pxDp = decimalsOf(input.tickSz);

  const tCloses = trend.map((c) => num(c.c));
  const tClose = last(tCloses);
  const tEma20 = last(ema(tCloses, 20));
  const tEma50 = last(ema(tCloses, 50));
  const tBack = BARS_PER_24H[bars.trend];
  const tRef = tCloses[Math.max(0, tCloses.length - 1 - tBack)] as number;

  const eCloses = entry.map((c) => num(c.c));
  const eHlc = entry.map((c) => ({ h: num(c.h), l: num(c.l), c: num(c.c) }));
  const atrSeries = atrWilder(eHlc, 14);
  const atr = last(atrSeries);
  const eClose = last(eCloses);
  const n24 = BARS_PER_24H[bars.entry];
  const window = entry.slice(-n24);
  const atrPcts = atrSeries
    .map((a, i) => (Number.isFinite(a) ? (a / (eCloses[i] as number)) * 100 : NaN))
    .slice(-n24)
    .filter(Number.isFinite);
  const atrPctAvg = atrPcts.reduce((a, b) => a + b, 0) / atrPcts.length;

  const mid = D(input.bid).add(D(input.ask)).div(2);
  const spreadPct = toDecString(D(input.ask).sub(D(input.bid)).div(mid).mul(100).toDecimalPlaces(2, Dc.ROUND_HALF_UP));
  // The ATR string feeds Decimal math for the suggested levels: keep extra precision.
  const atrStr = fmt(atr, pxDp + 4);

  return {
    instId: input.instId,
    asOf: isoIstanbul(input.now),
    profile: input.profile,
    tickSz: input.tickSz,
    bid: input.bid,
    ask: input.ask,
    spreadPct,
    trend: {
      bar: bars.trend,
      close: fmt(tClose, pxDp),
      ema20: fmt(tEma20, pxDp),
      ema50: fmt(tEma50, pxDp),
      state: trendState(tClose, tEma20, tEma50),
      changePct24h: fmt(((tClose - tRef) / tRef) * 100, 2),
    },
    entry: {
      bar: bars.entry,
      close: fmt(eClose, pxDp),
      ema20: fmt(last(ema(eCloses, 20)), pxDp),
      rsi14: fmt(last(rsiWilder(eCloses, 14)), 1),
      atr14: fmt(atr, pxDp),
      atrPct: fmt((atr / eClose) * 100, 2),
      atrPctAvg24h: fmt(atrPctAvg, 2),
      rangeHigh24h: fmt(Math.max(...window.map((c) => num(c.h))), pxDp),
      rangeLow24h: fmt(Math.min(...window.map((c) => num(c.l))), pxDp),
      last8: entry.slice(-8).map((c) => [hhmm(c.ts), c.o, c.h, c.l, c.c]),
    },
    suggested: suggestLevels(input.ask, atrStr, input.tickSz, input.policy),
  };
}

/** Builds AgentDeps.indicators: fresh market reads + the current on-chain policy. */
export function makeIndicatorsFn(opts: {
  market: MarketData;
  /** The on-chain policy (from readView()). */
  policy: () => Promise<Pick<Policy, "minStopDistancePct" | "maxStopDistancePct">>;
  profile: StrategyProfile;
  clock: Clock;
}): (instId: string) => Promise<Indicators> {
  return async (instId) => {
    const bars = PROFILE_BARS[opts.profile];
    const [spec, snap, trend, entry, policy] = await Promise.all([
      opts.market.getInstrument(instId),
      opts.market.getSnapshot(instId),
      opts.market.getCandles(instId, bars.trend, FETCH_LIMIT[bars.trend]),
      opts.market.getCandles(instId, bars.entry, FETCH_LIMIT[bars.entry]),
      opts.policy(),
    ]);
    return computeIndicators({
      instId,
      profile: opts.profile,
      now: opts.clock.now(),
      tickSz: spec.tickSz,
      bid: snap.bid,
      ask: snap.ask,
      trend,
      entry,
      policy,
    });
  };
}
