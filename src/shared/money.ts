// Decimal money helpers. String in, string out; on-chain amounts are exact ×1e8 integers.
import { Decimal } from "decimal.js";

export const Dc = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -60, toExpPos: 60 });
export type Dc = Decimal;

export const SCALE_DECIMALS = 8;
export const SCALE = 100_000_000n;
export const UINT64_MAX = (1n << 64n) - 1n;
export const INT64_MAX = (1n << 63n) - 1n;
export const INT64_MIN = -(1n << 63n);

const DEC_RE = /^\d+(\.\d+)?$/;
const SDEC_RE = /^-?\d+(\.\d+)?$/;
const PCT2_RE = /^\d+(\.\d{1,2})?$/;

export class MoneyError extends Error {
  override name = "MoneyError";
}

/** Money never goes through Number: strings or Decimal only. */
export function D(x: string | Decimal): Decimal {
  if (typeof x === "string" && !SDEC_RE.test(x)) throw new MoneyError(`not a decimal string: ${JSON.stringify(x)}`);
  return new Dc(x);
}

/** Plain decimal string without exponent and without trailing zeros ("494.70" → "494.7"). */
export function toDecString(x: Decimal): string {
  const s = x.toFixed();
  if (!s.includes(".")) return s === "-0" ? "0" : s;
  const t = s.replace(/0+$/, "").replace(/\.$/, "");
  return t === "-0" ? "0" : t;
}

function decimalPlaces(s: string): number {
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}

/** Exact ×1e8 scaling for non-negative Dec strings. Throws on > 8 dp, negatives or > uint64. */
export function toScaled(dec: string): bigint {
  if (!DEC_RE.test(dec)) throw new MoneyError(`toScaled: not a non-negative decimal: ${JSON.stringify(dec)}`);
  if (decimalPlaces(dec) > SCALE_DECIMALS) throw new MoneyError(`toScaled: more than 8 decimals: ${dec}`);
  const [int = "0", frac = ""] = dec.split(".");
  const v = BigInt(int) * SCALE + BigInt(frac.padEnd(SCALE_DECIMALS, "0") || "0");
  if (v > UINT64_MAX) throw new MoneyError(`toScaled: above uint64 max: ${dec}`);
  return v;
}

/** Signed ×1e8 scaling: rounds toward zero to 8 dp, then checks the int64 range. */
export function toScaledSigned(sdec: string): bigint {
  if (!SDEC_RE.test(sdec)) throw new MoneyError(`toScaledSigned: not a decimal: ${JSON.stringify(sdec)}`);
  const neg = sdec.startsWith("-");
  const abs = neg ? sdec.slice(1) : sdec;
  const [int = "0", frac = ""] = abs.split(".");
  const mag = BigInt(int) * SCALE + BigInt(frac.slice(0, SCALE_DECIMALS).padEnd(SCALE_DECIMALS, "0") || "0");
  const v = neg ? -mag : mag;
  if (v > INT64_MAX || v < INT64_MIN) throw new MoneyError(`toScaledSigned: outside int64: ${sdec}`);
  return v;
}

/** Inverse of toScaled / toScaledSigned. Accepts a bigint or an integer string. */
export function fromScaled(v: bigint | string): string {
  const n = typeof v === "bigint" ? v : BigInt(v);
  const neg = n < 0n;
  const mag = neg ? -n : n;
  const int = mag / SCALE;
  const frac = (mag % SCALE).toString().padStart(SCALE_DECIMALS, "0").replace(/0+$/, "");
  const s = frac ? `${int}.${frac}` : `${int}`;
  return neg && s !== "0" ? `-${s}` : s;
}

/** "0.3" → 30 bps. Pct2 must be > 0 with at most 2 decimals; throws otherwise. */
export function pct2ToBps(pct: string): number {
  if (!PCT2_RE.test(pct)) throw new MoneyError(`pct2ToBps: not a Pct2: ${JSON.stringify(pct)}`);
  const bps = D(pct).mul("100");
  if (!bps.isInteger() || bps.lte(0)) throw new MoneyError(`pct2ToBps: must be > 0: ${pct}`);
  if (bps.gt(Number.MAX_SAFE_INTEGER)) throw new MoneyError(`pct2ToBps: too large: ${pct}`);
  return bps.toNumber();
}

export function bpsToPct2(bps: number): string {
  if (!Number.isSafeInteger(bps) || bps <= 0) throw new MoneyError(`bpsToPct2: must be a positive integer: ${bps}`);
  return toDecString(new Dc(bps).div(100));
}

function step(x: string, unit: string, mode: Decimal.Rounding): string {
  const u = D(unit);
  if (u.lte(0)) throw new MoneyError(`step must be > 0: ${unit}`);
  return toDecString(D(x).div(u).toDecimalPlaces(0, mode).mul(u));
}

/** Round a price up to a multiple of tickSz (buys). */
export const ceilToTick = (px: string, tickSz: string): string => step(px, tickSz, Decimal.ROUND_CEIL);
/** Round a price down to a multiple of tickSz (stops). */
export const floorToTick = (px: string, tickSz: string): string => step(px, tickSz, Decimal.ROUND_FLOOR);
/** Round a size down to a multiple of lotSz. */
export const floorToLot = (sz: string, lotSz: string): string => step(sz, lotSz, Decimal.ROUND_FLOOR);
/** Round toward zero to 8 decimals: sizes without a spec, and signed amounts such as PnL. */
export const round8Down = (x: string): string => toDecString(D(x).toDecimalPlaces(SCALE_DECIMALS, Decimal.ROUND_DOWN));

export const decAdd = (a: string, b: string): string => toDecString(D(a).add(D(b)));
export const decSub = (a: string, b: string): string => toDecString(D(a).sub(D(b)));
export const decMul = (a: string, b: string): string => toDecString(D(a).mul(D(b)));
/** Division at full precision; callers round explicitly. */
export const decDiv = (a: string, b: string): string => toDecString(D(a).div(D(b)));
export const decCmp = (a: string, b: string): -1 | 0 | 1 => D(a).cmp(D(b)) as -1 | 0 | 1;
export const decGt = (a: string, b: string): boolean => D(a).gt(D(b));
export const decGte = (a: string, b: string): boolean => D(a).gte(D(b));
export const decLt = (a: string, b: string): boolean => D(a).lt(D(b));
export const decLte = (a: string, b: string): boolean => D(a).lte(D(b));
export const decEq = (a: string, b: string): boolean => D(a).eq(D(b));
export const decMin = (...xs: string[]): string => toDecString(Dc.min(...xs.map((x) => D(x))));
export const decMax = (...xs: string[]): string => toDecString(Dc.max(...xs.map((x) => D(x))));
export const pctOf = (x: string, pct: string): string => toDecString(D(x).mul(D(pct)).div(100));
export const decAbs = (a: string): string => toDecString(D(a).abs());
export const isZero = (a: string): boolean => D(a).isZero();

// Hard caps (SPEC §9.1). The contract has the same immutables, set at deploy time.
export const HARD_MAX_ORDER_QUOTE = "1000";
export const HARD_MAX_DAILY_RISK = "500";
export const HARD_MAX_ORDER_QUOTE_SCALED = 100_000_000_000n;
export const HARD_MAX_DAILY_RISK_SCALED = 50_000_000_000n;
