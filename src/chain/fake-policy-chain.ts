// In-memory PolicyChain for unit tests and CHAIN=fake UI work (SPEC §13.2). Smoke uses the real contract.
// Rules: rejects when paused, the instrument isn't allowed, the stop is missing, or notional > max;
// critical (and pauses) for the instrument, the stop, or notional > 2× max. Otherwise approves.
// No counters. Tests can script responses with scriptNext().
import { encodeFunctionData } from "viem";
import { keccakUtf8, lowerHex32 } from "../shared/hash.js";
import type { ChainAnchor, ChainApproval, ChainCounters, ChainView, Clock, PolicyChain } from "../shared/interfaces.js";
import { verifyMerkleProof } from "../shared/merkle.js";
import { decGt, decMul, round8Down } from "../shared/money.js";
import { orderHash as computeOrderHash, toChainOrder } from "../shared/order-hash.js";
import { policyHash, sourceTextHash, toChainPolicy } from "../shared/policy-encode.js";
import { CRITICAL_MASK, policyReasonBit, type PolicyReason } from "../shared/reasons.js";
import {
  OrderRequestSchema,
  PolicySchema,
  defaultPolicy,
  type Address,
  type ChainRequestResult,
  type Hex32,
  type OrderRequest,
  type Policy,
  type TxResult,
} from "../shared/schemas.js";
import { dayIndex, hourIndex, msToSec } from "../shared/time.js";
import { vekilPolicyAbi } from "./abi.js";
import { explorerTxUrl } from "./policy-chain.js";

export const FAKE_POLICY_ADDRESS = "0x000000000000000000000000000000000000fa4e" as Address;
export const FAKE_AGENT = "0x00000000000000000000000000000000000a6e47" as Address;
export const FAKE_OWNER = "0x00000000000000000000000000000000000a11ce" as Address;

/** A scripted response: a mask to record (0 = approve), or a failure. */
export type FakeScript = { reasons: PolicyReason[]; critical?: boolean } | { fail: string };

interface StoredApproval extends ChainApproval {
  req: OrderRequest;
}

export class FakePolicyChain implements PolicyChain {
  readonly chainId: number;
  readonly address: Address;
  paused = false;
  policyVersion = 0;
  policy: Policy;
  agentId = 0;
  /** Every write, in order (for test assertions). */
  readonly txLog: { fn: string; txHash: Hex32 }[] = [];
  private readonly clock: Clock;
  private readonly approvals = new Map<string, StoredApproval>();
  private readonly byPrefix = new Map<string, Hex32>();
  private readonly byExitPrefix = new Map<string, Hex32>();
  private readonly exits = new Map<string, number>();
  private readonly anchors: ChainAnchor[] = [];
  private readonly scripts: FakeScript[] = [];
  private block = 0;

  constructor(opts: { clock: Clock; policy?: Policy; chainId?: number; address?: Address }) {
    this.clock = opts.clock;
    this.chainId = opts.chainId ?? 31337;
    this.address = opts.address ?? FAKE_POLICY_ADDRESS;
    this.policy = opts.policy ?? defaultPolicy(opts.clock.now());
    this.policyVersion = 1;
  }

  /** Queue a response for the next requestApproval call. */
  scriptNext(s: FakeScript): void {
    this.scripts.push(s);
  }

  explorerTxUrl(hash: string): string | null {
    return explorerTxUrl(this.chainId, hash);
  }

  private nowSec(): number {
    return msToSec(this.clock.now());
  }

  private tx(fn: string): TxResult & { ok: true } {
    this.block += 1;
    const txHash = keccakUtf8(`fake-tx-${this.block}-${fn}`);
    this.txLog.push({ fn, txHash });
    return { ok: true, txHash, blockNumber: this.block };
  }

  async readView(): Promise<ChainView> {
    return {
      paused: this.paused,
      policyVersion: this.policyVersion,
      policy: structuredClone(this.policy),
      policyHash: policyHash(this.policy),
      sourceTextHash: sourceTextHash(this.policy.sourceText),
      agent: FAKE_AGENT,
      owner: FAKE_OWNER,
      agentId: this.agentId,
      checkedAt: this.clock.now(),
      blockTimestamp: this.nowSec(),
    };
  }

  async counters(): Promise<ChainCounters> {
    const sec = this.nowSec();
    return { hourIndex: hourIndex(sec), dayIndex: dayIndex(sec), tradesInHour: 0, tradesInDay: 0, riskUsedToday: "0" };
  }

  async latestBlockTimestamp(): Promise<number> {
    return this.nowSec();
  }

