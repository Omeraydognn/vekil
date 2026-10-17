import { describe, expect, it } from "vitest";
import { dayIndex, dayKey, endOfDayIstanbul, hourIndex, isoIstanbul, isWholeSecond, msToSec, SimClock, SystemClock } from "./time.js";

const T = Date.UTC(2026, 9, 17, 20, 59, 59); // 23:59:59 TRT on 17 Oct

describe("Istanbul day keys and contract buckets", () => {
  it("flips the day at 21:00:00Z", () => {
    expect(dayKey(T)).toBe("2026-10-17");
    expect(dayKey(T + 1000)).toBe("2026-10-18");
  });
  it("dayIndex flips at the same instant as dayKey", () => {
    expect(dayIndex(msToSec(T + 1000)) - dayIndex(msToSec(T))).toBe(1);
    expect(dayIndex(msToSec(T + 1000))).toBe(Math.floor((msToSec(T + 1000) + 10800) / 86400));
  });
  it("hourIndex matches the contract formula", () => {
    const s = msToSec(T);
    expect(hourIndex(s)).toBe(Math.floor((s + 10800) / 3600));
    expect(hourIndex(s + 1)).toBe(hourIndex(s) + 1);
  });
  it("endOfDayIstanbul is 23:59:59 TRT and a whole second", () => {
    const morning = Date.UTC(2026, 9, 17, 5, 12, 34, 567); // 08:12 TRT
    expect(endOfDayIstanbul(morning)).toBe(T);
    expect(isWholeSecond(endOfDayIstanbul(morning))).toBe(true);
    expect(endOfDayIstanbul(T + 1000)).toBe(T + 86_400_000);
    expect(isoIstanbul(T)).toBe("2026-10-17T23:59:59+03:00");
  });
});

describe("SimClock", () => {
  it("sleep resolves after advance", async () => {
    const c = new SimClock(1000);
    let done = false;
    const p = c.sleep(500).then(() => {
      done = true;
    });
    c.advance(499);
    await Promise.resolve();
    expect(done).toBe(false);
    c.advance(1);
    await p;
    expect(done).toBe(true);
    expect(c.now()).toBe(1500);
  });
  it("every fires per period and stops", async () => {
    const c = new SimClock(0);
    const seen: number[] = [];
    const stop = c.every(100, () => {
      seen.push(c.now());
    });
    c.advance(350);
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([100, 200, 300]);
    stop();
    c.advance(500);
    await Promise.resolve();
    expect(seen).toHaveLength(3);
  });
  it("autoAdvance jumps time on sleep", async () => {
    const c = new SimClock(0, { autoAdvance: true });
    await c.sleep(10_000);
    expect(c.now()).toBe(10_000);
  });
  it("refuses to go backwards", () => {
    const c = new SimClock(10);
    expect(() => c.set(5)).toThrow();
  });
});

describe("SystemClock", () => {
  it("now is close to Date.now and sleep waits", async () => {
    const c = new SystemClock();
    const a = c.now();
    await c.sleep(5);
    expect(c.now()).toBeGreaterThanOrEqual(a);
  });
});

describe("SimClock overlap rule", () => {
  it("skips ticks while an async callback is still running", async () => {
    const c = new SimClock(0);
    let calls = 0;
    let release: () => void = () => undefined;
    c.every(100, () => {
      calls++;
      return new Promise<void>((r) => {
        release = r;
      });
    });
    c.advance(300);
    expect(calls).toBe(1);
    release();
    await new Promise((r) => setTimeout(r, 0));
    c.advance(100);
    expect(calls).toBe(2);
  });
});
