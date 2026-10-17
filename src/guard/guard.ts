// VEKİL Guard (docs/GUARD_PLAN.md): the VekilPolicy rule engine as a service for other agents.
// "May I send this order?" is answered by simulating requestApproval with eth_call: no key, no tx, no state change.
// Guard holds no keys at all (no owner, no agent, no OKX).
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { auditOrder } from "../audit/auditor.js";
import { keccakUtf8 } from "../shared/hash.js";
import type { ChainView, PolicyChain } from "../shared/interfaces.js";
import { decGt, decLt, fromScaled, toScaled } from "../shared/money.js";
import { CLORDID_RE, ENTRY_CLORDID_RE, EXIT_CLORDID_RE } from "../shared/order-hash.js";
import { isCritical, maskToReasons, policyReasonBit, withTr } from "../shared/reasons.js";
import { Dec8, type Address, type AuditReport, type Hex32, type OrderRequest, type OrderState, type PolicyProposal } from "../shared/schemas.js";

/** What Guard needs from the chain client: the read side of PolicyChain plus the eth_call simulation. */
export type GuardChain = Pick<
  PolicyChain,
  "chainId" | "address" | "explorerTxUrl" | "readView" | "counters" | "orderHashByPrefix" | "entryByExitPrefix" | "approval" | "approvedRequest"
> & {
  simulateApproval(req: OrderRequest): Promise<{ orderHash: Hex32; reasonsMask: number; agent: Address; blockNumber: number; blockTimestamp: number }>;
};

export interface GuardDeps {
  chain: GuardChain;
  now: () => number;
  /** Text-to-Policy draft (no apply). Absent → /v1/policy/propose answers 503. */
  propose?: (text: string) => Promise<Omit<PolicyProposal, "id">>;
}

/** The decision hash Guard puts in simulated requests (it has no agent decision behind it). */
export const GUARD_DECISION_HASH = keccakUtf8("vekil-guard:simulated-check");

const UINT32_MAX = 0xffff_ffff;
export const CheckBodySchema = z
  .object({
    instId: z.string().min(1).max(32),
    side: z.literal("buy").default("buy"),
    px: Dec8,
    sz: Dec8,
    stopPx: Dec8.optional(),
    tpPx: Dec8.optional(),
    timeStopMin: z.number().int().min(0).max(UINT32_MAX).optional(),
  })
  .strict();
export type CheckBody = z.infer<typeof CheckBodySchema>;

export interface CheckResult {
  verdict: "APPROVE" | "REJECT";
  reasons: { code: string; tr: string }[];
  critical: boolean;
  /** A real request like this would pause the contract (critical and not already paused). */
  wouldPause: boolean;
  notional: string;
  /** SPEC §13.1 worst case (stop distance × size + fees and slippage), null without a valid stop. Informational. */
  worstCase: string | null;
  request: OrderRequest;
  policyVersion: number;
  paused: boolean;
  chain: { chainId: number; contract: Address; blockNumber: number; blockTimestamp: number; asAgent: Address };
  simulated: true;
  note: string;
}

const rand32 = (): Hex32 => `0x${randomBytes(32).toString("hex")}`;

/**
 * SPEC §13.1 worst case with the contract's integer steps on ×1e8 values (VekilPolicy floors each division), so it
 * equals the on-chain worstCase. Null unless 0 < stopPx < px.
 */
export function worstCaseQuote(req: OrderRequest, feeBps: number, slippageBps: number): string | null {
  if (!(decGt(req.stopPx, "0") && decLt(req.stopPx, req.px))) return null;
  const px = toScaled(req.px);
  const sz = toScaled(req.sz);
  const notional = (px * sz) / 100_000_000n;
  const w = ((px - toScaled(req.stopPx)) * sz) / 100_000_000n + (notional * BigInt(2 * feeBps + slippageBps)) / 10_000n;
  return fromScaled(w);
}

export async function checkOrder(deps: GuardDeps, body: CheckBody): Promise<CheckResult> {
  const view: ChainView = await deps.chain.readView();
  const req: OrderRequest = {
    instId: body.instId,
    side: "buy",
    px: body.px,
    sz: body.sz,
    stopPx: body.stopPx ?? "0",
    tpPx: body.tpPx ?? "0",
    // Same default as preflight: the policy's max hold.
    timeStopMin: body.timeStopMin ?? view.policy.maxHoldMin,
    decisionHash: GUARD_DECISION_HASH,
    // Fresh nonce so the simulation never hits AlreadyRequested.
    nonce: rand32(),
  };
  const sim = await deps.chain.simulateApproval(req);
  const reasons = maskToReasons(sim.reasonsMask);
  const notionalScaled = (toScaled(req.px) * toScaled(req.sz)) / 100_000_000n;
  const critical = reasons.length > 0 && isCritical(sim.reasonsMask, notionalScaled, toScaled(view.policy.maxOrderQuote));
  return {
    verdict: reasons.length === 0 ? "APPROVE" : "REJECT",
    reasons: withTr(reasons),
    critical,
    // From the simulation's own mask (same block as the reasons): a request while paused can't pause again.
    wouldPause: critical && (sim.reasonsMask & (1 << policyReasonBit("PAUSED"))) === 0,
    notional: fromScaled(notionalScaled),
    worstCase: worstCaseQuote(req, view.policy.feeBps, view.policy.slippageBps),
    request: req,
    policyVersion: view.policyVersion,
    paused: view.paused,
    chain: { chainId: deps.chain.chainId, contract: deps.chain.address, blockNumber: sim.blockNumber, blockTimestamp: sim.blockTimestamp, asAgent: sim.agent },
    simulated: true,
    note: "eth_call simülasyonu: işlem gönderilmedi, zincir durumu değişmedi. Gerçek onay yalnızca agent adresinin requestApproval işlemiyle olur.",
  };
}

