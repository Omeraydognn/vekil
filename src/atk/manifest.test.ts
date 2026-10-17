import { describe, expect, it } from "vitest";
import { manifestHash } from "../shared/hash.js";
import { buildLock, compareLock, isWriteToolName, readAllowlist, validateAllowlist } from "./manifest.js";
import { OkxInstrumentRow, OkxTickerRow, rows, unwrap, AtkToolError } from "./parse.js";

const tools = [
  { name: "market_get_ticker", description: "t", inputSchema: { type: "object" } },
  { name: "spot_get_order", inputSchema: { type: "object" } },
];

describe("write-tool pattern (SC3)", () => {
  it.each(["spot_place_order", "spot_cancel_order", "spot_amend_algo_order", "account_transfer", "spot_set_leverage", "account_set_position_mode", "x.withdraw"])(
    "%s is a write",
    (n) => expect(isWriteToolName(n)).toBe(true),
  );
  it.each(["market_get_ticker", "spot_get_orders", "account_get_max_withdrawal", "market_get_instruments", "system_get_capabilities", "trade_get_history"])(
    "%s is not",
    (n) => expect(isWriteToolName(n)).toBe(false),
  );
});

describe("allowlist", () => {
  it("the committed config is valid", () => {
    const a = readAllowlist("config/atk-allowlist.json");
    expect(a.llm).toContain("market_get_candles");
    expect(a.executorTrade).toContain("spot_place_order");
  });
  it("rejects a write tool in llm/core and dangerous executor tools", () => {
    expect(validateAllowlist({ llm: ["spot_place_order"], core: [], executorTrade: [] })).toHaveLength(1);
    expect(validateAllowlist({ llm: [], core: ["account_transfer"], executorTrade: [] })).toHaveLength(1);
    expect(validateAllowlist({ llm: [], core: [], executorTrade: ["spot_set_leverage", "spot_batch_orders"] })).toHaveLength(2);
  });
});

describe("manifest lock", () => {
  it("matches its own tools and detects drift", () => {
    const lock = buildLock("1.4.8", ["market", "account", "spot"], tools);
    expect(lock.manifestHash).toBe(manifestHash(tools));
    expect(compareLock(lock, "1.4.8", ["market", "account", "spot"], [...tools].reverse())).toEqual([]);
    const changed = [{ ...tools[0]!, description: "changed" }, tools[1]!];
    expect(compareLock(lock, "1.4.8", ["market", "account", "spot"], changed)).toHaveLength(1);
    expect(compareLock(lock, "1.4.9", ["market"], tools)).toHaveLength(2);
    expect(compareLock(lock, "1.4.8", ["market", "account", "spot"], [tools[0]!]).join()).toMatch(/missing tool spot_get_order/);
  });
});

describe("parse", () => {
  const env = (data: unknown) => JSON.stringify({ tool: "t", ok: true, data: { endpoint: "e", requestTime: "r", data } });
  it("unwraps a real ticker row (discovery sample)", () => {
    const d = unwrap("market_get_ticker", env([{ instId: "AVAX-TRY", last: "494.6", askPx: "494.7", askSz: "100.1163", bidPx: "494.1", bidSz: "496.00993", ts: "1792219459765" }]));
    expect(rows("market_get_ticker", d, OkxTickerRow)[0]?.bidPx).toBe("494.1");
  });
  it("an empty demo book (askPx \"\") is rejected, never coerced to 0", () => {
    const d = unwrap("market_get_ticker", env([{ instId: "AVAX-TRY", last: "595.2", askPx: "", askSz: "0", bidPx: "", bidSz: "0", ts: "1" }]));
    expect(() => rows("market_get_ticker", d, OkxTickerRow)).toThrow(AtkToolError);
  });
  it("instrument rows keep 9-dp lot sizes as strings", () => {
    const d = unwrap("x", env([{ instId: "BTC-TRY", baseCcy: "BTC", quoteCcy: "TRY", tickSz: "1", lotSz: "0.000000001", minSz: "0.0001", state: "live" }]));
    expect(rows("x", d, OkxInstrumentRow)[0]?.lotSz).toBe("0.000000001");
  });
  it("bad JSON and bad envelopes throw", () => {
    expect(() => unwrap("x", "nope")).toThrow(/BAD_JSON/);
    expect(() => unwrap("x", JSON.stringify({ hello: 1 }))).toThrow(/BAD_ENVELOPE/);
  });
});
