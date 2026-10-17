// Chain client for VekilPolicy (SPEC §13.2). No bigint leaves this module: every output is a
// number (after a safe-integer check), a Dec string or a lowercase hex string.
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  parseEventLogs,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { lowerHex32, keccakUtf8, ZERO_HASH } from "../shared/hash.js";
import type { ChainAnchor, ChainApproval, ChainCounters, ChainView, Clock, PolicyChain } from "../shared/interfaces.js";
import { fromScaled, toScaled, toScaledSigned } from "../shared/money.js";
import { instIdHash, orderHash as computeOrderHash, toChainOrder } from "../shared/order-hash.js";
import { fromChainPolicy, toChainPolicy } from "../shared/policy-encode.js";
import { isCritical } from "../shared/reasons.js";
import {
  ChainPolicySchema,
  OrderRequestSchema,
  PolicySchema,
  type Address,
  type ChainRequestResult,
  type Hex32,
  type OrderRequest,
  type Policy,
  type TxResult,
} from "../shared/schemas.js";
import { SystemClock } from "../shared/time.js";
import { vekilPolicyAbi } from "./abi.js";

export const RECEIPT_TIMEOUT_MS = 10_000;
/** Multicall3 (same address on every EVM chain; deployed on Avalanche C-Chain and Fuji). */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_CHAINS = new Set([43113, 43114]);
/** The public Avalanche RPC refuses eth_getLogs over more than 100 blocks. */
export const AVALANCHE_LOG_RANGE = 100n;
const PREFIX30_RE = /^[0-9a-f]{30}$/;
const ZERO_BYTES32 = ZERO_HASH;

export interface ViemPolicyChainOpts {
  rpcUrl: string;
  chainId: number;
  address: string;
  /** Signs requestApproval, recordExit, anchor. */
  agentKey?: Hex;
  /** Signs setPolicy, pause, unpause, setAgentId (demo convenience, U8). */
  ownerKey?: Hex;
  /** First block to search for logs (the deploy block). */
  fromBlock?: number;
  /** Max blocks per eth_getLogs (default: 100 on Avalanche, unlimited elsewhere). */
  logRange?: number;
  clock?: Clock;
  /** Receipt polling interval; small values suit anvil. */
  pollingIntervalMs?: number;
  /** Timeout for owner/agent tx receipts other than requestApproval. */
  receiptTimeoutMs?: number;
}

/** Safe-integer conversion at the module boundary. */
export function toSafeNumber(v: bigint | number, what: string): number {
  const n = typeof v === "bigint" ? Number(v) : v;
  if (!Number.isSafeInteger(n) || (typeof v === "bigint" && BigInt(n) !== v)) throw new Error(`${what} is not a safe integer: ${v}`);
  return n;
}

export function explorerTxUrl(chainId: number, hash: string): string | null {
  if (chainId === 43113) return `https://testnet.snowtrace.io/tx/${hash}`;
  if (chainId === 43114) return `https://snowtrace.io/tx/${hash}`;
  return null;
}

function errorMessage(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { shortMessage?: unknown; message?: unknown };
    const head = typeof o.shortMessage === "string" ? o.shortMessage.split("\n")[0] : typeof o.message === "string" ? o.message.split("\n")[0] : undefined;
    // viem keeps the node's own text (e.g. "insufficient funds", "nonce too low") in `details` down the cause chain.
    let details: string | undefined;
    for (let c: unknown = e, i = 0; c && typeof c === "object" && i < 8; c = (c as { cause?: unknown }).cause, i++) {
      const d = (c as { details?: unknown }).details;
      if (typeof d === "string" && d.trim() && !d.trimStart().startsWith("<")) details = d.trim();
    }
    if (head !== undefined) return details && !head.includes(details) ? `${head} (${details.slice(0, 200)})` : head || "error";
  }
  return String(e);
}

/** Gas limit used when the node's eth_estimateGas fails with "exceeds block gas limit" (seen on some Fuji RPCs).
 * Our heaviest call (setPolicy with a long source text) stays well under it; Fuji blocks hold far more. */
export const FALLBACK_GAS = 1_500_000n;

function isBlockGasLimitError(e: unknown): boolean {
  for (let c: unknown = e, i = 0; c && typeof c === "object" && i < 8; c = (c as { cause?: unknown }).cause, i++) {
    const d = (c as { details?: unknown }).details;
    if (typeof d === "string" && /exceeds block gas limit/i.test(d)) return true;
  }
  return false;
}

