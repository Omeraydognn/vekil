// Local chain for development, tests, smoke and probe:chain --local (SPEC §13.2).
// Starts anvil on 127.0.0.1, deploys VekilPolicy from the committed bytecode, sets the default policy.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Clock } from "../shared/interfaces.js";
import { HARD_MAX_DAILY_RISK, HARD_MAX_ORDER_QUOTE, toScaled } from "../shared/money.js";
import { defaultPolicy, type Address, type Policy } from "../shared/schemas.js";
import { SystemClock } from "../shared/time.js";
import { vekilPolicyAbi, vekilPolicyBytecode } from "./abi.js";
import { ViemPolicyChain } from "./policy-chain.js";

export const ANVIL_CHAIN_ID = 31337;
/** anvil's well-known, public test accounts (mnemonic "test test … junk"). Never use them anywhere real. */
export const ANVIL_KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // account 0
  agent: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // account 1
} as const satisfies Record<string, Hex>;

export interface AnvilHandle {
  rpcUrl: string;
  port: number;
  stop(): Promise<void>;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function rpcReady(rpcUrl: string): Promise<boolean> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Start anvil on 127.0.0.1 (given or free port). Throws if it isn't up within `timeoutMs`. */
export async function startAnvil(opts: { port?: number; timeoutMs?: number } = {}): Promise<AnvilHandle> {
  const port = opts.port ?? (await freePort());
  const rpcUrl = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(
    "anvil",
    ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(ANVIL_CHAIN_ID), "--silent"],
    { stdio: "ignore" },
  );
  let exited = false;
  let spawnError: Error | null = null;
  child.on("exit", () => (exited = true));
  child.on("error", (e) => (spawnError = e));
  const stop = async (): Promise<void> => {
    if (exited) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
        resolve();
      }, 2000).unref();
    });
  };
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`anvil failed to start: ${(spawnError as Error).message}`);
    if (exited) throw new Error("anvil exited during startup");
    if (await rpcReady(rpcUrl)) return { rpcUrl, port, stop };
    await new Promise((r) => setTimeout(r, 50));
  }
  await stop();
  throw new Error(`anvil not ready on ${rpcUrl}`);
}

export interface DeployResult {
  address: Address;
  txHash: Hex;
  deployBlock: number;
  owner: Address;
  agent: Address;
}

/** Deploy VekilPolicy from the committed bytecode. The deployer is the owner. */
export async function deployVekilPolicy(opts: {
  rpcUrl: string;
  chainId: number;
  ownerKey: Hex;
  agentAddress: string;
  hardMaxOrderQuote?: string;
  hardMaxDailyRisk?: string;
  pollingIntervalMs?: number;
  timeoutMs?: number;
}): Promise<DeployResult> {
  const chain = defineChain({
    id: opts.chainId,
    name: `chain-${opts.chainId}`,
    nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
    rpcUrls: { default: { http: [opts.rpcUrl] } },
  });
  const account = privateKeyToAccount(opts.ownerKey);
  const pollingInterval = opts.pollingIntervalMs ?? 1000;
  const wallet = createWalletClient({ account, chain, transport: http(opts.rpcUrl), pollingInterval });
  const pub = createPublicClient({ chain, transport: http(opts.rpcUrl), pollingInterval });
  const txHash = await wallet.deployContract({
    abi: vekilPolicyAbi,
    bytecode: vekilPolicyBytecode,
    args: [
      opts.agentAddress as Hex,
      toScaled(opts.hardMaxOrderQuote ?? HARD_MAX_ORDER_QUOTE),
      toScaled(opts.hardMaxDailyRisk ?? HARD_MAX_DAILY_RISK),
    ],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: opts.timeoutMs ?? 60_000, pollingInterval });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy failed: ${txHash}`);
  const blockNumber = Number(receipt.blockNumber);
  if (!Number.isSafeInteger(blockNumber)) throw new Error("deploy block out of range");
  return {
    address: receipt.contractAddress.toLowerCase() as Address,
    txHash,
    deployBlock: blockNumber,
    owner: account.address.toLowerCase() as Address,
    agent: opts.agentAddress.toLowerCase() as Address,
  };
}

export interface LocalChain {
  anvil: AnvilHandle;
  deployment: DeployResult;
  /** Signs with anvil account 1 (agent) and account 0 (owner). */
  chain: ViemPolicyChain;
  policy: Policy;
  stop(): Promise<void>;
}

/** anvil + deploy (owner #0, agent #1, caps 1000/500) + the default policy. */
export async function startLocalChain(opts: { port?: number; clock?: Clock; policy?: Policy } = {}): Promise<LocalChain> {
  const clock = opts.clock ?? new SystemClock();
  const anvil = await startAnvil(opts.port === undefined ? {} : { port: opts.port });
  try {
    const agentAddress = privateKeyToAccount(ANVIL_KEYS.agent).address;
    const deployment = await deployVekilPolicy({
      rpcUrl: anvil.rpcUrl,
      chainId: ANVIL_CHAIN_ID,
      ownerKey: ANVIL_KEYS.owner,
      agentAddress,
      pollingIntervalMs: 50,
    });
    const chain = new ViemPolicyChain({
      rpcUrl: anvil.rpcUrl,
      chainId: ANVIL_CHAIN_ID,
      address: deployment.address,
      agentKey: ANVIL_KEYS.agent,
      ownerKey: ANVIL_KEYS.owner,
      fromBlock: deployment.deployBlock,
      clock,
      pollingIntervalMs: 50,
    });
    const policy = opts.policy ?? defaultPolicy(clock.now());
    const res = await chain.setPolicy(policy);
    if (!res.ok) throw new Error(`default policy failed: ${res.error}`);
    return { anvil, deployment, chain, policy, stop: anvil.stop };
  } catch (e) {
    await anvil.stop();
    throw e;
  }
}
