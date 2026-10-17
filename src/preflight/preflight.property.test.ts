// PF1–PF6 (SPEC §12), ≥ 2,000 runs each.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { D } from "../shared/money.js";
import type { PreflightInput } from "../shared/interfaces.js";
import type { AgentDecision } from "../shared/schemas.js";
import { adjust, buy, close, hold, input, NOW, position } from "./fixtures.js";
import { preflight } from "./preflight.js";

const RUNS = { numRuns: 2_000 };

/** Positive decimal string with up to `dp` decimals. */
const dec = (min: number, max: number, dp: number) =>
  fc.integer({ min: Math.round(min * 10 ** dp), max: Math.round(max * 10 ** dp) }).map((n) => D(String(n)).div(10 ** dp).toFixed());
const pdec = (min: number, max: number, dp: number) => dec(min, max, dp).filter((s) => D(s).gt(0));
const inst = fc.constantFrom("AVAX-TRY", "DOGE-TRY", "BTC-TRY");
const maybe = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: undefined });

const decisionArb: fc.Arbitrary<AgentDecision> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ instId: inst, quoteAmount: pdec(0.00000001, 5_000, 8), limitPx: maybe(pdec(0.001, 5_000_000, 9)), stopPx: maybe(pdec(0.001, 1_000, 3)), tpPx: maybe(pdec(0.001, 1_000, 3)), timeStopMin: maybe(fc.integer({ min: 0, max: 2000 })) }).map((o) => buy(o)) },
  { weight: 1, arbitrary: fc.constant(hold()) },
  { weight: 1, arbitrary: inst.map((i) => close(i)) },
  { weight: 1, arbitrary: fc.record({ newStopPx: maybe(pdec(1, 1_000, 2)), newTpPx: maybe(pdec(1, 1_000, 2)) }).filter((o) => o.newStopPx !== undefined || o.newTpPx !== undefined).map((o) => adjust(o)) },
);

const base = input();
const inputArb: fc.Arbitrary<PreflightInput> = fc
  .record({
    decision: decisionArb,
    policy: fc.option(fc.record({ instIds: fc.subarray(["AVAX-TRY", "DOGE-TRY"], { minLength: 1 }), maxOrderQuote: pdec(1, 1000, 8), maxHoldMin: fc.integer({ min: 15, max: 1440 }) }), { nil: null }),
    chain: fc.option(fc.record({ paused: fc.boolean(), policyVersion: fc.nat(10), checkedAt: fc.integer({ min: NOW - 120_000, max: NOW }) }), { nil: null }),
    snapshot: fc.option(fc.record({ instId: inst, bid: pdec(0.001, 1_000, 3), ask: pdec(0.001, 1_000, 3), fetchedAt: fc.integer({ min: NOW - 60_000, max: NOW }) }), { nil: null }),
    spec: fc.option(fc.record({ instId: inst, tickSz: fc.constantFrom("0.1", "0.001", "1", "0.5"), lotSz: fc.constantFrom("0.00001", "0.001", "0.000000001", "1"), minSz: fc.constantFrom("0.1", "10", "0.0001"), state: fc.constantFrom("live", "suspend") }), { nil: null }),
    account: fc.option(fc.record({ quoteAvail: dec(0, 10_000, 8) }), { nil: null }),
    hasPosition: fc.boolean(),
    lastLossExitAt: fc.option(fc.integer({ min: NOW - 7_200_000, max: NOW }), { nil: null }),
    halted: fc.boolean(),
    test: fc.boolean(),
    forceChain: fc.boolean(),
    spreadPct: fc.constantFrom("0.3", "0.05", "5"),
  })
  .map((r) => ({
    ...base,
    decision: r.decision,
    policy: r.policy ? { ...base.policy!, ...r.policy } : null,
    chain: r.chain,
    snapshot: r.snapshot ? { ...base.snapshot!, ...r.snapshot } : null,
    spec: r.spec ? { ...base.spec!, ...r.spec } : null,
    account: r.account ? { ...base.account!, ...r.account } : null,
    positions: r.hasPosition ? [position()] : [],
    lastLossExitAt: r.lastLossExitAt,
    halted: r.halted,
    test: r.test,
    forceChain: r.forceChain,
    cfg: { ...base.cfg, maxSpreadPct: r.spreadPct },
  }));

const isMultiple = (x: string, unit: string) => D(x).mod(D(unit)).isZero();

describe("preflight properties", () => {
  it("PF1: LOCAL_BLOCK ⇒ reasons ≠ ∅", () => {
    fc.assert(fc.property(inputArb, (i) => {
      const r = preflight(i);
      return r.route !== "LOCAL_BLOCK" || r.reasons.length > 0;
    }), RUNS);
  });

  it("PF2: forceChain, or suspect and (test, or not halted/paused) ⇒ CHAIN (BUY)", () => {
    fc.assert(fc.property(inputArb, (i) => {
      if (i.decision.action !== "BUY") return true;
      const r = preflight(i);
      const blocked = i.halted || i.chain?.paused === true;
      const must = i.forceChain || (r.suspect && !i.test && !blocked) || (r.suspect && i.test);
      return !must || r.route === "CHAIN";
    }), RUNS);
  });

  it("PF3: CHAIN, not suspect, not forceChain ⇒ no local reasons", () => {
    fc.assert(fc.property(inputArb, (i) => {
      const r = preflight(i);
      return !(r.route === "CHAIN" && !r.suspect && !i.forceChain) || r.reasons.length === 0;
    }), RUNS);
  });

  it("PF4: with a spec, px is a multiple of tickSz and sz of lotSz", () => {
    fc.assert(fc.property(inputArb, (i) => {
      const r = preflight(i);
      if (!r.order || !i.spec || i.spec.instId !== i.decision.instId) return true;
      return isMultiple(r.order.px, i.spec.tickSz) && isMultiple(r.order.sz, i.spec.lotSz);
    }), RUNS);
  });

  it("PF5: deterministic", () => {
    fc.assert(fc.property(inputArb, (i) => {
      expect(preflight(structuredClone(i))).toEqual(preflight(i));
    }), RUNS);
  });

  it("PF6: never throws (including null policy/chain/snapshot/spec/account)", () => {
    fc.assert(fc.property(inputArb, (i) => {
      preflight(i);
    }), RUNS);
  });

  it("orders always use ≤ 8 decimals (so toScaled can encode them)", () => {
    const dp = (s: string) => (s.includes(".") ? s.split(".")[1]!.length : 0);
    fc.assert(fc.property(inputArb, (i) => {
      const o = preflight(i).order;
      return !o || [o.px, o.sz, o.stopPx, o.tpPx].every((s) => dp(s) <= 8);
    }), RUNS);
  });
});
