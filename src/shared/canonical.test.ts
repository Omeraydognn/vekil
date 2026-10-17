import { describe, expect, it } from "vitest";
import { canonical, CanonicalError, sortKeysDeep } from "./canonical.js";
import { hashCanonical } from "./hash.js";

// Expected hash computed independently with `cast keccak '<string>'` (Foundry).
const SAMPLE = { c: -5, b: [1, "İşlem ğüşöç", true, null], a: { z: 0, y: "x", u: undefined } };
const SAMPLE_CANONICAL = '{"a":{"y":"x","z":0},"b":[1,"İşlem ğüşöç",true,null],"c":-5}';
const SAMPLE_HASH = "0xb0d6b66c38a896280c236f330b047ae04c7bebf67d44af4d30e0a2fd72671b7f";

describe("canonical (frozen)", () => {
  it("sorts keys recursively, omits undefined, keeps array order", () => {
    expect(canonical(SAMPLE)).toBe(SAMPLE_CANONICAL);
  });
  it("hashes to the frozen vector", () => {
    expect(hashCanonical(SAMPLE)).toBe(SAMPLE_HASH);
  });
  it("uses JSON.stringify escaping", () => {
    expect(canonical({ s: 'a"b\\c\n' })).toBe('{"s":"a\\"b\\\\c\\n"}');
  });
  it("maps undefined array items to null like JSON", () => {
    expect(canonical([undefined, 1])).toBe("[null,1]");
  });
});

describe("canonical rejects", () => {
  const bad: [string, unknown][] = [
    ["float", { x: 1.5 }],
    ["NaN", { x: Number.NaN }],
    ["Infinity", { x: Number.POSITIVE_INFINITY }],
    ["unsafe int", { x: 2 ** 53 }],
    ["bigint", { x: 1n }],
    ["function", { x: () => 1 }],
    ["Date", { x: new Date(0) }],
    ["top-level undefined", undefined],
  ];
  for (const [name, v] of bad) {
    it(name, () => {
      expect(() => canonical(v)).toThrow(CanonicalError);
    });
  }
});

describe("sortKeysDeep", () => {
  it("allows floats and sorts", () => {
    expect(JSON.stringify(sortKeysDeep({ b: 1.5, a: [{ d: 1, c: 2 }] }))).toBe('{"a":[{"c":2,"d":1}],"b":1.5}');
  });
});

describe("canonical edge cases", () => {
  it("sparse arrays become null like JSON.stringify", () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [, 1];
    expect(canonical(sparse)).toBe("[null,1]");
    expect(canonical(sparse)).toBe(JSON.stringify(sparse));
  });
  it("cycles throw CanonicalError; shared (non-cyclic) refs are fine", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonical(a)).toThrow(CanonicalError);
    const shared = { k: 1 };
    expect(canonical({ x: shared, y: shared })).toBe('{"x":{"k":1},"y":{"k":1}}');
  });
});
