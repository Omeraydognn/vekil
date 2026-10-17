import { describe, expect, it } from "vitest";
import {
  clOrdIdPrefix, CLORDID_RE, entryClOrdId, exitClOrdId, exitHash, instIdHash, orderHash, type OrderRequestInput,
} from "./order-hash.js";
import {
  VECTOR_CHAIN_ID, VECTOR_ENTRY_CLORDID, VECTOR_EXIT_CLORDID, VECTOR_EXIT_HASH, VECTOR_EXIT_NONCE, VECTOR_INST_ID_HASH,
  VECTOR_ORDER_HASH, VECTOR_POLICY, VECTOR_R1_CHAIN_ID, VECTOR_R1_ORDER_HASH, VECTOR_R1_REQ, VECTOR_REQ,
} from "./vectors.js";

describe("orderHash (frozen)", () => {
  it("instIdHash", () => {
    expect(instIdHash("AVAX-TRY")).toBe(VECTOR_INST_ID_HASH);
  });
  it("matches the cast-computed vector", () => {
    expect(orderHash(VECTOR_CHAIN_ID, VECTOR_POLICY, VECTOR_REQ)).toBe(VECTOR_ORDER_HASH);
  });
  it("accepts a checksummed policy address", () => {
    expect(orderHash(VECTOR_CHAIN_ID, "0x5FbDB2315678afecb367f032d93F642f64180aa3", VECTOR_REQ)).toBe(VECTOR_ORDER_HASH);
  });
  it("encodes the R1-sized request (overflow test values)", () => {
    expect(orderHash(VECTOR_R1_CHAIN_ID, VECTOR_POLICY, VECTOR_R1_REQ)).toBe(VECTOR_R1_ORDER_HASH);
  });
  it("changes when any field changes", () => {
    const variants: Partial<OrderRequestInput>[] = [
      { instId: "BTC-TRY" }, { px: "494.8" }, { sz: "0.40429" }, { stopPx: "488.9" }, { tpPx: "0" },
      { timeStopMin: 241 }, { decisionHash: `0x${"12".repeat(32)}` }, { nonce: `0x${"23".repeat(32)}` },
    ];
    for (const v of variants) {
      expect(orderHash(VECTOR_CHAIN_ID, VECTOR_POLICY, { ...VECTOR_REQ, ...v })).not.toBe(VECTOR_ORDER_HASH);
    }
    expect(orderHash(43114, VECTOR_POLICY, VECTOR_REQ)).not.toBe(VECTOR_ORDER_HASH);
  });
  it("rejects amounts with more than 8 decimals and bad inputs", () => {
    expect(() => orderHash(VECTOR_CHAIN_ID, VECTOR_POLICY, { ...VECTOR_REQ, px: "494.123456789" })).toThrow();
    expect(() => orderHash(VECTOR_CHAIN_ID, "0x1234", VECTOR_REQ)).toThrow();
    expect(() => orderHash(VECTOR_CHAIN_ID, VECTOR_POLICY, { ...VECTOR_REQ, nonce: "0x22" })).toThrow();
  });
});

describe("clOrdIds (frozen)", () => {
  it("entry", () => {
    expect(entryClOrdId(VECTOR_ORDER_HASH)).toBe(VECTOR_ENTRY_CLORDID);
    expect(CLORDID_RE.test(VECTOR_ENTRY_CLORDID)).toBe(true);
    expect(clOrdIdPrefix(VECTOR_ENTRY_CLORDID)).toBe(VECTOR_ORDER_HASH.slice(2, 32));
  });
  it("exit", () => {
    expect(exitHash(VECTOR_ORDER_HASH, VECTOR_EXIT_NONCE)).toBe(VECTOR_EXIT_HASH);
    expect(exitClOrdId(VECTOR_ORDER_HASH, VECTOR_EXIT_NONCE)).toBe(VECTOR_EXIT_CLORDID);
    expect(CLORDID_RE.test(VECTOR_EXIT_CLORDID)).toBe(true);
  });
  it("rejects foreign clOrdIds", () => {
    expect(() => clOrdIdPrefix("manual123")).toThrow();
  });
});
