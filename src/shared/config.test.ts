import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, redactConfig } from "./config.js";

// Throwaway test keys (anvil's well-known accounts 0 and 1), never real funds.
const K0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const K1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const FAKE = { EXECUTION_MODE: "fake", LLM_PROVIDER: "scripted", CHAIN: "local" };
const load = (env: Record<string, string>) => loadConfig({ env, dotenv: false, cwd: "/tmp/vekil-test" });

describe("defaults", () => {
  it("fake/scripted/local needs nothing else", () => {
    const c = load(FAKE);
    expect(c.mode).toBe("fake");
    expect(c.chainId).toBe(31337);
    expect(c.rpcUrl).toBe("http://127.0.0.1:8545");
    expect(c.dataDir).toBe("/tmp/vekil-test/data/fake-local");
    expect(c.port).toBe(8788);
    expect(c.executorPort).toBe(8790);
    expect(c.host).toBe("127.0.0.1");
    expect(c.atk.readModules).toEqual(["market", "account", "spot"]);
    expect(c.preflight).toEqual({ maxSpreadPct: "0.3", priceCollarPct: "1", maxSnapshotAgeSec: 15, cooldownAfterLossMin: 60 });
    expect(c.llm.model).toBe("claude-sonnet-5-5");
    expect(c.iConfirmNoWithdraw).toBe(false);
  });
  it("empty strings count as unset", () => {
    const c = load({ ...FAKE, PORT: "", DATA_DIR: "  ", FEE_RATE: "" });
    expect(c.port).toBe(8788);
    expect(c.feeRate).toBe("0.002");
    expect(c.dataDir).toMatch(/data\/fake-local$/);
  });
  it("paper on fuji with keys", () => {
    const c = load({ EXECUTION_MODE: "paper", CHAIN: "fuji", ANTHROPIC_API_KEY: "sk-test", AGENT_PRIVATE_KEY: K1 });
    expect(c.chainId).toBe(43113);
    expect(c.dataDir).toMatch(/data\/paper-fuji$/);
  });
});

describe("refusals", () => {
  const bad: [string, Record<string, string>][] = [
    ["live + scripted", { EXECUTION_MODE: "live", LLM_PROVIDER: "scripted", CHAIN: "fuji", AGENT_PRIVATE_KEY: K1 }],
    ["live + local chain", { EXECUTION_MODE: "live", CHAIN: "local", ANTHROPIC_API_KEY: "k" }],
    ["demo + fake chain", { EXECUTION_MODE: "demo", CHAIN: "fake", ANTHROPIC_API_KEY: "k" }],
    ["non-loopback host", { ...FAKE, HOST: "0.0.0.0" }],
    ["localhost is not accepted (127.0.0.1 only)", { ...FAKE, HOST: "localhost" }],
    ["fuji without agent key", { EXECUTION_MODE: "paper", LLM_PROVIDER: "scripted", CHAIN: "fuji" }],
    ["anthropic without key", { EXECUTION_MODE: "fake", CHAIN: "local" }],
    ["bad private key", { ...FAKE, OWNER_PRIVATE_KEY: "0x1234" }],
    ["same ports", { ...FAKE, PORT: "9000", EXECUTOR_PORT: "9000" }],
    ["bad mode", { ...FAKE, EXECUTION_MODE: "yolo" }],
  ];
  for (const [name, env] of bad) {
    it(name, () => {
      expect(() => load(env)).toThrow(ConfigError);
    });
  }
  it("never echoes a secret in the error", () => {
    const leaky = "0xdeadbeef-not-a-key";
    try {
      load({ ...FAKE, AGENT_PRIVATE_KEY: leaky });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain(leaky);
    }
  });
  it("live on fuji with anthropic is allowed by config (arming is checked elsewhere)", () => {
    const c = load({ EXECUTION_MODE: "live", CHAIN: "fuji", ANTHROPIC_API_KEY: "k", AGENT_PRIVATE_KEY: K1, PORT: "8787", EXECUTOR_PORT: "8789" });
    expect(c.mode).toBe("live");
  });
});

describe(".env handling", () => {
  it("process env wins over .env, and .env is read when enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "vekil-cfg-"));
    writeFileSync(join(dir, ".env"), "EXECUTION_MODE=fake   # comment\nLLM_PROVIDER=scripted\nCHAIN=local\nPORT=9100\n");
    const c = loadConfig({ env: { PORT: "9200" }, dotenv: true, cwd: dir });
    expect(c.mode).toBe("fake");
    expect(c.port).toBe(9200);
    const d = loadConfig({ env: { ...FAKE }, dotenv: false, cwd: dir });
    expect(d.port).toBe(8788);
  });
});

describe("redactConfig", () => {
  it("hides keys", () => {
    const c = load({ ...FAKE, OWNER_PRIVATE_KEY: K0, AGENT_PRIVATE_KEY: K1 });
    const r = redactConfig(c);
    expect(JSON.stringify(r)).not.toContain(K0.slice(2));
    expect(JSON.stringify(r)).not.toContain(K1.slice(2));
    expect(r.ownerPrivateKey).toBe("***");
    expect(r.llm.apiKey).toBeNull();
    const withRpc = load({ ...FAKE, FUJI_RPC_URL: "https://rpc.example.com/v1/SECRETKEY?token=abc" });
    expect(JSON.stringify(redactConfig(withRpc))).not.toContain("SECRETKEY");
    expect(redactConfig(withRpc).rpc.fuji).toBe("https://rpc.example.com/***");
  });
});
