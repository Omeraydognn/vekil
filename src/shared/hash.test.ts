import { describe, expect, it } from "vitest";
import { keccakUtf8, lowerHex32, manifestHash, ZERO_HASH } from "./hash.js";

describe("hash helpers", () => {
  it("keccakUtf8 of empty string", () => {
    expect(keccakUtf8("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  });
  it("lowerHex32 normalizes and validates", () => {
    expect(lowerHex32(`0x${"AB".repeat(32)}`)).toBe(`0x${"ab".repeat(32)}`);
    expect(() => lowerHex32("0x1234")).toThrow();
    expect(ZERO_HASH).toHaveLength(66);
  });
});

describe("manifestHash", () => {
  const a = { name: "market_get_ticker", description: "ticker", inputSchema: { type: "object", properties: { x: { minimum: 0.5 } } } };
  const b = { name: "account_get_balance", inputSchema: { properties: {}, type: "object" } };
  it("does not depend on tool order or key order", () => {
    const b2 = { inputSchema: { type: "object", properties: {} }, name: "account_get_balance" };
    expect(manifestHash([a, b])).toBe(manifestHash([b2, a]));
  });
  it("treats a missing description as empty", () => {
    expect(manifestHash([b])).toBe(manifestHash([{ ...b, description: "" }]));
  });
  it("changes when a schema changes (floats allowed)", () => {
    const a2 = { ...a, inputSchema: { type: "object", properties: { x: { minimum: 0.25 } } } };
    expect(manifestHash([a])).not.toBe(manifestHash([a2]));
  });
});
