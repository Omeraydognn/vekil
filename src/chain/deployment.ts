// $DATA_DIR/deployment.json and the chain client for scripts and core (SPEC §13.3).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { ConfigError, loadConfig, type Config } from "../shared/config.js";
import { Address } from "../shared/schemas.js";
import { ANVIL_KEYS } from "./anvil.js";
import { ViemPolicyChain } from "./policy-chain.js";

export const DeploymentSchema = z.object({
  chainId: z.number().int(),
  address: Address,
  deployBlock: z.number().int().nonnegative(),
  txHash: z.string(),
  owner: Address,
  agent: Address,
  deployedAt: z.number().int(),
});
export type Deployment = z.infer<typeof DeploymentSchema>;

export const deploymentPath = (dataDir: string): string => join(dataDir, "deployment.json");

export function readDeployment(dataDir: string): Deployment | null {
  const p = deploymentPath(dataDir);
  if (!existsSync(p)) return null;
  return DeploymentSchema.parse(JSON.parse(readFileSync(p, "utf8")));
}

export function writeDeployment(dataDir: string, d: Deployment): void {
  const p = deploymentPath(dataDir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(DeploymentSchema.parse(d), null, 2) + "\n");
  renameSync(tmp, p);
}

/** The keys for this chain: anvil accounts on local, the configured keys elsewhere. */
export function chainKeys(cfg: Config): { agentKey: Hex | null; ownerKey: Hex | null } {
  if (cfg.chain === "local" || cfg.chain === "fake") return { agentKey: ANVIL_KEYS.agent, ownerKey: ANVIL_KEYS.owner };
  return { agentKey: cfg.agentPrivateKey, ownerKey: cfg.ownerPrivateKey };
}

export const addressOf = (key: Hex): `0x${string}` => privateKeyToAccount(key).address.toLowerCase() as `0x${string}`;

/** Chain client for the deployed contract (VEKIL_POLICY_ADDRESS overrides deployment.json). */
export function openPolicyChain(cfg: Config, opts: { owner?: boolean; agent?: boolean } = {}): { chain: ViemPolicyChain; deployment: Deployment | null } {
  if (cfg.chain === "fake" || cfg.rpcUrl === null) throw new Error("CHAIN=fake has no contract to talk to");
  const deployment = readDeployment(cfg.dataDir);
  const address = cfg.vekilPolicyAddress ?? deployment?.address;
  if (!address) throw new Error(`no contract: run the deploy first or set VEKIL_POLICY_ADDRESS (${deploymentPath(cfg.dataDir)} missing)`);
  if (deployment && deployment.chainId !== cfg.chainId) throw new Error(`deployment.json is for chainId ${deployment.chainId}, not ${cfg.chainId}`);
  const keys = chainKeys(cfg);
  if (opts.owner && !keys.ownerKey) throw new Error("OWNER_PRIVATE_KEY is required");
  if (opts.agent && !keys.agentKey) throw new Error("AGENT_PRIVATE_KEY is required");
  const chain = new ViemPolicyChain({
    rpcUrl: cfg.rpcUrl,
    chainId: cfg.chainId,
    address,
    ...(opts.agent && keys.agentKey ? { agentKey: keys.agentKey } : {}),
    ...(opts.owner && keys.ownerKey ? { ownerKey: keys.ownerKey } : {}),
    ...(deployment && deployment.address === address.toLowerCase() ? { fromBlock: deployment.deployBlock } : {}),
    pollingIntervalMs: cfg.chain === "local" ? 100 : 1000,
  });
  return { chain, deployment };
}

/**
 * Config for admin scripts that never call the LLM (deploy, policy-set without --text, kill, resume, verify, audit…).
 * The real config first, so a live/demo .env (which must name a real LLM) works as is; on a ConfigError retry once with
 * the scripted provider (dev checkouts without an LLM key; config still refuses scripted for demo/live). If the retry
 * fails too, the original error is thrown, since it names the real problem. `over` wins over both (e.g. CHAIN).
 */
export function loadScriptConfig(over: Record<string, string> = {}, base: { env?: NodeJS.ProcessEnv; dotenv?: boolean } = {}): Config {
  const env = base.env ?? process.env;
  const dotenv = base.dotenv ?? true;
  try {
    return loadConfig({ env: { ...env, ...over }, dotenv });
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    try {
      return loadConfig({ env: { ...env, LLM_PROVIDER: "scripted", ...over }, dotenv });
    } catch {
      throw e;
    }
  }
}

/** Script arguments without a stray "--" (SPEC §7). */
export const scriptArgs = (): string[] => process.argv.slice(2).filter((a) => a !== "--");

/** Ask on a TTY; `expected` must be typed exactly. Non-TTY → false. */
export async function confirmTty(question: string, expected: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${question} `)).trim() === expected;
  } finally {
    rl.close();
  }
}

/**
 * Owner/admin chain transactions ask first (CLAUDE.md commands table): local → no prompt;
 * fuji → "y" on a TTY, or --yes; mainnet → TTY + "MAINNET" always (SPEC §8.4).
 */
export async function confirmChainWrite(cfg: Config, what: string, args: string[]): Promise<void> {
  if (cfg.chain === "local" || cfg.chain === "fake") return;
  if (cfg.chain === "mainnet") {
    if (!(await confirmTty(`${what} on MAINNET. Type MAINNET to continue:`, "MAINNET"))) throw new Error("mainnet needs a TTY and MAINNET");
    return;
  }
  if (args.includes("--yes")) return;
  if (!(await confirmTty(`${what} on ${cfg.chain} (chainId ${cfg.chainId}). Continue? [y/N]`, "y"))) throw new Error("not confirmed (use a TTY or --yes)");
}