  async requestApproval(req: OrderRequest, _opts: { timeoutMs: number }): Promise<ChainRequestResult> {
    const parsed = OrderRequestSchema.parse(req);
    toChainOrder(parsed); // same encoding checks as the real client
    const orderHash = computeOrderHash(this.chainId, this.address, parsed);
    if (this.approvals.has(orderHash)) return { ok: false, orderHash, error: "requestApproval: AlreadyRequested()" };

    const script = this.scripts.shift();
    if (script && "fail" in script) return { ok: false, orderHash, error: script.fail };

    let reasons: PolicyReason[];
    let critical: boolean;
    if (script) {
      reasons = script.reasons;
      const mask = reasons.reduce((m, r) => m | (1 << policyReasonBit(r)), 0);
      critical = script.critical ?? (mask & CRITICAL_MASK) !== 0;
    } else {
      const notional = round8Down(decMul(parsed.px, parsed.sz));
      reasons = [];
      if (this.paused) reasons.push("PAUSED");
      if (!this.policy.instIds.includes(parsed.instId)) reasons.push("INSTRUMENT_NOT_ALLOWED");
      if (decGt(notional, this.policy.maxOrderQuote)) reasons.push("ORDER_TOO_LARGE");
      if (!decGt(parsed.stopPx, "0")) reasons.push("STOP_MISSING");
      critical =
        reasons.includes("INSTRUMENT_NOT_ALLOWED") ||
        reasons.includes("STOP_MISSING") ||
        decGt(notional, decMul(this.policy.maxOrderQuote, "2"));
    }
    const mask = reasons.reduce((m, r) => m | (1 << policyReasonBit(r)), 0);
    const { txHash } = this.tx("requestApproval");
    const at = this.nowSec();
    const approved = mask === 0;
    this.approvals.set(orderHash, {
      status: approved ? 1 : 2,
      reasons: mask,
      at,
      expiresAt: approved ? at + 120 : 0,
      policyVersion: this.policyVersion,
      worstCase: "0",
      req: parsed,
    });
    if (approved) this.byPrefix.set(orderHash.slice(2, 32), orderHash);
    if (!approved && critical) this.paused = true;
    return {
      ok: true,
      orderHash,
      txHash,
      status: approved ? "APPROVED" : "REJECTED",
      reasonsMask: mask,
      critical: approved ? false : critical,
      policyVersion: this.policyVersion,
      worstCase: "0",
    };
  }

  async approval(orderHash: Hex32): Promise<ChainApproval> {
    const a = this.approvals.get(lowerHex32(orderHash));
    if (!a) return { status: 0, reasons: 0, at: 0, expiresAt: 0, policyVersion: 0, worstCase: "0" };
    const { req: _req, ...rest } = a;
    return rest;
  }

  async orderHashByPrefix(prefix30hex: string): Promise<Hex32 | null> {
    return this.byPrefix.get(prefix30hex) ?? null;
  }

  async entryByExitPrefix(prefix30hex: string): Promise<Hex32 | null> {
    return this.byExitPrefix.get(prefix30hex) ?? null;
  }

  async recordExit(entryOrderHash: Hex32, exitPrefix30hex: string, reasonCode: number, _pnlQuote: string): Promise<TxResult> {
    const h = lowerHex32(entryOrderHash);
    if (this.approvals.get(h)?.status !== 1) return { ok: false, error: "recordExit: UnknownEntry()" };
    if (this.exits.has(h)) return { ok: false, error: "recordExit: ExitAlreadyRecorded()" };
    if (!Number.isInteger(reasonCode) || reasonCode < 1 || reasonCode > 6) return { ok: false, error: "recordExit: BadExitReason()" };
    if (!/^[0-9a-f]{30}$/.test(exitPrefix30hex)) return { ok: false, error: "recordExit: bad prefix" };
    this.exits.set(h, this.nowSec());
    this.byExitPrefix.set(exitPrefix30hex, h);
    return this.tx("recordExit");
  }

  async exitRecordedAt(entryOrderHash: Hex32): Promise<number> {
    return this.exits.get(lowerHex32(entryOrderHash)) ?? 0;
  }

  async lastAnchoredSeq(): Promise<number> {
    return this.anchors.at(-1)?.toSeq ?? 0;
  }

  async anchor(root: Hex32, fromSeq: number, toSeq: number): Promise<TxResult> {
    const last = await this.lastAnchoredSeq();
    if (fromSeq !== last + 1 || toSeq < fromSeq) return { ok: false, error: "anchor: BadAnchorRange()" };
    this.anchors.push({ index: this.anchors.length, root: lowerHex32(root), fromSeq, toSeq, at: this.nowSec() });
    return this.tx("anchor");
  }

  async readAnchors(): Promise<ChainAnchor[]> {
    return this.anchors.map((a) => ({ ...a }));
  }

  async verifyEntry(index: number, entryHash: Hex32, proof: Hex32[]): Promise<boolean> {
    const a = this.anchors[index];
    return a !== undefined && verifyMerkleProof(entryHash, proof, a.root);
  }

  async approvedRequest(orderHash: Hex32): Promise<OrderRequest | null> {
    const a = this.approvals.get(lowerHex32(orderHash));
    return a && a.status === 1 ? structuredClone(a.req) : null;
  }

  async setPolicy(policy: Policy): Promise<TxResult> {
    const parsed = PolicySchema.safeParse(policy);
    if (!parsed.success) return { ok: false, error: "setPolicy: InvalidPolicy()" };
    if (parsed.data.validUntil <= this.clock.now()) return { ok: false, error: "setPolicy: InvalidPolicy()" };
    this.policy = structuredClone(parsed.data);
    this.policyVersion += 1;
    return this.tx("setPolicy");
  }

  async pause(): Promise<TxResult> {
    this.paused = true;
    return this.tx("pause");
  }

  async unpause(): Promise<TxResult> {
    this.paused = false;
    return this.tx("unpause");
  }

  async setAgentId(id: number): Promise<TxResult> {
    this.agentId = id;
    return this.tx("setAgentId");
  }

  encodeOwnerCall(fn: "setPolicy" | "pause" | "unpause", args?: { policy: Policy }): { to: Address; data: `0x${string}`; chainId: number } {
    let data: `0x${string}`;
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