/** Estimate gas as usual; only if the node refuses the estimate that way, send once more with a fixed limit. */
export async function writeWithGasFallback(write: (gas?: bigint) => Promise<Hex>, fallbackGas: bigint = FALLBACK_GAS): Promise<Hex> {
  try {
    return await write();
  } catch (e) {
    if (!isBlockGasLimitError(e)) throw e;
    return write(fallbackGas);
  }
}

const lowerAddr = (a: string): Address => a.toLowerCase() as Address;
const bytes15 = (prefix30hex: string): Hex => {
  if (!PREFIX30_RE.test(prefix30hex)) throw new Error(`not a 30-hex prefix: ${prefix30hex}`);
  return `0x${prefix30hex}`;
};

/** Serializes writes per signer so nonces never race. */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

interface Signer {
  account: Account;
  wallet: WalletClient<Transport, Chain, Account>;
  queue: SerialQueue;
}

type RawPolicy = {
  maxOrderQuote: bigint;
  dailyRiskBudget: bigint;
  maxTradesPerHour: number;
  maxTradesPerDay: number;
  minStopBps: number;
  maxStopBps: number;
  maxHoldMin: number;
  feeBps: number;
  slippageBps: number;
  validUntil: bigint;
};

export class ViemPolicyChain implements PolicyChain {
  readonly chainId: number;
  readonly address: Address;
  private readonly addr: Hex;
  private readonly chain: Chain;
  private readonly pub: PublicClient<Transport, Chain>;
  private readonly agent: Signer | null;
  private readonly owner: Signer | null;
  private readonly clock: Clock;
  private readonly fromBlock: bigint;
  /** Max blocks per eth_getLogs, or null for one query (anvil). */
  private readonly logRange: bigint | null;
  private readonly receiptTimeoutMs: number;
  private readonly pollingIntervalMs: number;
  /** sourceTextHash → text (from our own setPolicy calls or PolicySet logs). */
  private readonly sourceTexts = new Map<string, string>([[keccakUtf8(""), ""]]);
  /** instId hash → instId string (from PolicySet logs and the current policy). */
  private readonly instIds = new Map<string, string>();

