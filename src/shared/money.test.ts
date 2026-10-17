import { describe, expect, it } from "vitest";
import {
  bpsToPct2, ceilToTick, decMin, floorToLot, floorToTick, fromScaled, HARD_MAX_DAILY_RISK, HARD_MAX_DAILY_RISK_SCALED,
  HARD_MAX_ORDER_QUOTE, HARD_MAX_ORDER_QUOTE_SCALED, pct2ToBps, round8Down, toDecString, toScaled, toScaledSigned, D,
} from "./money.js";

describe("toScaled (frozen)", () => {
  it("scales exactly", () => {
    expect(toScaled("494.7")).toBe(49_470_000_000n);
    expect(toScaled("0.00000001")).toBe(1n);
    expect(toScaled("0")).toBe(0n);
    expect(toScaled("0.40428")).toBe(40_428_000n);
    expect(toScaled("7.007")).toBe(700_700_000n);
    expect(toScaled("1427.14428")).toBe(142_714_428_000n);
  });
  it("accepts uint64 max and rejects one unit more", () => {
    expect(toScaled("184467440737.09551615")).toBe((1n << 64n) - 1n);
    expect(() => toScaled("184467440737.09551616")).toThrow(/uint64/);
  });
  it("rejects > 8 dp, negatives and junk", () => {
    expect(() => toScaled("1.123456789")).toThrow(/8 decimals/);
    expect(() => toScaled("-1")).toThrow();
    expect(() => toScaled("1e3")).toThrow();
    expect(() => toScaled("")).toThrow();
    expect(() => toScaled("1,5")).toThrow();
  });
});

describe("toScaledSigned (frozen)", () => {
  it("rounds toward zero", () => {
    expect(toScaledSigned("-1.234567899")).toBe(-123_456_789n);
    expect(toScaledSigned("1.234567899")).toBe(123_456_789n);
    expect(toScaledSigned("-0.000000001")).toBe(0n);
    expect(toScaledSigned("12.5")).toBe(1_250_000_000n);
  });
  it("checks the int64 range", () => {
    expect(toScaledSigned("92233720368.54775807")).toBe((1n << 63n) - 1n);
    expect(toScaledSigned("-92233720368.54775808")).toBe(-(1n << 63n));
    expect(() => toScaledSigned("92233720368.54775808")).toThrow(/int64/);
    expect(() => toScaledSigned("-92233720368.54775809")).toThrow(/int64/);
  });
  it("round-trips through fromScaled", () => {
    expect(fromScaled(-123_456_789n)).toBe("-1.23456789");
    expect(fromScaled(49_470_000_000n)).toBe("494.7");
    expect(fromScaled("0")).toBe("0");
  });
});

describe("Pct2 → bps (frozen)", () => {
  it("converts exactly", () => {
    expect(pct2ToBps("0.3")).toBe(30);
    expect(pct2ToBps("3")).toBe(300);
    expect(pct2ToBps("0.05")).toBe(5);
    expect(pct2ToBps("20")).toBe(2000);
    expect(pct2ToBps("2.95")).toBe(295);
  });
  it("rejects 3 dp, zero and junk", () => {
    expect(() => pct2ToBps("0.001")).toThrow();
    expect(() => pct2ToBps("0")).toThrow();
    expect(() => pct2ToBps("0.00")).toThrow();
    expect(() => pct2ToBps("-1")).toThrow();
  });
  it("bpsToPct2 inverts", () => {
    expect(bpsToPct2(30)).toBe("0.3");
    expect(bpsToPct2(300)).toBe("3");
    expect(bpsToPct2(5)).toBe("0.05");
  });
});

describe("rounding", () => {
  it("ticks and lots", () => {
    expect(ceilToTick("494.71", "0.1")).toBe("494.8");
    expect(ceilToTick("494.7", "0.1")).toBe("494.7");
    expect(floorToTick("488.89", "0.1")).toBe("488.8");
    expect(floorToLot("0.404285", "0.0001")).toBe("0.4042");
    expect(floorToLot("0.00009", "0.0001")).toBe("0");
    expect(round8Down("0.123456789")).toBe("0.12345678");
  });
  it("prints plain decimals", () => {
    expect(toDecString(D("494.700"))).toBe("494.7");
    expect(toDecString(D("0.00000001"))).toBe("0.00000001");
    expect(() => D("1e-8")).toThrow();
    expect(decMin("3", "2.5", "10")).toBe("2.5");
  });
});

describe("hard caps", () => {
  it("match the scaled constants", () => {
    expect(toScaled(HARD_MAX_ORDER_QUOTE)).toBe(HARD_MAX_ORDER_QUOTE_SCALED);
    expect(toScaled(HARD_MAX_DAILY_RISK)).toBe(HARD_MAX_DAILY_RISK_SCALED);
  });
});
