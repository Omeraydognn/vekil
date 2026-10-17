// Seeded synthetic price series for fake mode (SPEC §8.1): deterministic, stateless, any instId.
// Price at minute m = base × (1 + slow wave + fast wave + noise), all in Decimal, rounded to the tick.
import { Decimal } from "decimal.js";
import { ceilToTick, floorToTick, toDecString } from "../shared/money.js";

const Dz = Decimal.clone({ precision: 24, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -30, toExpPos: 30 });

export interface SyntheticInstrument {
  instId: string;
  baseCcy: string;
  quoteCcy: string;
  basePx: string;
  tickSz: string;
  lotSz: string;
  minSz: string;
  /** Bid/ask distance in ticks; forcePrice keeps it. */
  spreadTicks: number;
  /** Relative amplitude of the waves, e.g. "0.02" = ±2 %. */
  amplitude: string;
}

/** Real TR specs from ATK_NOTES §4; prices near the discovery-time quotes. */
export const KNOWN_INSTRUMENTS: Record<string, SyntheticInstrument> = {
  "AVAX-TRY": { instId: "AVAX-TRY", baseCcy: "AVAX", quoteCcy: "TRY", basePx: "494.6", tickSz: "0.1", lotSz: "0.00001", minSz: "0.1", spreadTicks: 6, amplitude: "0.02" },
  "DOGE-TRY": { instId: "DOGE-TRY", baseCcy: "DOGE", quoteCcy: "TRY", basePx: "3.985", tickSz: "0.001", lotSz: "0.001", minSz: "10", spreadTicks: 7, amplitude: "0.03" },
  "BTC-TRY": { instId: "BTC-TRY", baseCcy: "BTC", quoteCcy: "TRY", basePx: "4034000", tickSz: "1", lotSz: "0.000000001", minSz: "0.0001", spreadTicks: 2600, amplitude: "0.015" },
};

/** FNV-1a 32-bit. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic uniform in [0, 1) as a Decimal (6 digits). */
export function unit(seed: number, ...parts: (string | number)[]): Decimal {
  return new Dz(hash32(`${seed}|${parts.join("|")}`) % 1_000_000).div(1_000_000);
}

export function instrumentFor(instId: string): SyntheticInstrument {
  const known = KNOWN_INSTRUMENTS[instId];
  if (known) return known;
  const [base = "X", quote = "TRY"] = instId.split("-");
  return { instId, baseCcy: base, quoteCcy: quote, basePx: "100", tickSz: "0.01", lotSz: "0.0001", minSz: "0.01", spreadTicks: 5, amplitude: "0.02" };
}

/** Mid price at an absolute minute index (epoch ms / 60 000), rounded to the tick. */
export function midAt(inst: SyntheticInstrument, seed: number, minute: number): string {
  const phase = new Dz(hash32(`${seed}|${inst.instId}`) % 10_000).div(1_000);
  const m = new Dz(minute);
  const slow = Dz.sin(m.div(240).add(phase)).mul("0.6");
  const fast = Dz.sin(m.div(37).add(phase.mul(2))).mul("0.3");
  const noise = unit(seed, inst.instId, minute).sub("0.5").mul("0.2");
  const rel = slow.add(fast).add(noise).mul(new Dz(inst.amplitude));
  const px = new Dz(inst.basePx).mul(new Dz(1).add(rel));
  return floorToTick(toDecString(px), inst.tickSz);
}

/** Bid/ask around a mid, keeping the instrument's spread (bid rounded down, ask = bid + spread). */
export function quoteAround(inst: SyntheticInstrument, mid: string): { bid: string; ask: string } {
  const spread = new Dz(inst.tickSz).mul(inst.spreadTicks);
  const bid = floorToTick(toDecString(new Dz(mid).sub(spread.div(2))), inst.tickSz);
  const ask = ceilToTick(toDecString(new Dz(bid).add(spread)), inst.tickSz);
  const minBid = new Dz(inst.tickSz);
  return new Dz(bid).lt(minBid) ? { bid: inst.tickSz, ask: toDecString(minBid.add(spread)) } : { bid, ask };
}

/** Base volume for one minute (lot-rounded). */
export function volumeAt(inst: SyntheticInstrument, seed: number, minute: number): string {
  const v = new Dz(inst.minSz).mul(unit(seed, "vol", inst.instId, minute).mul(20));
  return floorToTick(toDecString(v), inst.lotSz);
}
