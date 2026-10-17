// Never spawns okx-trade-mcp: every test injects a fake spawner.
import { afterEach, describe, expect, it } from "vitest";
import { __resetArmingForTests, armLive, NotArmedError } from "../shared/arming.js";
import { AtkClient, AtkRefusedError, buildArgs, type AtkConnection, type AtkSpawner, type AtkStartOpts, type SpawnSpec } from "./client.js";
import { AtkToolError } from "./parse.js";

const READ_TOOLS = ["market_get_ticker", "market_get_instruments", "spot_get_order", "account_get_balance", "system_get_capabilities"];
const TRADE_TOOLS = ["market_get_ticker", "spot_place_order", "spot_cancel_order", "spot_get_order", "spot_set_leverage", "spot_batch_orders", "system_get_capabilities"];

function caps(readOnly: boolean, demo = false) {
  return JSON.stringify({
    tool: "system_get_capabilities",
    ok: true,
    data: { server: { name: "okx-trade-mcp", version: "1.4.8" }, capabilities: { readOnly, hasAuth: true, demo, moduleAvailability: { market: { status: "enabled" } } } },
  });
}
function ok(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify({ tool: "x", ok: true, data: { endpoint: "GET /x", requestTime: "t", data } }) }] };
}

interface Fake {
  spawner: AtkSpawner;
  spawned: SpawnSpec[];
  calls: { name: string; args: Record<string, unknown> }[];
  closed: number;
}
function fake(opts: { tools: string[]; readOnly: boolean; demo?: boolean; respond?: (name: string) => { isError?: boolean; content: unknown } }): Fake {
  const f: Fake = { spawned: [], calls: [], closed: 0, spawner: async () => conn };
  const conn: AtkConnection = {
    async listTools() {
      return opts.tools.map((name) => ({ name, description: name, inputSchema: { type: "object" } }));
    },
    async callTool(name, args) {
      f.calls.push({ name, args });
      if (name === "system_get_capabilities") return { content: [{ type: "text", text: caps(opts.readOnly, opts.demo) }] };
      return opts.respond ? opts.respond(name) : ok([{ name }]);
    },
    async close() {
      f.closed++;
    },
  };
  f.spawner = async (spec) => {
    f.spawned.push(spec);
    return conn;
  };
  return f;
}

const readOpts: AtkStartOpts = { profile: "tr-read", modules: ["market", "account", "spot"], readOnly: true, allow: ["market_get_ticker", "spot_get_order"] };
const tradeOpts: AtkStartOpts = { profile: "tr-trade", modules: ["market", "spot"], readOnly: false, allow: ["market_get_ticker", "spot_place_order", "spot_cancel_order", "spot_get_order"] };

afterEach(() => __resetArmingForTests());

describe("buildArgs", () => {
  it("read-only instance on the TR site", () => {
    expect(buildArgs(readOpts)).toEqual(["--profile", "tr-read", "--modules", "market,account,spot", "--site", "tr", "--read-only"]);
  });
  it("trade instance has no --read-only; demo adds --demo", () => {
    expect(buildArgs(tradeOpts)).toEqual(["--profile", "tr-trade", "--modules", "market,spot", "--site", "tr"]);
    expect(buildArgs({ ...tradeOpts, demo: true })).toContain("--demo");
  });
});

describe("read-only instance", () => {
  it("spawns node + the bin JS, and only allowlisted tools reach the server", async () => {
    const f = fake({ tools: READ_TOOLS, readOnly: true });
    const c = await AtkClient.start(readOpts, { spawner: f.spawner, mode: "paper", env: {} });
    expect(f.spawned[0]?.command).toBe(process.execPath);
    expect(f.spawned[0]?.args[0]).toMatch(/okx-trade-mcp[\\/]dist[\\/]index\.js$/);
    expect(c.kind).toBe("read");
    expect(c.version).toBe("1.4.8");
    expect(c.allowedTools()).toEqual(["market_get_ticker", "spot_get_order", "system_get_capabilities"]);
    expect(await c.callData("market_get_ticker", { instId: "AVAX-TRY" })).toEqual([{ name: "market_get_ticker" }]);
    await expect(c.callTool("account_get_balance", {})).rejects.toBeInstanceOf(AtkRefusedError);
    expect(f.calls.map((x) => x.name)).toEqual(["system_get_capabilities", "market_get_ticker"]);
    expect((await c.listTools()).map((t) => t.name)).toEqual(READ_TOOLS);
  });

  it("refuses (and closes) a read-only instance that lists a write tool", async () => {
    const f = fake({ tools: [...READ_TOOLS, "spot_place_order"], readOnly: true });
    await expect(AtkClient.start(readOpts, { spawner: f.spawner, mode: "paper", env: {} })).rejects.toThrow(/write tools: spot_place_order/);
    expect(f.closed).toBe(1);
  });

  it("refuses when capabilities do not say readOnly", async () => {
    const f = fake({ tools: READ_TOOLS, readOnly: false });
    await expect(AtkClient.start(readOpts, { spawner: f.spawner, mode: "paper", env: {} })).rejects.toThrow(/readOnly=false/);
    expect(f.closed).toBe(1);
  });

  it("refuses when the demo flag does not match", async () => {
    const f = fake({ tools: READ_TOOLS, readOnly: true, demo: true });
    await expect(AtkClient.start(readOpts, { spawner: f.spawner, mode: "paper", env: {} })).rejects.toThrow(/demo/);
  });

  it("allowlisted names the server does not list are not callable", async () => {
    const f = fake({ tools: READ_TOOLS, readOnly: true });
    const c = await AtkClient.start({ ...readOpts, allow: ["market_get_ticker", "news_search"] }, { spawner: f.spawner, mode: "paper", env: {} });
    expect(c.allowedTools()).not.toContain("news_search");
  });

  it("callData throws AtkToolError on isError; callTool returns the error text", async () => {
    const err = { isError: true, content: [{ type: "text", text: JSON.stringify({ tool: "market_get_ticker", error: true, type: "OkxApiError", code: "51001", message: "Instrument ID does not exist" }) }] };
    const f = fake({ tools: READ_TOOLS, readOnly: true, respond: () => err });
    const c = await AtkClient.start(readOpts, { spawner: f.spawner, mode: "paper", env: {} });
    await expect(c.callData("market_get_ticker", { instId: "X-Y" })).rejects.toThrow(AtkToolError);
    await expect(c.callData("market_get_ticker", { instId: "X-Y" })).rejects.toThrow(/51001/);
    expect(await c.callTool("market_get_ticker", { instId: "X-Y" })).toContain("51001");
  });

  it("close() is idempotent and blocks further calls", async () => {
    const f = fake({ tools: READ_TOOLS, readOnly: true });
    const c = await AtkClient.start(readOpts, { spawner: f.spawner, mode: "paper", env: {} });
    await c.close();
    await c.close();
    expect(f.closed).toBe(1);
    await expect(c.callTool("market_get_ticker", {})).rejects.toBeInstanceOf(AtkRefusedError);
  });
});

