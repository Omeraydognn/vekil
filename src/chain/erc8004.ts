// ERC-8004 Identity Registry (SPEC §13.4, M15). ABI verified on Fuji 17 Oct 2026: the registry at
// 0x8004A818BFB912233c491871b3d84c89A494BD9e is an ERC-1967 proxy (name "AgentIdentity", symbol "AGENT") whose
// implementation (0x7274e874ca62410a93bd8bf61c69d8045e399c02) contains the selectors below and the Registered and
// ERC-721 Transfer event topics. The agentId is the ERC-721 tokenId minted to the caller.
import { createPublicClient, createWalletClient, defineChain, http, parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toSafeNumber, writeWithGasFallback } from "./policy-chain.js";

export const erc8004IdentityAbi = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ name: "agentId", type: "uint256" }] },
  { type: "function", name: "setAgentURI", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "newURI", type: "string" }], outputs: [] },
  { type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

export interface AgentCardInput {
  chainId: number;
  agent: string;
  policy: string;
  registry: string;
  repo: string;
  guardManifest?: string;
}

/** EIP-8004 registration file (agent card). */
export function agentCard(c: AgentCardInput) {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "VEKİL",
    description:
      "Autonomous AVAX-TRY spot agent on OKX TR (Agent Trade Kit). The owner's Turkish rules live in the VekilPolicy contract on Avalanche; every order needs an on-chain approval, critical violations pause the agent, and an isolated executor trades only what the chain approved.",
    endpoints: [
      { name: "agentWallet", endpoint: `eip155:${c.chainId}:${c.agent.toLowerCase()}` },
      { name: "VekilPolicy", endpoint: `eip155:${c.chainId}:${c.policy.toLowerCase()}` },
      ...(c.guardManifest ? [{ name: "VEKİL Guard", endpoint: c.guardManifest }] : []),
      { name: "source", endpoint: c.repo },
    ],
    registrations: [{ agentRegistry: `eip155:${c.chainId}:${c.registry.toLowerCase()}` }],
    supportedTrust: ["crypto-economic"],
  };
}

/** agentURI as a data: URI (works whether or not the repo is public). */
export function dataUri(card: object): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(card), "utf8").toString("base64")}`;
}

export interface RegisterResult {
  agentId: number;
  txHash: Hex;
}

type ReceiptLog = { address: string; topics: readonly Hex[] | [Hex, ...Hex[]] | []; data: Hex };

/** agentId from the registry's ERC-721 mint log (Transfer from 0 to the owner). Throws if absent. */
export function agentIdFromLogs(logs: readonly ReceiptLog[], registry: string, owner: string): number {
  const minted = parseEventLogs({ abi: erc8004IdentityAbi, logs: logs as never, eventName: "Transfer" }).find(
    (l) => l.address.toLowerCase() === registry.toLowerCase() && BigInt(l.args.from) === 0n && l.args.to.toLowerCase() === owner.toLowerCase(),
  );
  if (!minted) throw new Error("no ERC-8004 mint (Transfer from 0 to the owner) in the receipt");
  return toSafeNumber(minted.args.tokenId, "agentId");
}

function clients(rpcUrl: string, chainId: number, ownerKey: Hex) {
  const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const account = privateKeyToAccount(ownerKey);
  return { account, pub: createPublicClient({ chain, transport: http(rpcUrl) }), wallet: createWalletClient({ account, chain, transport: http(rpcUrl) }) };
}

/** Finish a register tx that was already sent (re-run after a timeout): never mints twice. */
export async function resumeRegister(opts: { rpcUrl: string; chainId: number; registry: string; ownerKey: Hex; txHash: Hex }): Promise<RegisterResult> {
  const { account, pub } = clients(opts.rpcUrl, opts.chainId, opts.ownerKey);
  const receipt = await pub.waitForTransactionReceipt({ hash: opts.txHash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`register reverted (${opts.txHash})`);
  return { agentId: agentIdFromLogs(receipt.logs, opts.registry, account.address), txHash: opts.txHash };
}

/**
 * register(agentURI) from the owner key. dryRun = eth_call only (predicted agentId, nothing sent).
 * The agentId comes from the ERC-721 Transfer(0 → owner) log of the receipt.
 */
export async function registerAgent(opts: {
  rpcUrl: string;
  chainId: number;
  registry: string;
  ownerKey: Hex;
  agentURI: string;
  dryRun?: boolean;
  /** Called with the tx hash right after sending, before waiting: persist it so a re-run resumes instead of minting again. */
  onSent?: (txHash: Hex) => void;
}): Promise<RegisterResult | { agentId: number; txHash: null }> {
  const { account, pub, wallet } = clients(opts.rpcUrl, opts.chainId, opts.ownerKey);
  const sim = await pub.simulateContract({ address: opts.registry as Hex, abi: erc8004IdentityAbi, functionName: "register", args: [opts.agentURI], account });
  const predicted = toSafeNumber(sim.result, "agentId");
  if (opts.dryRun) return { agentId: predicted, txHash: null };
  // Some public Fuji RPCs return an absurd gas estimate ("exceeds block gas limit"): retry once with a fixed limit
  // (a ~1 KB agentURI costs well under 1.5M gas).
  const txHash = await writeWithGasFallback((gas) => wallet.writeContract({ ...sim.request, ...(gas ? { gas } : {}) }));
  opts.onSent?.(txHash);
  return resumeRegister({ rpcUrl: opts.rpcUrl, chainId: opts.chainId, registry: opts.registry, ownerKey: opts.ownerKey, txHash });
}
