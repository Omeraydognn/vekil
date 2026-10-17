// Configuration (SPEC §8). Process env overrides .env; empty strings count as unset.
// Secrets are never echoed in errors or logs (use redactConfig).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { z } from "zod";
import { ChainNameSchema, Dec, InstId, ModeSchema, PDec } from "./schemas.js";

export const CHAIN_IDS = { fake: 31337, local: 31337, fuji: 43113, mainnet: 43114 } as const;
const LOOPBACK = new Set(["127.0.0.1"]);
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

const emptyToUndef = (v: unknown): unknown => (typeof v === "string" && v.trim() === "" ? undefined : v);
const str = (def: string) => z.string().default(def);
const optStr = () => z.string().optional();
const int = (def: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(def);
const port = (def: number) => int(def, 1, 65535);
const secret = z.string().regex(PRIVATE_KEY_RE, "must be 0x + 64 hex").optional();

const EnvSchema = z.object({
  EXECUTION_MODE: ModeSchema.default("paper"),
  LLM_PROVIDER: z.enum(["anthropic", "openrouter", "scripted"]).default("anthropic"),
  CHAIN: ChainNameSchema.default("fuji"),
  DATA_DIR: optStr(),
  INST_ID: InstId.default("AVAX-TRY"),
  STRATEGY_PROFILE: z.enum(["standard", "active"]).default("standard"),
  ATK_READ_PROFILE: str("tr-read"),
  ATK_READ_MODULES: str("market,account,spot"),
  ATK_TRADE_PROFILE: str("tr-trade"),
  ATK_DEMO_PROFILE: str("tr-demo"),
  FEE_RATE: Dec.default("0.002"),
  PAPER_START_QUOTE: PDec.default("1000"),
  MAX_SPREAD_PCT: PDec.default("0.3"),
  PRICE_COLLAR_PCT: PDec.default("1"),
  MAX_SNAPSHOT_AGE_SEC: int(15, 1, 3600),
  COOLDOWN_AFTER_LOSS_MIN: int(60, 0, 1440),
  ANTHROPIC_API_KEY: optStr(),
  OPENROUTER_API_KEY: optStr(),
  LLM_MODEL: str("claude-sonnet-5-5"),
  LLM_BASE_URL: z.string().url().optional(),
  LLM_MAX_TOOL_CALLS: int(8, 2, 50),
  LLM_CYCLE_TIMEOUT_SEC: int(60, 5, 600),
  LLM_MAX_CYCLES_PER_HOUR: int(20, 1, 200),
  LOCAL_RPC_URL: str("http://127.0.0.1:8545"),
  FUJI_RPC_URL: str("https://api.avax-test.network/ext/bc/C/rpc"),
  MAINNET_RPC_URL: str("https://api.avax.network/ext/bc/C/rpc"),
  AGENT_PRIVATE_KEY: secret,
  OWNER_PRIVATE_KEY: secret,
  VEKIL_POLICY_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  ERC8004_IDENTITY_REGISTRY: z.string().regex(/^0x[0-9a-fA-F]{40}$/).default("0x8004A818BFB912233c491871b3d84c89A494BD9e"),
  HOST: str("127.0.0.1"),
  PORT: port(8788),
  EXECUTOR_PORT: port(8790),
  MONITOR_INTERVAL_SEC: int(10, 1, 600),
  CHAIN_WATCH_INTERVAL_SEC: int(3, 1, 600),
  ANCHOR_INTERVAL_MIN: int(60, 1, 1440),
  I_CONFIRM_NO_WITHDRAW: optStr(),
});

export interface Config {
  mode: z.infer<typeof ModeSchema>;
  llmProvider: "anthropic" | "openrouter" | "scripted";
  chain: z.infer<typeof ChainNameSchema>;
  chainId: number;
  rpcUrl: string | null;
  dataDir: string;
  instId: string;
  strategyProfile: "standard" | "active";
  atk: { readProfile: string; readModules: string[]; tradeProfile: string; demoProfile: string };
  feeRate: string;
  paperStartQuote: string;
  preflight: { maxSpreadPct: string; priceCollarPct: string; maxSnapshotAgeSec: number; cooldownAfterLossMin: number };
  llm: { apiKey: string | null; model: string; baseUrl: string | null; maxToolCalls: number; cycleTimeoutSec: number; maxCyclesPerHour: number };
  rpc: { local: string; fuji: string; mainnet: string };
  agentPrivateKey: `0x${string}` | null;
  ownerPrivateKey: `0x${string}` | null;
  vekilPolicyAddress: string | null;
  erc8004IdentityRegistry: string;
  host: string;
  port: number;
  executorPort: number;
  monitorIntervalSec: number;
  chainWatchIntervalSec: number;
  anchorIntervalMin: number;
  iConfirmNoWithdraw: boolean;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface LoadConfigOpts {
  /** Process environment (default process.env). Wins over .env. */
  env?: NodeJS.ProcessEnv;
  /** Read .env from cwd (default true). Tests and smoke pass false. */
  dotenv?: boolean;
  cwd?: string;
}

function mergedEnv(opts: LoadConfigOpts): Record<string, unknown> {
  const env = opts.env ?? process.env;
  let file: Record<string, string> = {};
  if (opts.dotenv ?? true) {
    const p = resolve(opts.cwd ?? process.cwd(), ".env");
    if (existsSync(p)) file = parseDotenv(readFileSync(p));
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(EnvSchema.shape)) {
    const v = emptyToUndef(env[k]) ?? emptyToUndef(file[k]);
    if (v !== undefined) out[k] = typeof v === "string" ? v.trim() : v;
  }
  return out;
}

export function loadConfig(opts: LoadConfigOpts = {}): Config {
  const parsed = EnvSchema.safeParse(mergedEnv(opts));
  if (!parsed.success) {
    // Only names and messages; never the values (some are secrets).
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`invalid configuration: ${msg}`);
  }
  const e = parsed.data;
  const errors: string[] = [];

  if ((e.EXECUTION_MODE === "demo" || e.EXECUTION_MODE === "live") &&
      !(e.LLM_PROVIDER !== "scripted" && (e.CHAIN === "fuji" || e.CHAIN === "mainnet"))) {
    errors.push("demo/live require a real LLM (LLM_PROVIDER=anthropic or openrouter) and CHAIN=fuji or mainnet");
  }
  if (!LOOPBACK.has(e.HOST)) errors.push("HOST must be a loopback address (127.0.0.1)");
  if (e.PORT === e.EXECUTOR_PORT) errors.push("PORT and EXECUTOR_PORT must differ");
  if ((e.CHAIN === "fuji" || e.CHAIN === "mainnet") && !e.AGENT_PRIVATE_KEY) {
    errors.push(`AGENT_PRIVATE_KEY is required for CHAIN=${e.CHAIN}`);
  }
  if (e.LLM_PROVIDER === "anthropic" && !e.ANTHROPIC_API_KEY) errors.push("ANTHROPIC_API_KEY is required for LLM_PROVIDER=anthropic");
  if (e.LLM_PROVIDER === "openrouter" && !e.OPENROUTER_API_KEY) errors.push("OPENROUTER_API_KEY is required for LLM_PROVIDER=openrouter");
  if (e.LLM_BASE_URL) {
    const u = new URL(e.LLM_BASE_URL);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) errors.push("LLM_BASE_URL must be https (http only for 127.0.0.1)");
  }
  if (e.LLM_PROVIDER === "openrouter" && !e.LLM_BASE_URL && !e.LLM_MODEL.includes("/")) errors.push("LLM_PROVIDER=openrouter needs an OpenRouter model id in LLM_MODEL (e.g. vendor/model:free)");
  const readModules = e.ATK_READ_MODULES.split(",").map((m) => m.trim()).filter(Boolean);
  if (readModules.length === 0) errors.push("ATK_READ_MODULES must list at least one module");
  if (errors.length) throw new ConfigError(errors.join("; "));

  const rpc = { local: e.LOCAL_RPC_URL, fuji: e.FUJI_RPC_URL, mainnet: e.MAINNET_RPC_URL };
  return {
    mode: e.EXECUTION_MODE,
    llmProvider: e.LLM_PROVIDER,
    chain: e.CHAIN,
    chainId: CHAIN_IDS[e.CHAIN],
    rpcUrl: e.CHAIN === "fake" ? null : rpc[e.CHAIN],
    dataDir: resolve(opts.cwd ?? process.cwd(), e.DATA_DIR ?? `data/${e.EXECUTION_MODE}-${e.CHAIN}`),
    instId: e.INST_ID,
    strategyProfile: e.STRATEGY_PROFILE,
    atk: { readProfile: e.ATK_READ_PROFILE, readModules, tradeProfile: e.ATK_TRADE_PROFILE, demoProfile: e.ATK_DEMO_PROFILE },
    feeRate: e.FEE_RATE,
    paperStartQuote: e.PAPER_START_QUOTE,
    preflight: {
      maxSpreadPct: e.MAX_SPREAD_PCT,
      priceCollarPct: e.PRICE_COLLAR_PCT,
      maxSnapshotAgeSec: e.MAX_SNAPSHOT_AGE_SEC,
      cooldownAfterLossMin: e.COOLDOWN_AFTER_LOSS_MIN,
    },
    llm: {
      apiKey: (e.LLM_PROVIDER === "openrouter" ? e.OPENROUTER_API_KEY : e.ANTHROPIC_API_KEY) ?? null,
      model: e.LLM_MODEL,
      baseUrl: e.LLM_BASE_URL ?? null,
      maxToolCalls: e.LLM_MAX_TOOL_CALLS,
      cycleTimeoutSec: e.LLM_CYCLE_TIMEOUT_SEC,
      maxCyclesPerHour: e.LLM_MAX_CYCLES_PER_HOUR,
    },
    rpc,
    agentPrivateKey: (e.AGENT_PRIVATE_KEY as `0x${string}` | undefined) ?? null,
    ownerPrivateKey: (e.OWNER_PRIVATE_KEY as `0x${string}` | undefined) ?? null,
    vekilPolicyAddress: e.VEKIL_POLICY_ADDRESS?.toLowerCase() ?? null,
    erc8004IdentityRegistry: e.ERC8004_IDENTITY_REGISTRY.toLowerCase(),
    host: e.HOST,
    port: e.PORT,
    executorPort: e.EXECUTOR_PORT,
    monitorIntervalSec: e.MONITOR_INTERVAL_SEC,
    chainWatchIntervalSec: e.CHAIN_WATCH_INTERVAL_SEC,
    anchorIntervalMin: e.ANCHOR_INTERVAL_MIN,
    iConfirmNoWithdraw: e.I_CONFIRM_NO_WITHDRAW === "yes",
  };
}

/** Safe for logs: secrets replaced by "***" (or null when unset). */
export function redactConfig(c: Config): Config {
  const r = (v: string | null): string | null => (v ? "***" : null);
  // RPC URLs can embed provider keys: keep only protocol + host.
  const origin = (u: string): string => {
    try {
      return `${new URL(u).protocol}//${new URL(u).host}/***`;
    } catch {
      return "***";
    }
  };
  return {
    ...c,
    rpcUrl: c.rpcUrl === null ? null : origin(c.rpcUrl),
    rpc: { local: origin(c.rpc.local), fuji: origin(c.rpc.fuji), mainnet: origin(c.rpc.mainnet) },
    llm: { ...c.llm, apiKey: r(c.llm.apiKey), baseUrl: c.llm.baseUrl === null ? null : origin(c.llm.baseUrl) },
    agentPrivateKey: r(c.agentPrivateKey) as `0x${string}` | null,
    ownerPrivateKey: r(c.ownerPrivateKey) as `0x${string}` | null,
  };
}
