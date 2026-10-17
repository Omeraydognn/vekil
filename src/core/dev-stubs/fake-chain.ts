// DEV STUB (deleted at M2): an in-memory PolicyChain with the FakePolicyChain rules of SPEC §13.2.
// Rejects a foreign instrument, a missing stop or notional > max; critical (and pauses) for the instrument,
// the stop or notional > 2× max. Otherwise approves. Tests can hook every write.
import { encodeFunctionData } from "viem";
import type { ChainAnchor, ChainApproval, ChainCounters, ChainView, Clock, PolicyChain } from "../../shared/interfaces.js";
import { keccakUtf8 } from "../../shared/hash.js";
import { verifyMerkleProof } from "../../shared/merkle.js";
import { D, decAdd, decGt, decMul, toDecString } from "../../shared/money.js";
import { entryClOrdId, hashPrefix30, orderHash as computeOrderHash } from "../../shared/order-hash.js";
import { policyHash, sourceTextHash } from "../../shared/policy-encode.js";
import { maskToReasons, reasonsToMask, type PolicyReason } from "../../shared/reasons.js";
import type { Address, ChainRequestResult, Hex32, OrderRequest, Policy, SDec, TxResult } from "../../shared/schemas.js";
import { dayIndex, hourIndex, msToSec } from "../../shared/time.js";

export type FakeChainWrite = "requestApproval" | "recordExit" | "anchor" | "setPolicy" | "pause" | "unpause" | "setAgentId";

export interface FakeChainOpts {
  clock: Clock;
  policy: Policy;
  address?: Address;
  agent?: Address;
  owner?: Address;
  chainId?: number;
  /** Runs before every write; throw to fail it, await to delay it. */
  beforeWrite?: (fn: FakeChainWrite, args: unknown[]) => Promise<void> | void;
}

const ANVIL0 = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as Address;
const ANVIL1 = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as Address;

export class FakePolicyChain implements PolicyChain {
  readonly chainId: number;
  readonly address: Address;
  readonly agent: Address;
  readonly owner: Address;
  policy: Policy;
  policyVersion = 1;
  paused = false;
  agentId = 0;
  beforeWrite: FakeChainOpts["beforeWrite"];
  /** Every write that succeeded, in order (tests). */
  readonly writes: { fn: FakeChainWrite; args: unknown[] }[] = [];
  private readonly clock: Clock;
  private txN = 0;
  private approvals = new Map<Hex32, ChainApproval>();
  private requests = new Map<Hex32, OrderRequest>();
  private byPrefix = new Map<string, Hex32>();
  private exitAt = new Map<Hex32, number>();
  private exitByPrefix = new Map<string, Hex32>();
  private anchors: ChainAnchor[] = [];
  private lastSeq = 0;
  private hourCount = new Map<number, number>();
  private dayCount = new Map<number, number>();
  private dayRisk = new Map<number, string>();

  constructor(o: FakeChainOpts) {
    this.clock = o.clock;
    this.policy = o.policy;
    this.chainId = o.chainId ?? 31337;
    this.address = o.address ?? "0x5fbdb2315678afecb367f032d93f642f64180aa3";
    this.agent = o.agent ?? ANVIL1;
    this.owner = o.owner ?? ANVIL0;
    this.beforeWrite = o.beforeWrite;
  }

  explorerTxUrl(): string | null {
    return null;
  }

  private nowSec(): number {
    return msToSec(this.clock.now());
  }

  private async write(fn: FakeChainWrite, args: unknown[]): Promise<{ txHash: Hex32; blockNumber: number }> {
    await this.beforeWrite?.(fn, args);
    this.writes.push({ fn, args });
    this.txN++;
    return { txHash: keccakUtf8(`fake-tx-${this.txN}`), blockNumber: this.txN };
  }

  async readView(): Promise<ChainView> {
    return {
      paused: this.paused,
      policyVersion: this.policyVersion,
      policy: { ...this.policy, instIds: [...this.policy.instIds] },
      policyHash: policyHash(this.policy),
      sourceTextHash: sourceTextHash(this.policy.sourceText),
      agent: this.agent,
      owner: this.owner,
      agentId: this.agentId,
      checkedAt: this.clock.now(),
      blockTimestamp: this.nowSec(),
    };
  }

  async counters(): Promise<ChainCounters> {
    const s = this.nowSec();
    const h = hourIndex(s);
    const d = dayIndex(s);
    return { hourIndex: h, dayIndex: d, tradesInHour: this.hourCount.get(h) ?? 0, tradesInDay: this.dayCount.get(d) ?? 0, riskUsedToday: this.dayRisk.get(d) ?? "0" };
  }

  async latestBlockTimestamp(): Promise<number> {
    return this.nowSec();
  }

