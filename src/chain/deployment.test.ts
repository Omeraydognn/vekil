import { describe, expect, it } from "vitest";
import { ConfigError } from "../shared/config.js";
import { loadScriptConfig } from "./deployment.js";

const K1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil account 1 (public test key)

describe("loadScriptConfig (admin scripts never call the LLM)", () => {
  it("a live .env works as is (it must name a real LLM)", () => {
    const env = { EXECUTION_MODE: "live", CHAIN: "fuji", LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", AGENT_PRIVATE_KEY: K1, PORT: "8787", EXECUTOR_PORT: "8789" };
    const c = loadScriptConfig({}, { env, dotenv: false });
    expect(c.mode).toBe("live");
    expect(c.dataDir).toMatch(/data\/live-fuji$/);
  });
  it("a dev checkout without an LLM key falls back to the scripted provider", () => {
    const c = loadScriptConfig({}, { env: { EXECUTION_MODE: "paper", CHAIN: "fuji", AGENT_PRIVATE_KEY: K1 }, dotenv: false });
    expect(c.llmProvider).toBe("scripted");
  });
  it("overrides win, and real config errors still throw", () => {
    expect(loadScriptConfig({ CHAIN: "local" }, { env: { EXECUTION_MODE: "paper" }, dotenv: false }).chain).toBe("local");
    expect(() => loadScriptConfig({}, { env: { EXECUTION_MODE: "paper", HOST: "0.0.0.0" }, dotenv: false })).toThrow(ConfigError);
  });
});

describe("loadScriptConfig error message", () => {
  it("keeps the original error when the retry fails too (live without an LLM key)", () => {
    const env = { EXECUTION_MODE: "live", CHAIN: "fuji", LLM_PROVIDER: "anthropic", AGENT_PRIVATE_KEY: K1, PORT: "8787", EXECUTOR_PORT: "8789" };
    expect(() => loadScriptConfig({}, { env, dotenv: false })).toThrow(/ANTHROPIC_API_KEY/);
  });
});