export async function policySummary(deps: GuardDeps) {
  const [view, counters] = await Promise.all([deps.chain.readView(), deps.chain.counters()]);
  return {
    contract: deps.chain.address,
    chainId: deps.chain.chainId,
    policyVersion: view.policyVersion,
    paused: view.paused,
    policy: view.policy,
    policyHash: view.policyHash,
    sourceTextHash: view.sourceTextHash,
    agent: view.agent,
    owner: view.owner,
    counters: {
      tradesInHour: counters.tradesInHour,
      maxTradesPerHour: view.policy.maxTradesPerHour,
      tradesInDay: counters.tradesInDay,
      maxTradesPerDay: view.policy.maxTradesPerDay,
      riskUsedToday: counters.riskUsedToday,
      dailyRiskBudgetQuote: view.policy.dailyRiskBudgetQuote,
    },
    blockTimestamp: view.blockTimestamp,
  };
}

export const AuditQuerySchema = z
  .object({
    instId: z.string().min(1).max(32).optional(),
    side: z.enum(["buy", "sell"]).optional(),
    px: Dec8.optional(),
    sz: Dec8.optional(),
  })
  .strict();
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

export class AuditQueryError extends Error {
  override name = "AuditQueryError";
}

export interface AuditResult {
  clOrdId: string;
  kind: "ENTRY" | "EXIT" | "MANUAL";
  onChain: { orderHash: Hex32 | null; approvalStatus: 0 | 1 | 2 | null; approved: OrderRequest | null; exitOfEntry: Hex32 | null };
  /** Present when the order's details were given: the auditor's A1/A2 verdict for exactly that order. */
  match: AuditReport["items"][number] | null;
}

/** One clOrdId against the chain. With instId/side/px/sz it also runs the auditor rules (A1/A2) on that order. */
export async function auditClOrdId(deps: GuardDeps, clOrdId: string, q: AuditQuery): Promise<AuditResult> {
  const c = deps.chain;
  if (!CLORDID_RE.test(clOrdId)) {
    return { clOrdId, kind: "MANUAL", onChain: { orderHash: null, approvalStatus: null, approved: null, exitOfEntry: null }, match: null };
  }
  const prefix = clOrdId.slice(1);
  let orderHash: Hex32 | null = null;
  let exitOfEntry: Hex32 | null = null;
  if (ENTRY_CLORDID_RE.test(clOrdId)) orderHash = await c.orderHashByPrefix(prefix);
  if (EXIT_CLORDID_RE.test(clOrdId)) exitOfEntry = await c.entryByExitPrefix(prefix);
  const entry = orderHash ?? exitOfEntry;
  const approvalStatus = entry ? (await c.approval(entry)).status : null;
  const approved = entry && approvalStatus === 1 ? await c.approvedRequest(entry) : null;

  let match: AuditResult["match"] = null;
  const given = [q.instId, q.side, q.px, q.sz].filter((v) => v !== undefined).length;
  if (given > 0 && !(q.instId && q.side && q.sz)) throw new AuditQueryError("instId, side ve sz birlikte verilmeli (px isteğe bağlı)");
  if (q.instId && q.side && q.sz) {
    const now = deps.now();
    const order: OrderState = {
      ordId: "guard-query",
      clOrdId,
      instId: q.instId,
      side: q.side,
      px: q.px ?? null,
      sz: q.sz,
      state: "filled",
      accFillSz: q.sz,
      avgPx: q.px ?? null,
      fee: "0",
      feeCcy: "",
      // Treated as an old order: a missing exit record is a violation, not "pending".
      cTime: 0,
    };
    match = await auditOrder(
      { source: { listRecentOrders: () => Promise.resolve([]) }, sourceKind: "exchange", chain: c, instIds: () => Promise.resolve([q.instId ?? ""]), now: () => now },
      order,
      now,
    );
  }
  return { clOrdId, kind: ENTRY_CLORDID_RE.test(clOrdId) ? "ENTRY" : "EXIT", onChain: { orderHash, approvalStatus, approved, exitOfEntry }, match };
}
