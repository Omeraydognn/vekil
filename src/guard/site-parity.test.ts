// The public site (site/lib/vekil.js) is a plain-JS mirror of the Guard rules. These tests keep it in step with
// src/shared and src/guard so the keyless page can't drift from what the contract and the core enforce.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as site from "../../site/lib/vekil.js";
import { MoneyError, toScaled as mainToScaled } from "../shared/money.js";
import { POLICY_REASONS, REASON_TR, maskToReasons as mainMask } from "../shared/reasons.js";
import { CheckBodySchema, worstCaseQuote } from "./guard.js";
import type { OrderRequest } from "../shared/schemas.js";

const dec8 = fc.tuple(fc.bigInt({ min: 0n, max: 10n ** 11n }), fc.integer({ min: 0, max: 8 }), fc.bigInt({ min: 0n, max: 10n ** 8n - 1n }))
  .map(([i, dp, f]) => (dp === 0 ? `${i}` : `${i}.${f.toString().padStart(8, "0").slice(0, dp)}`));

describe("site/lib/vekil.js ↔ src (parity)", () => {
  it("reason list, labels and critical mask are the same", () => {
    expect(site.POLICY_REASONS).toEqual([...POLICY_REASONS]);
    for (const r of POLICY_REASONS) expect(site.REASON_TR[r]).toBe(REASON_TR[r]);
    expect(site.CRITICAL_MASK).toBe((1 << 2) | (1 << 3) | (1 << 6));
  });

  it("maskToReasons matches, and unknown bits fail closed in both", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 0x7fff }), (m) => {
      expect(site.maskToReasons(m)).toEqual(mainMask(m));
    }), { numRuns: 2000 });
    expect(() => site.maskToReasons(1 << 15)).toThrow();
    expect(() => mainMask(1 << 15)).toThrow();
  });

  it("toScaled agrees on valid and invalid input", () => {
    fc.assert(fc.property(dec8, (s) => {
      expect(site.toScaled(s)).toBe(mainToScaled(s));
    }), { numRuns: 2000 });
    for (const bad of ["1,5", "-1", "1e3", "", "1.123456789", "184467440737.09551616"]) {
      expect(() => site.toScaled(bad)).toThrow();
      expect(() => mainToScaled(bad)).toThrow(MoneyError);
    }
  });

  it("parseCheck accepts what CheckBodySchema accepts and rejects the same bad bodies", () => {
    const good = { instId: "AVAX-TRY", px: "490", sz: "0.15", stopPx: "475", tpPx: "520", timeStopMin: 240 };
    expect(CheckBodySchema.safeParse(good).success).toBe(true);
    expect(site.parseCheck(good).px).toBe(49_000_000_000n);
    for (const bad of [{ ...good, side: "sell" }, { ...good, extra: 1 }, { ...good, px: "1,5" }, { ...good, timeStopMin: -1 }, { px: "1", sz: "1" }]) {
      expect(CheckBodySchema.safeParse(bad).success).toBe(false);
      expect(() => site.parseCheck(bad)).toThrow();
    }
  });

  it("worst case uses the same integer steps as guard.ts (and the contract)", () => {
    // site computes worst case inside check(); reproduce its formula from the exported helpers.
    const siteWorst = (px: string, sz: string, stop: string, fee: number, slip: number): string => {
      const P = site.toScaled(px), S = site.toScaled(sz), T = site.toScaled(stop);
      const notional = (P * S) / 100_000_000n;
      return site.fromScaled(((P - T) * S) / 100_000_000n + (notional * BigInt(2 * fee + slip)) / 10_000n);
    };
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 100_000 }), fc.integer({ min: 1, max: 99 }), fc.integer({ min: 1, max: 50_000 }), (pxC, stopPct, szM) => {
        const px = (pxC / 100).toFixed(2), stop = ((pxC * (100 - stopPct)) / 10_000).toFixed(2), sz = (szM / 10_000).toFixed(4);
        if (!(Number(stop) > 0 && Number(stop) < Number(px))) return;
        const req = { instId: "AVAX-TRY", side: "buy", px, sz, stopPx: stop, tpPx: "0", timeStopMin: 60, decisionHash: `0x${"1".repeat(64)}`, nonce: `0x${"2".repeat(64)}` } as OrderRequest;
        expect(siteWorst(px, sz, stop, 20, 30)).toBe(worstCaseQuote(req, 20, 30));
      }),
      { numRuns: 2000 },
    );
  });
});