describe("arming guard (trade instance)", () => {
  for (const mode of ["fake", "paper", "live", "demo"] as const) {
    it(`unarmed ${mode}: throws and never spawns`, async () => {
      const f = fake({ tools: TRADE_TOOLS, readOnly: false });
      await expect(AtkClient.start(tradeOpts, { spawner: f.spawner, mode, env: {} })).rejects.toBeInstanceOf(NotArmedError);
      expect(f.spawned).toHaveLength(0);
    });
  }

  it("paper with an arm token is still refused", async () => {
    const f = fake({ tools: TRADE_TOOLS, readOnly: false });
    await expect(AtkClient.start(tradeOpts, { spawner: f.spawner, mode: "paper", env: { EXECUTOR_ARM_TOKEN: "t" } })).rejects.toBeInstanceOf(NotArmedError);
    expect(f.spawned).toHaveLength(0);
  });

  it("live + EXECUTOR_ARM_TOKEN starts; the allowlist hides leverage/batch tools", async () => {
    const f = fake({ tools: TRADE_TOOLS, readOnly: false });
    const c = await AtkClient.start(tradeOpts, { spawner: f.spawner, mode: "live", env: { EXECUTOR_ARM_TOKEN: "t" } });
    expect(c.kind).toBe("trade");
    await expect(c.callTool("spot_set_leverage", {})).rejects.toBeInstanceOf(AtkRefusedError);
    await expect(c.callTool("spot_batch_orders", {})).rejects.toBeInstanceOf(AtkRefusedError);
    await c.callTool("spot_place_order", { instId: "AVAX-TRY" });
    expect(f.calls.map((x) => x.name)).toEqual(["system_get_capabilities", "spot_place_order"]);
  });

  it("live armed by armLive() in core starts", async () => {
    armLive();
    const f = fake({ tools: TRADE_TOOLS, readOnly: false });
    const c = await AtkClient.start(tradeOpts, { spawner: f.spawner, mode: "live", env: {} });
    expect(c.kind).toBe("trade");
  });
});

describe("cancel-only client", () => {
  const cancelOpts: AtkStartOpts = { ...tradeOpts, cancelOnly: true, allow: ["spot_place_order"] };

  it("refused unless state.json says live or demo (never spawns)", async () => {
    for (const m of ["fake", "paper", null] as const) {
      const f = fake({ tools: TRADE_TOOLS, readOnly: false });
      await expect(
        AtkClient.start(cancelOpts, { spawner: f.spawner, mode: "live", env: {}, dataDir: "/tmp/x", readStateMode: () => m }),
      ).rejects.toBeInstanceOf(AtkRefusedError);
      expect(f.spawned).toHaveLength(0);
    }
  });

  it("needs a data dir and readOnly: false", async () => {
    const f = fake({ tools: TRADE_TOOLS, readOnly: false });
    await expect(AtkClient.start(cancelOpts, { spawner: f.spawner, mode: "live", env: {}, readStateMode: () => "live" })).rejects.toThrow(/DATA_DIR/);
    await expect(
      AtkClient.start({ ...cancelOpts, readOnly: true }, { spawner: f.spawner, mode: "live", env: {}, dataDir: "/tmp/x", readStateMode: () => "live" }),
    ).rejects.toThrow(/readOnly/);
  });

  it("needs no arming; only spot_cancel_order is callable, whatever the allow list says", async () => {
    const f = fake({ tools: TRADE_TOOLS, readOnly: false });
    const c = await AtkClient.start(cancelOpts, { spawner: f.spawner, mode: "paper", env: {}, dataDir: "/tmp/x", readStateMode: () => "demo" });
    expect(c.kind).toBe("cancel-only");
    expect(c.allowedTools()).toEqual(["spot_cancel_order", "system_get_capabilities"]);
    await expect(c.callTool("spot_place_order", {})).rejects.toBeInstanceOf(AtkRefusedError);
    await expect(c.callTool("spot_get_order", {})).rejects.toBeInstanceOf(AtkRefusedError);
    await c.callTool("spot_cancel_order", { instId: "AVAX-TRY", clOrdId: "v" + "0".repeat(30) });
    expect(f.calls.at(-1)?.name).toBe("spot_cancel_order");
  });
});
