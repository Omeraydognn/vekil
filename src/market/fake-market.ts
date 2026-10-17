// FakeMarket: seeded synthetic MarketData for fake mode and tests (any instId; AVAX-TRY, <R1_PAIR> = DOGE-TRY and
// BTC-TRY use their real TR specs). Time comes from the injected Clock. forcePrice() pins the mid and keeps the spread.
import type { Bar, Clock, MarketData } from "../shared/interfaces.js";
import { decAdd, decMax, decMin, decMul, decSub } from "../shared/money.js";
import type { Candle, Dec, InstrumentSpec, MarketSnapshot, Ms } from "../shared/schemas.js";
import { instrumentFor, midAt, quoteAround, unit, volumeAt, type SyntheticInstrument } from "./synthetic.js";

const MINUTE = 60_000;
const BAR_MIN: Record<Bar, number> = { "5m": 5, "15m": 15, "1H": 60 };

export class MarketDataError extends Error {
  override name = "MarketDataError";
}

export class FakeMarket implements MarketData {
  private readonly forced = new Map<string, { mid: string; fromMinute: number }>();
  private readonly failing = new Set<string>();
  private readonly states = new Map<string, string>();

  constructor(
    private readonly clock: Clock,
    private readonly seed = 42,
  ) {}

  // ------------------------------------------------------------ test/demo hooks
  /** Pin the mid price from now on; bid/ask keep the instrument's spread. */
  forcePrice(instId: string, mid: string): void {
    this.forced.set(instId, { mid, fromMinute: Math.floor(this.clock.now() / MINUTE) });
  }
  clearForcedPrice(instId: string): void {
    this.forced.delete(instId);
  }
  /** Every call for this instId throws until cleared (ticker outage). */
  setFailing(instId: string, failing: boolean): void {
    if (failing) this.failing.add(instId);
    else this.failing.delete(instId);
  }
  setInstrumentState(instId: string, state: string): void {
    this.states.set(instId, state);
  }

  // ------------------------------------------------------------ MarketData
  async getInstrument(instId: string): Promise<InstrumentSpec> {
    this.check(instId);
    const i = instrumentFor(instId);
    return { instId, baseCcy: i.baseCcy, quoteCcy: i.quoteCcy, tickSz: i.tickSz, lotSz: i.lotSz, minSz: i.minSz, state: this.states.get(instId) ?? "live" };
  }

  async getSnapshot(instId: string): Promise<MarketSnapshot> {
    this.check(instId);
    const now = this.clock.now();
    const inst = instrumentFor(instId);
    const mid = this.mid(inst, Math.floor(now / MINUTE));
    const { bid, ask } = quoteAround(inst, mid);
    return { instId, bid, ask, last: mid, bidSz: this.size(inst, "bidSz", now), askSz: this.size(inst, "askSz", now), exchTs: now, fetchedAt: now };
  }

  async getCandles(instId: string, bar: Bar, limit: number): Promise<Candle[]> {
    this.check(instId);
    const inst = instrumentFor(instId);
    const len = BAR_MIN[bar];
    const nowMin = Math.floor(this.clock.now() / MINUTE);
    const currentStart = Math.floor(nowMin / len) * len;
    const out: Candle[] = [];
    // Confirmed candles only (the open one is excluded), oldest first.
    for (let k = Math.max(0, Math.floor(limit)); k >= 1; k--) {
      const start = currentStart - k * len;
      const pxs: string[] = [];
      let vol = "0";
      for (let m = start; m < start + len; m++) {
        pxs.push(this.mid(inst, m));
        vol = decAdd(vol, volumeAt(inst, this.seed, m));
      }
      out.push({ ts: start * MINUTE, o: pxs[0]!, h: decMax(...pxs), l: decMin(...pxs), c: pxs[pxs.length - 1]!, vol, confirmed: true });
    }
    return out;
  }

  async getBook(instId: string, depth: number): Promise<{ bids: [Dec, Dec][]; asks: [Dec, Dec][] }> {
    const snap = await this.getSnapshot(instId);
    const inst = instrumentFor(instId);
    const bids: [Dec, Dec][] = [];
    const asks: [Dec, Dec][] = [];
    const n = Math.max(1, Math.min(400, Math.floor(depth)));
    for (let k = 0; k < n; k++) {
      const off = decMul(inst.tickSz, String(k));
      const b = decSub(snap.bid, off);
      if (!b.startsWith("-") && b !== "0") bids.push([b, this.size(inst, `b${k}`, snap.exchTs)]);
      asks.push([decAdd(snap.ask, off), this.size(inst, `a${k}`, snap.exchTs)]);
    }
    return { bids, asks };
  }

  /** Recent trades, newest first (like OKX). */
  async getTrades(instId: string, limit: number): Promise<{ px: Dec; sz: Dec; side: "buy" | "sell"; ts: Ms }[]> {
    const snap = await this.getSnapshot(instId);
    const inst = instrumentFor(instId);
    const n = Math.max(0, Math.min(500, Math.floor(limit)));
    const out: { px: Dec; sz: Dec; side: "buy" | "sell"; ts: Ms }[] = [];
    const nowMin = Math.floor(snap.exchTs / MINUTE);
    for (let k = 0; k < n; k++) {
      const m = nowMin - Math.floor(k / 2);
      const { bid, ask } = quoteAround(inst, this.mid(inst, m));
      const side = unit(this.seed, "side", instId, m, k).lt("0.5") ? "buy" : "sell";
      const ts = m * MINUTE + (k % 2 === 0 ? 30_000 : 10_000);
      out.push({ px: side === "buy" ? ask : bid, sz: this.size(inst, `t${k}`, ts), side, ts: Math.min(ts, snap.exchTs) });
    }
    return out;
  }

  // ------------------------------------------------------------ internals
  private check(instId: string): void {
    if (this.failing.has(instId)) throw new MarketDataError(`fake market outage for ${instId}`);
  }
  private mid(inst: SyntheticInstrument, minute: number): string {
    const f = this.forced.get(inst.instId);
    return f && minute >= f.fromMinute ? f.mid : midAt(inst, this.seed, minute);
  }
  private size(inst: SyntheticInstrument, tag: string, ts: number): Dec {
    return volumeAt(inst, this.seed + hashTag(tag), Math.floor(ts / 1000));
  }
}

function hashTag(tag: string): number {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) % 100_000;
  return h;
}
