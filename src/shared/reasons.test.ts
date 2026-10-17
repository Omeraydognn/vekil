import { describe, expect, it } from "vitest";
import {
  CRITICAL_MASK, EXECUTOR_REFUSALS, EXIT_REASON_TR, EXIT_REASONS, exitReasonCode, exitReasonFromCode, isCritical,
  LOCAL_REASONS, maskToReasons, PIPELINE_CODES, POLICY_REASONS, REASON_TR, reasonsToMask, withTr,
} from "./reasons.js";

describe("policy reason bits (SPEC §9.4)", () => {
  it("follow the table order", () => {
    expect(POLICY_REASONS.indexOf("PAUSED")).toBe(0);
    expect(POLICY_REASONS.indexOf("ZERO_VALUE")).toBe(4);
    expect(POLICY_REASONS.indexOf("STOP_MISSING")).toBe(6);
    expect(POLICY_REASONS.indexOf("RISK_BUDGET_EXCEEDED")).toBe(14);
    expect(POLICY_REASONS).toHaveLength(15);
  });
  it("CRITICAL_MASK is bits 2, 3 and 6", () => {
    expect(CRITICAL_MASK).toBe(0b1001100);
  });
  it("R1 rejection is critical; mask round-trips", () => {
    const r1 = reasonsToMask(["INSTRUMENT_NOT_ALLOWED", "ORDER_TOO_LARGE", "STOP_MISSING"]);
    expect(r1).toBe(100);
    expect(maskToReasons(r1)).toEqual(["INSTRUMENT_NOT_ALLOWED", "ORDER_TOO_LARGE", "STOP_MISSING"]);
    expect(isCritical(r1)).toBe(true);
  });
  it("ZERO_VALUE and STOP_TOO_WIDE alone are not critical", () => {
    expect(isCritical(reasonsToMask(["ZERO_VALUE"]))).toBe(false);
    expect(isCritical(reasonsToMask(["STOP_TOO_WIDE"]))).toBe(false);
  });
  it("ORDER_TOO_LARGE is critical only above 2× max", () => {
    const m = reasonsToMask(["ORDER_TOO_LARGE"]);
    const max = 20_000_000_000n;
    expect(isCritical(m, 30_000_000_000n, max)).toBe(false);
    expect(isCritical(m, 40_000_000_000n, max)).toBe(false);
    expect(isCritical(m, 40_000_000_001n, max)).toBe(true);
  });
  it("rejects unknown bits", () => {
    expect(() => maskToReasons(1 << 15)).toThrow();
  });
});

describe("Turkish labels", () => {
  it("every code has one", () => {
    for (const c of [...POLICY_REASONS, ...LOCAL_REASONS, ...PIPELINE_CODES, ...EXECUTOR_REFUSALS]) {
      expect(REASON_TR[c], c).toBeTruthy();
    }
    for (const r of EXIT_REASONS) expect(EXIT_REASON_TR[r]).toBeTruthy();
  });
  it("withTr pairs codes", () => {
    expect(withTr(["STOP_MISSING"])).toEqual([{ code: "STOP_MISSING", tr: "Zarar-kes yok" }]);
  });
});

describe("exit reason codes", () => {
  it("are 1..6 and round-trip", () => {
    EXIT_REASONS.forEach((r, i) => {
      expect(exitReasonCode(r)).toBe(i + 1);
      expect(exitReasonFromCode(i + 1)).toBe(r);
    });
    expect(exitReasonCode("OWNER_CLOSE")).toBe(6);
    expect(() => exitReasonFromCode(0)).toThrow();
    expect(() => exitReasonFromCode(7)).toThrow();
  });
});
