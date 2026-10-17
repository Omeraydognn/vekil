// Time helpers. ms off-chain, seconds on-chain. Turkey is UTC+3 all year (no DST since 2016),
// which is what the contract's (ts + 10800) buckets assume.
import type { Clock } from "./interfaces.js";

export const TZ = "Europe/Istanbul";
export const TRT_OFFSET_SEC = 10_800;
const TRT_OFFSET_MS = TRT_OFFSET_SEC * 1000;
const DAY_MS = 86_400_000;

export const msToSec = (ms: number): number => Math.floor(ms / 1000);
export const secToMs = (sec: number): number => sec * 1000;
export const isWholeSecond = (ms: number): boolean => Number.isSafeInteger(ms) && ms % 1000 === 0;

/** Contract bucket: hourIndex = (ts + 10800) / 3600. */
export const hourIndex = (sec: number): number => Math.floor((sec + TRT_OFFSET_SEC) / 3600);
/** Contract bucket: dayIndex = (ts + 10800) / 86400. */
export const dayIndex = (sec: number): number => Math.floor((sec + TRT_OFFSET_SEC) / 86_400);

/** "YYYY-MM-DD" in Europe/Istanbul. */
export function dayKey(ms: number): string {
  return new Date(ms + TRT_OFFSET_MS).toISOString().slice(0, 10);
}

/** 23:59:59.000 Europe/Istanbul of the day containing ms (a whole second). */
export function endOfDayIstanbul(ms: number): number {
  const startOfDay = Math.floor((ms + TRT_OFFSET_MS) / DAY_MS) * DAY_MS - TRT_OFFSET_MS;
  return startOfDay + DAY_MS - 1000;
}

/** ISO 8601 with +03:00, e.g. "2026-10-17T11:05:00+03:00". */
export function isoIstanbul(ms: number): string {
  return new Date(ms + TRT_OFFSET_MS).toISOString().slice(0, 19) + "+03:00";
}

/**
 * Clock.every callbacks must catch and report their own errors: a rejected tick is dropped
 * so the schedule keeps running, and a tick is skipped while the previous one is still running.
 */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, Math.max(0, ms)));
  }
  every(ms: number, fn: () => void | Promise<void>): () => void {
    let running = false;
    const h = setInterval(() => {
      if (running) return;
      running = true;
      Promise.resolve()
        .then(fn)
        .catch(() => undefined)
        .finally(() => {
          running = false;
        });
    }, ms);
    return () => clearInterval(h);
  }
}

interface Timer {
  at: number;
  seq: number;
  fire: () => void;
}

/**
 * Deterministic clock for tests. advance(ms) moves time and fires due timers in order.
 * With autoAdvance, sleep() jumps time forward immediately instead of waiting for advance().
 */
export class SimClock implements Clock {
  private t: number;
  private seq = 0;
  private timers: Timer[] = [];
  private readonly autoAdvance: boolean;

  constructor(startMs: number, opts: { autoAdvance?: boolean } = {}) {
    if (!Number.isSafeInteger(startMs)) throw new Error("SimClock start must be an integer ms");
    this.t = startMs;
    this.autoAdvance = opts.autoAdvance ?? false;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    const d = Math.max(0, Math.round(ms));
    if (this.autoAdvance) {
      this.advance(d);
      return Promise.resolve();
    }
    return new Promise((resolve) => this.schedule(this.t + d, resolve));
  }

  every(ms: number, fn: () => void | Promise<void>): () => void {
    const period = Math.max(1, Math.round(ms));
    let stopped = false;
    let running = false;
    const arm = (at: number): void =>
      this.schedule(at, () => {
        if (stopped) return;
        // Same rule as SystemClock: skip a tick while the previous one is still running.
        if (!running) {
          // Run synchronously so the callback sees the time it fired at.
          let r: void | Promise<void>;
          try {
            r = fn();
          } catch {
            r = undefined; // a throwing tick must not stop the schedule
          }
          if (r instanceof Promise) {
            running = true;
            void r.catch(() => undefined).finally(() => {
              running = false;
            });
          }
        }
        arm(at + period);
      });
    arm(this.t + period);
    return () => {
      stopped = true;
    };
  }

  /** Move time forward by ms, firing every timer that falls due, in time order. */
  advance(ms: number): void {
    const target = this.t + Math.max(0, Math.round(ms));
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.t = next.at;
      next.fire();
    }
    this.t = target;
  }

  set(ms: number): void {
    if (ms < this.t) throw new Error("SimClock cannot go backwards");
    this.advance(ms - this.t);
  }

  pendingTimers(): number {
    return this.timers.length;
  }

  private schedule(at: number, fire: () => void): void {
    this.timers.push({ at, seq: this.seq++, fire });
  }
}