  async requestApproval(req: OrderRequest): Promise<ChainRequestResult> {
    const hash = computeOrderHash(this.chainId, this.address, req);
    try {
      if (this.approvals.has(hash)) throw new Error("AlreadyRequested");
      const { txHash } = await this.write("requestApproval", [req]);
      const p = this.policy;
      const reasons: PolicyReason[] = [];
      const notional = toDecString(D(req.px).mul(D(req.sz)));
      if (this.paused) reasons.push("PAUSED");
      if (this.nowSec() * 1000 > p.validUntil) reasons.push("POLICY_EXPIRED");
      const foreign = !p.instIds.includes(req.instId);
      if (foreign) reasons.push("INSTRUMENT_NOT_ALLOWED");
      if (decGt(notional, p.maxOrderQuote)) reasons.push("ORDER_TOO_LARGE");
      const noStop = D(req.stopPx).isZero();
      if (noStop) reasons.push("STOP_MISSING");
      const critical = foreign || noStop || decGt(notional, decMul(p.maxOrderQuote, "2"));
      const mask = reasonsToMask(reasons);
      const at = this.nowSec();
      const worstCase = mask === 0 ? toDecString(D(req.px).sub(D(req.stopPx)).mul(D(req.sz)).toDecimalPlaces(8, 1)) : "0";
      this.approvals.set(hash, { status: mask === 0 ? 1 : 2, reasons: mask, at, expiresAt: at + 120, policyVersion: this.policyVersion, worstCase });
      this.requests.set(hash, req);
      if (mask === 0) {
        this.byPrefix.set(hashPrefix30(hash), hash);
        const h = hourIndex(at);
        const d = dayIndex(at);
        this.hourCount.set(h, (this.hourCount.get(h) ?? 0) + 1);
        this.dayCount.set(d, (this.dayCount.get(d) ?? 0) + 1);
        this.dayRisk.set(d, decAdd(this.dayRisk.get(d) ?? "0", worstCase));
      } else if (critical && !this.paused) {
        this.paused = true;
      }
      return { ok: true, orderHash: hash, txHash, status: mask === 0 ? "APPROVED" : "REJECTED", reasonsMask: mask, critical: mask !== 0 && critical, policyVersion: this.policyVersion, worstCase };
    } catch (e) {
      return { ok: false, orderHash: hash, error: (e as Error).message };
    }
  }

  async approval(orderHash: Hex32): Promise<ChainApproval> {
    return this.approvals.get(orderHash) ?? { status: 0, reasons: 0, at: 0, expiresAt: 0, policyVersion: 0, worstCase: "0" };
  }
  async orderHashByPrefix(prefix: string): Promise<Hex32 | null> {
    return this.byPrefix.get(prefix) ?? null;
  }
  async entryByExitPrefix(prefix: string): Promise<Hex32 | null> {
    return this.exitByPrefix.get(prefix) ?? null;
  }

  async recordExit(entry: Hex32, exitPrefix: string, reasonCode: number, pnl: SDec): Promise<TxResult> {
    try {
      if (this.approvals.get(entry)?.status !== 1) throw new Error("UnknownEntry");
      if (this.exitAt.has(entry)) throw new Error("ExitAlreadyRecorded");
      if (!(reasonCode >= 1 && reasonCode <= 6)) throw new Error("BadExitReason");
      const r = await this.write("recordExit", [entry, exitPrefix, reasonCode, pnl]);
      this.exitAt.set(entry, this.nowSec());
      this.exitByPrefix.set(exitPrefix, entry);
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  async exitRecordedAt(entry: Hex32): Promise<number> {
    return this.exitAt.get(entry) ?? 0;
  }

  async lastAnchoredSeq(): Promise<number> {
    return this.lastSeq;
  }
  async anchor(root: Hex32, fromSeq: number, toSeq: number): Promise<TxResult> {
    try {
      if (fromSeq !== this.lastSeq + 1 || toSeq < fromSeq) throw new Error("BadAnchorRange");
      const r = await this.write("anchor", [root, fromSeq, toSeq]);
      this.anchors.push({ index: this.anchors.length, root, fromSeq, toSeq, at: this.nowSec() });
      this.lastSeq = toSeq;
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  async readAnchors(): Promise<ChainAnchor[]> {
    return this.anchors.map((a) => ({ ...a }));
  }
  async verifyEntry(index: number, entryHash: Hex32, proof: Hex32[]): Promise<boolean> {
    const a = this.anchors[index];
    return a ? verifyMerkleProof(entryHash, proof, a.root) : false;
  }
  async approvedRequest(orderHash: Hex32): Promise<OrderRequest | null> {
    return this.approvals.get(orderHash)?.status === 1 ? (this.requests.get(orderHash) ?? null) : null;
  }

  async setPolicy(policy: Policy): Promise<TxResult> {
    try {
      if (policy.validUntil <= this.clock.now()) throw new Error("InvalidPolicy");
      const r = await this.write("setPolicy", [policy]);
      this.policy = { ...policy, instIds: [...policy.instIds] };
      this.policyVersion++;
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  async pause(): Promise<TxResult> {
    try {
      const r = await this.write("pause", []);
      this.paused = true;
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  async unpause(): Promise<TxResult> {
    const r = await this.write("unpause", []);
    this.paused = false;
    return { ok: true, ...r };
  }
  async setAgentId(id: number): Promise<TxResult> {
    const r = await this.write("setAgentId", [id]);
    this.agentId = id;
    return { ok: true, ...r };
  }

  encodeOwnerCall(fn: "setPolicy" | "pause" | "unpause"): { to: Address; data: `0x${string}`; chainId: number } {
    if (fn === "setPolicy") throw new Error("S1 wallet signing needs the real chain client");
    const data = encodeFunctionData({ abi: [{ type: "function", name: fn, inputs: [], outputs: [], stateMutability: "nonpayable" }], functionName: fn });
    return { to: this.address, data, chainId: this.chainId };
  }

  /** Test helper: the v-clOrdId of an approved hash. */
  static clOrdId(hash: Hex32): string {
    return entryClOrdId(hash);
  }
  /** Test helper. */
  rejectedReasons(hash: Hex32): string[] {
    return maskToReasons(this.approvals.get(hash)?.reasons ?? 0);
  }
}