  constructor(opts: ViemPolicyChainOpts) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(opts.address)) throw new Error(`bad contract address: ${opts.address}`);
    this.chainId = opts.chainId;
    this.address = lowerAddr(opts.address);
    this.addr = this.address as Hex;
    this.clock = opts.clock ?? new SystemClock();
    this.fromBlock = BigInt(opts.fromBlock ?? 0);
    this.logRange = opts.logRange !== undefined ? BigInt(opts.logRange) : MULTICALL3_CHAINS.has(opts.chainId) ? AVALANCHE_LOG_RANGE : null;
    this.receiptTimeoutMs = opts.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS;
    this.pollingIntervalMs = opts.pollingIntervalMs ?? 1000;
    this.chain = defineChain({
      id: opts.chainId,
      name: `chain-${opts.chainId}`,
      nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
      rpcUrls: { default: { http: [opts.rpcUrl] } },
      ...(MULTICALL3_CHAINS.has(opts.chainId) ? { contracts: { multicall3: { address: MULTICALL3 } } } : {}),
    });
    const transport = http(opts.rpcUrl, { retryCount: 1 });
    // On Fuji/mainnet, concurrent reads at the same block go out as one Multicall3 eth_call: the public RPC rate-limits
    // per request, and the watchers read the view every few seconds from two processes.
    const multicall = MULTICALL3_CHAINS.has(opts.chainId);
    this.pub = createPublicClient({ chain: this.chain, transport, pollingInterval: this.pollingIntervalMs, ...(multicall ? { batch: { multicall: true } } : {}) });
    const signer = (key: Hex | undefined): Signer | null => {
      if (!key) return null;
      const account = privateKeyToAccount(key);
      const wallet = createWalletClient({ account, chain: this.chain, transport, pollingInterval: this.pollingIntervalMs });
      return { account, wallet, queue: new SerialQueue() };
    };
    this.agent = signer(opts.agentKey);
    this.owner = signer(opts.ownerKey);
  }

  get agentAddress(): Address | null {
    return this.agent ? lowerAddr(this.agent.account.address) : null;
  }

  get ownerAddress(): Address | null {
    return this.owner ? lowerAddr(this.owner.account.address) : null;
  }

  explorerTxUrl(hash: string): string | null {
    return explorerTxUrl(this.chainId, hash);
  }

  // ---------------------------------------------------------------- reads

  private read<T>(functionName: string, args: readonly unknown[] = [], blockNumber?: bigint): Promise<T> {
    return this.pub.readContract({
      address: this.addr,
      abi: vekilPolicyAbi,
      functionName: functionName as never,
      args: args as never,
      ...(blockNumber === undefined ? {} : { blockNumber }),
    }) as Promise<T>;
  }

  async readView(): Promise<ChainView> {
    const block = await this.pub.getBlock({ blockTag: "latest" });
    const bn = block.number;
    const [[raw, instIds, version, isPaused, srcHash], pHash, agent, owner, agentId] = await Promise.all([
      this.read<readonly [RawPolicy, readonly string[], bigint, boolean, Hex]>("getPolicy", [], bn),
      this.read<Hex>("policyHash", [], bn),
      this.read<string>("agent", [], bn),
      this.read<string>("owner", [], bn),
      this.read<bigint>("agentId", [], bn),
    ]);
    const versionN = toSafeNumber(version, "policyVersion");
    for (const id of instIds) this.instIds.set(instIdHash(id), id);
    const sourceText = await this.sourceTextFor(lowerHex32(srcHash), versionN);
    const policy = ChainPolicySchema.parse(
      fromChainPolicy(
        {
          maxOrderQuote: raw.maxOrderQuote,
          dailyRiskBudget: raw.dailyRiskBudget,
          maxTradesPerHour: raw.maxTradesPerHour,
          maxTradesPerDay: raw.maxTradesPerDay,
          minStopBps: raw.minStopBps,
          maxStopBps: raw.maxStopBps,
          maxHoldMin: raw.maxHoldMin,
          feeBps: raw.feeBps,
          slippageBps: raw.slippageBps,
          validUntil: raw.validUntil,
        },
        [...instIds],
        sourceText,
      ),
    );
    return {
      paused: isPaused,
      policyVersion: versionN,
      policy,
      policyHash: lowerHex32(pHash),
      sourceTextHash: lowerHex32(srcHash),
      agent: lowerAddr(agent),
      owner: lowerAddr(owner),
      agentId: toSafeNumber(agentId, "agentId"),
      checkedAt: this.clock.now(),
      blockTimestamp: toSafeNumber(block.timestamp, "blockTimestamp"),
    };
  }

  /** The source text lives only in the PolicySet event (decision C2/U3). Fails closed if it can't be found. */
  private async sourceTextFor(srcHash: Hex32, version: number): Promise<string> {
    const cached = this.sourceTexts.get(srcHash);
    if (cached !== undefined) return cached;
    const matches = (l: { args: { sourceText?: string } }) => typeof l.args.sourceText === "string" && keccakUtf8(l.args.sourceText) === srcHash;
    const logs = await this.scanLogs(
      (fromBlock, toBlock) =>
        this.pub.getContractEvents({ address: this.addr, abi: vekilPolicyAbi, eventName: "PolicySet", args: { version: BigInt(version) }, fromBlock, toBlock }),
      (found) => found.some(matches),
    );
    const hit = logs.find(matches);
    if (hit?.args.sourceText !== undefined) {
      this.sourceTexts.set(srcHash, hit.args.sourceText);
      return hit.args.sourceText;
    }
    throw new Error(`source text for ${srcHash} not found in PolicySet logs`);
  }

  async counters(): Promise<ChainCounters> {
    const [hourIndex, dayIndex, hourCount, dayCount, riskUsed] =
      await this.read<readonly [bigint, bigint, number, number, bigint]>("counters");
    return {
      hourIndex: toSafeNumber(hourIndex, "hourIndex"),
      dayIndex: toSafeNumber(dayIndex, "dayIndex"),
      tradesInHour: hourCount,
      tradesInDay: dayCount,
      riskUsedToday: fromScaled(riskUsed),
    };
  }

  async latestBlockTimestamp(): Promise<number> {
    const block = await this.pub.getBlock({ blockTag: "latest" });
    return toSafeNumber(block.timestamp, "blockTimestamp");
  }

  async approval(orderHash: Hex32): Promise<ChainApproval> {
    const [status, reasons, at, expiresAt, policyVersion, worstCase] = await this.read<
      readonly [number, number, bigint, bigint, bigint, bigint]
    >("approvals", [lowerHex32(orderHash)]);
    if (status !== 0 && status !== 1 && status !== 2) throw new Error(`unknown approval status ${status}`);
    return {
      status,
      reasons,
      at: toSafeNumber(at, "approval.at"),
      expiresAt: toSafeNumber(expiresAt, "approval.expiresAt"),
      policyVersion: toSafeNumber(policyVersion, "approval.policyVersion"),
      worstCase: fromScaled(worstCase),
    };
  }

  async orderHashByPrefix(prefix30hex: string): Promise<Hex32 | null> {
    const h = lowerHex32(await this.read<Hex>("orderHashByPrefix", [bytes15(prefix30hex)]));
    return h === ZERO_BYTES32 ? null : h;
  }

  async entryByExitPrefix(prefix30hex: string): Promise<Hex32 | null> {
    const h = lowerHex32(await this.read<Hex>("entryByExitPrefix", [bytes15(prefix30hex)]));
    return h === ZERO_BYTES32 ? null : h;
  }

  async exitRecordedAt(entryOrderHash: Hex32): Promise<number> {
    return toSafeNumber(await this.read<bigint>("exitRecordedAt", [lowerHex32(entryOrderHash)]), "exitRecordedAt");
  }

  async lastAnchoredSeq(): Promise<number> {
    return toSafeNumber(await this.read<bigint>("lastAnchoredSeq"), "lastAnchoredSeq");
  }

  async readAnchors(): Promise<ChainAnchor[]> {
    const count = toSafeNumber(await this.read<bigint>("anchorCount"), "anchorCount");
    const out: ChainAnchor[] = [];
    for (let i = 0; i < count; i++) {
      const [root, fromSeq, toSeq, at] = await this.read<readonly [Hex, bigint, bigint, bigint]>("anchors", [BigInt(i)]);
      out.push({
        index: i,
        root: lowerHex32(root),
        fromSeq: toSafeNumber(fromSeq, "anchor.fromSeq"),
        toSeq: toSafeNumber(toSeq, "anchor.toSeq"),
        at: toSafeNumber(at, "anchor.at"),
      });
    }
    return out;
  }

  async verifyEntry(index: number, entryHash: Hex32, proof: Hex32[]): Promise<boolean> {
    return this.read<boolean>("verifyEntry", [BigInt(toSafeNumber(index, "index")), lowerHex32(entryHash), proof.map(lowerHex32)]);
  }

  /**
   * VEKİL Guard: what requestApproval would decide right now, as an eth_call from the agent address. No key, no tx,
   * no state change. requestApproval never reverts for policy reasons, so a rejection comes back as reason bits.
   * Setting `account` also keeps viem from batching this call into Multicall3 (msg.sender must be the agent).
   */
  async simulateApproval(req: OrderRequest): Promise<{ orderHash: Hex32; reasonsMask: number; agent: Address; blockNumber: number; blockTimestamp: number }> {
    const parsed = OrderRequestSchema.parse(req);
    const block = await this.pub.getBlock({ blockTag: "latest" });
    const agent = lowerAddr(await this.read<string>("agent", [], block.number));
    const { result } = await this.pub.simulateContract({
      address: this.addr,
      abi: vekilPolicyAbi,
      functionName: "requestApproval",
      args: [toChainOrder(parsed)],
      account: agent as Hex,
      blockNumber: block.number,
    });
    const [orderHash, reasons] = result as readonly [Hex, number];
    return {
      orderHash: lowerHex32(orderHash),
      reasonsMask: toSafeNumber(reasons, "reasons"),
      agent,
      blockNumber: toSafeNumber(block.number, "blockNumber"),
      blockTimestamp: toSafeNumber(block.timestamp, "blockTimestamp"),
    };
  }

  /** The contract's pure hashOrderFor (hash parity checks). */
  async hashOrderFor(chainId: number, policy: string, req: OrderRequest): Promise<Hex32> {
    const parsed = OrderRequestSchema.parse(req);
    return lowerHex32(await this.read<Hex>("hashOrderFor", [BigInt(toSafeNumber(chainId, "chainId")), policy, toChainOrder(parsed)]));
  }

  /** The approved request, from its OrderApproved log; instId strings come from PolicySet logs. */
  async approvedRequest(orderHash: Hex32): Promise<OrderRequest | null> {
    const logs = await this.scanLogs(
      (fromBlock, toBlock) =>
        this.pub.getContractEvents({ address: this.addr, abi: vekilPolicyAbi, eventName: "OrderApproved", args: { orderHash: lowerHex32(orderHash) }, fromBlock, toBlock }),
      (found) => found.length > 0,
    );
    const req = logs[0]?.args.req;
    if (!req) return null;
    const instId = await this.instIdString(lowerHex32(req.instId));
    if (instId === null) return null;
    return OrderRequestSchema.parse({
      instId,
      side: "buy",
      px: fromScaled(req.px),
      sz: fromScaled(req.sz),
      stopPx: fromScaled(req.stopPx),
      tpPx: fromScaled(req.tpPx),
      timeStopMin: req.timeStopMin,
      decisionHash: lowerHex32(req.decisionHash),
      nonce: lowerHex32(req.nonce),
    });
  }

  private async instIdString(hash: Hex32): Promise<string | null> {
    const known = this.instIds.get(hash);
    if (known !== undefined) return known;
    await this.scanLogs(
      (fromBlock, toBlock) => this.pub.getContractEvents({ address: this.addr, abi: vekilPolicyAbi, eventName: "PolicySet", fromBlock, toBlock }),
      (found) => {
        for (const l of found) for (const id of l.args.instIds ?? []) this.instIds.set(instIdHash(id), id);
        return this.instIds.has(hash);
      },
    );
    return this.instIds.get(hash) ?? null;
  }

  /**
   * eth_getLogs from fromBlock to latest. Where the RPC caps the range (Avalanche public RPC: 100 blocks), scan
   * backwards from the latest block in windows and stop as soon as `done` is satisfied (recent events come first).
   */
  private async scanLogs<L>(query: (fromBlock: bigint, toBlock: bigint | "latest") => Promise<L[]>, done: (found: L[]) => boolean): Promise<L[]> {
    if (this.logRange === null) return query(this.fromBlock, "latest");
    const found: L[] = [];
    let to = await this.pub.getBlockNumber();
    while (to >= this.fromBlock) {
      const from = to - this.logRange + 1n > this.fromBlock ? to - this.logRange + 1n : this.fromBlock;
      found.unshift(...(await query(from, to)));
      if (done(found)) break;
      to = from - 1n;
    }
    return found;
  }

  // ---------------------------------------------------------------- writes

  private async send(
    signer: Signer | null,
    role: "agent" | "owner",
    functionName: string,
    args: readonly unknown[],
  ): Promise<TxResult> {
    if (!signer) return { ok: false, error: `no ${role} key configured` };
    try {
      return await signer.queue.run(async () => {
        const txHash = await writeWithGasFallback((gas) =>
          signer.wallet.writeContract({
            address: this.addr,
            abi: vekilPolicyAbi,
            functionName: functionName as never,
            args: args as never,
            ...(gas ? { gas } : {}),
          } as never),
        );
        const receipt = await this.pub.waitForTransactionReceipt({
          hash: txHash,
          timeout: this.receiptTimeoutMs,
          pollingInterval: this.pollingIntervalMs,
        });
        if (receipt.status !== "success") return { ok: false as const, error: `${functionName} reverted (${txHash})` };
        return { ok: true as const, txHash: lowerHex32(txHash), blockNumber: toSafeNumber(receipt.blockNumber, "blockNumber") };
      });
    } catch (e) {
      return { ok: false, error: `${functionName}: ${errorMessage(e)}` };
    }
  }

  async requestApproval(req: OrderRequest, opts: { timeoutMs: number }): Promise<ChainRequestResult> {
    const parsed = OrderRequestSchema.parse(req);
    const orderHash = computeOrderHash(this.chainId, this.address, parsed);
    const agent = this.agent;
    if (!agent) return { ok: false, orderHash, error: "no agent key configured" };
    let txHash: Hex | null = null;
    let critical: boolean | null = null;
    try {
      await agent.queue.run(async () => {
        txHash = await writeWithGasFallback((gas) =>
          agent.wallet.writeContract({
            address: this.addr,
            abi: vekilPolicyAbi,
            functionName: "requestApproval",
            args: [toChainOrder(parsed)],
            ...(gas ? { gas } : {}),
          }),
        );
        const receipt = await this.pub.waitForTransactionReceipt({
          hash: txHash,
          timeout: opts.timeoutMs,
          pollingInterval: this.pollingIntervalMs,
        });
        if (receipt.status !== "success") throw new Error(`requestApproval reverted (${txHash})`);
        const rejected = parseEventLogs({ abi: vekilPolicyAbi, logs: receipt.logs, eventName: "OrderRejected" });
        const mine = rejected.find((l) => lowerHex32(l.args.orderHash) === orderHash);
        critical = mine ? mine.args.critical : false;
      });
    } catch (e) {
      // Not sent: nothing can be on chain for this hash.
      if (txHash === null) return { ok: false, orderHash, error: `requestApproval: ${errorMessage(e)}` };
      // Sent but no usable receipt (timeout): the chain state decides.
    }
    if (txHash === null) return { ok: false, orderHash, error: "requestApproval: no tx hash" };
    try {
      const a = await this.approval(orderHash);
      if (a.status === 0) return { ok: false, orderHash, error: `requestApproval: no recorded outcome for ${txHash}` };
      if (critical === null) critical = await this.criticalFromReasons(a.reasons, parsed);
      return {
        ok: true,
        orderHash,
        txHash: lowerHex32(txHash),
        status: a.status === 1 ? "APPROVED" : "REJECTED",
        reasonsMask: a.reasons,
        critical: a.status === 1 ? false : critical,
        policyVersion: a.policyVersion,
        worstCase: a.worstCase,
      };
    } catch (e) {
      return { ok: false, orderHash, error: `approval read: ${errorMessage(e)}` };
    }
  }

  private async criticalFromReasons(mask: number, req: OrderRequest): Promise<boolean> {
    const [raw] = await this.read<readonly [RawPolicy, readonly string[], bigint, boolean, Hex]>("getPolicy");
    const notional = (toScaled(req.px) * toScaled(req.sz)) / 100_000_000n;
    return isCritical(mask, notional, raw.maxOrderQuote);
  }

  recordExit(entryOrderHash: Hex32, exitPrefix30hex: string, reasonCode: number, pnlQuote: string): Promise<TxResult> {
    if (!Number.isInteger(reasonCode) || reasonCode < 1 || reasonCode > 6) {
      return Promise.resolve({ ok: false, error: `bad exit reason code ${reasonCode}` });
    }
    let args: readonly unknown[];
    try {
      args = [lowerHex32(entryOrderHash), bytes15(exitPrefix30hex), reasonCode, toScaledSigned(pnlQuote)];
    } catch (e) {
      return Promise.resolve({ ok: false, error: `recordExit: ${errorMessage(e)}` });
    }
    return this.send(this.agent, "agent", "recordExit", args);
  }

  anchor(root: Hex32, fromSeq: number, toSeq: number): Promise<TxResult> {
    return this.send(this.agent, "agent", "anchor", [lowerHex32(root), BigInt(fromSeq), BigInt(toSeq)]);
  }

  async setPolicy(policy: Policy): Promise<TxResult> {
    const parsed = PolicySchema.safeParse(policy);
    if (!parsed.success) return { ok: false, error: `invalid policy: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    const p = parsed.data;
    const res = await this.send(this.owner, "owner", "setPolicy", [toChainPolicy(p), p.instIds, p.sourceText]);
    if (res.ok) {
      this.sourceTexts.set(keccakUtf8(p.sourceText), p.sourceText);
      for (const id of p.instIds) this.instIds.set(instIdHash(id), id);
    }
    return res;
  }

  pause(): Promise<TxResult> {
    return this.send(this.owner, "owner", "pause", []);
  }

  unpause(): Promise<TxResult> {
    return this.send(this.owner, "owner", "unpause", []);
  }

  setAgentId(id: number): Promise<TxResult> {
    return this.send(this.owner, "owner", "setAgentId", [BigInt(toSafeNumber(id, "agentId"))]);
  }

  encodeOwnerCall(fn: "setPolicy" | "pause" | "unpause", args?: { policy: Policy }): { to: Address; data: `0x${string}`; chainId: number } {
    let data: Hex;
    if (fn === "setPolicy") {
      if (!args) throw new Error("setPolicy needs a policy");
      const p = PolicySchema.parse(args.policy);
      data = encodeFunctionData({ abi: vekilPolicyAbi, functionName: "setPolicy", args: [toChainPolicy(p), p.instIds, p.sourceText] });
    } else {
      data = encodeFunctionData({ abi: vekilPolicyAbi, functionName: fn });
    }
    return { to: this.address, data, chainId: this.chainId };
  }
}
