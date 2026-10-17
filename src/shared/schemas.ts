// zod schemas for every data model in SPEC §9 (+ the HTTP bodies of §14 and §19).
import { z } from "zod";
import { SSE_EVENT_TYPES, type VekilEvent } from "./events.js";
import { decGt, decLt, HARD_MAX_DAILY_RISK, HARD_MAX_ORDER_QUOTE, MoneyError, toScaled } from "./money.js";
import { EXECUTOR_REFUSALS, EXIT_REASONS, LOCAL_REASONS, PIPELINE_CODES, POLICY_REASONS } from "./reasons.js";
import { endOfDayIstanbul, isWholeSecond } from "./time.js";

// ---------------------------------------------------------------- primitives (§9)
const DEC_RE = /^\d+(\.\d+)?$/;
const SDEC_RE = /^-?\d+(\.\d+)?$/;
const PCT2_RE = /^\d+(\.\d{1,2})?$/;

export const Dec = z.string().regex(DEC_RE, "Dec: non-negative decimal string");
// zod v4 keeps running refinements after a regex failure, so every refinement re-checks the format.
const positive = (re: RegExp) => (s: string): boolean => re.test(s) && decGt(s, "0");
export const PDec = Dec.refine(positive(DEC_RE), "PDec: must be > 0");
export const SDec = z.string().regex(SDEC_RE, "SDec: decimal string");
export const Pct2 = z.string().regex(PCT2_RE, "Pct2: at most 2 decimals").refine(positive(PCT2_RE), "Pct2: must be > 0");
export const Ms = z.number().int().nonnegative().refine(Number.isSafeInteger, "Ms: safe integer");
export const Int = z.number().int().refine(Number.isSafeInteger, "safe integer");
export const NonNegInt = Int.refine((n) => n >= 0, "must be ≥ 0");
export const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/, "Hex32: lowercase 0x + 64 hex");
export const Address = z.string().regex(/^0x[0-9a-f]{40}$/, "Address: lowercase 0x + 40 hex");
export const InstId = z.string().regex(/^[A-Z0-9]{2,10}-[A-Z]{3,5}$/, "instId like AVAX-TRY");
export const Prefix30 = z.string().regex(/^[0-9a-f]{30}$/);
export const ClOrdId = z.string().regex(/^[vx][0-9a-f]{30}$/);

/** Fits the on-chain ×1e8 uint64 encoding (≤ 8 decimals, ≤ uint64 max). */
export function fitsScaled(s: string): boolean {
  try {
    toScaled(s);
    return true;
  } catch (e) {
    if (e instanceof MoneyError) return false;
    throw e;
  }
}
/** A Dec that can go on-chain. */
export const Dec8 = Dec.refine(fitsScaled, "at most 8 decimals and ≤ uint64 when ×1e8");

export type Dec = z.infer<typeof Dec>;
export type PDec = z.infer<typeof PDec>;
export type SDec = z.infer<typeof SDec>;
export type Pct2 = z.infer<typeof Pct2>;
export type Ms = z.infer<typeof Ms>;
export type Hex32 = z.infer<typeof Hex32>;
export type Address = z.infer<typeof Address>;

// ---------------------------------------------------------------- reason enums (§9.4)
export const PolicyReasonSchema = z.enum(POLICY_REASONS);
export const LocalReasonSchema = z.enum(LOCAL_REASONS);
export const PipelineCodeSchema = z.enum(PIPELINE_CODES);
export const ExecutorRefusalSchema = z.enum(EXECUTOR_REFUSALS);
export const ExitReasonSchema = z.enum(EXIT_REASONS);
export const ReasonTrSchema = z.object({ code: z.string(), tr: z.string() });

// ---------------------------------------------------------------- policy (§9.1)
const PolicyShape = z.object({
  instIds: z.array(z.string()),
  maxOrderQuote: PDec,
  dailyRiskBudgetQuote: PDec,
  maxTradesPerHour: Int,
  maxTradesPerDay: Int,
  minStopDistancePct: Pct2,
  maxStopDistancePct: Pct2,
  maxHoldMin: Int,
  feeBps: Int,
  slippageBps: Int,
  validUntil: Ms,
  sourceText: z.string(),
});
export type Policy = z.infer<typeof PolicyShape>;

type Issue = (msg: string, path: string) => void;

function contractRules(p: Policy, issue: Issue): void {
  if (p.instIds.length < 1 || p.instIds.length > 8) issue("1 to 8 instIds", "instIds");
  p.instIds.forEach((id, i) => {
    const bytes = new TextEncoder().encode(id).length;
    if (bytes < 1 || bytes > 20) issue("instId must be 1–20 bytes", `instIds.${i}`);
  });
  if (new Set(p.instIds).size !== p.instIds.length) issue("duplicate instId", "instIds");
  if (!fitsScaled(p.maxOrderQuote) || decGt(p.maxOrderQuote, HARD_MAX_ORDER_QUOTE)) {
    issue(`maxOrderQuote ≤ ${HARD_MAX_ORDER_QUOTE} TRY, ≤ 8 decimals`, "maxOrderQuote");
  }
  if (!fitsScaled(p.dailyRiskBudgetQuote) || decGt(p.dailyRiskBudgetQuote, HARD_MAX_DAILY_RISK)) {
    issue(`dailyRiskBudgetQuote ≤ ${HARD_MAX_DAILY_RISK} TRY, ≤ 8 decimals`, "dailyRiskBudgetQuote");
  }
  if (p.maxTradesPerHour < 1 || p.maxTradesPerHour > 0xffff) issue("maxTradesPerHour ≥ 1", "maxTradesPerHour");
  if (p.maxTradesPerDay < p.maxTradesPerHour || p.maxTradesPerDay > 0xffff) issue("maxTradesPerDay ≥ maxTradesPerHour", "maxTradesPerDay");
  if (!decLt(p.minStopDistancePct, p.maxStopDistancePct)) issue("minStopDistancePct < maxStopDistancePct", "minStopDistancePct");
  if (decGt(p.maxStopDistancePct, "20")) issue("maxStopDistancePct ≤ 20", "maxStopDistancePct");
  if (p.maxHoldMin < 15 || p.maxHoldMin > 1440) issue("maxHoldMin 15..1440", "maxHoldMin");
  if (p.feeBps < 0 || p.feeBps > 100) issue("feeBps 0..100", "feeBps");
  if (p.slippageBps < 0 || p.slippageBps > 200) issue("slippageBps 0..200", "slippageBps");
  if (!isWholeSecond(p.validUntil)) issue("validUntil must be a whole second", "validUntil");
}

/** Runs rules without ever throwing (field-level issues may already exist; values can be malformed). */
function safeRules(p: Policy, issue: Issue, rules: (p: Policy, issue: Issue) => void): void {
  try {
    rules(p, issue);
  } catch (e) {
    if (!(e instanceof MoneyError)) throw e;
    issue(e.message, "");
  }
}

/** Owner input: the strict §9.1 ranges plus the contract rules. */
export const PolicySchema = PolicyShape.superRefine((p, ctx) => {
  const issue: Issue = (message, path) => ctx.addIssue({ code: "custom", message, path: path.split(".") });
  safeRules(p, issue, contractRules);
  p.instIds.forEach((id, i) => {
    if (!InstId.safeParse(id).success) issue("instId like AVAX-TRY", `instIds.${i}`);
  });
  if (p.maxTradesPerHour > 60) issue("maxTradesPerHour ≤ 60", "maxTradesPerHour");
  if (p.maxTradesPerDay > 100) issue("maxTradesPerDay ≤ 100", "maxTradesPerDay");
  if (p.sourceText.length > 1000) issue("sourceText ≤ 1000 chars", "sourceText");
});

/** What the chain may hold: only the contract's setPolicy rules (U4). Used to parse readView(). */
export const ChainPolicySchema = PolicyShape.superRefine((p, ctx) => {
  safeRules(p, (message, path) => ctx.addIssue({ code: "custom", message, path: path.split(".") }), contractRules);
});

/** Default policy (deploy and --reset, SPEC §11). */
export function defaultPolicy(nowMs: number): Policy {
  return {
    instIds: ["AVAX-TRY"],
    maxOrderQuote: "200",
    dailyRiskBudgetQuote: "100",
    maxTradesPerHour: 1,
    maxTradesPerDay: 4,
    minStopDistancePct: "0.3",
    maxStopDistancePct: "3",
    maxHoldMin: 480,
    feeBps: 20,
    slippageBps: 30,
    validUntil: endOfDayIstanbul(nowMs),
    sourceText: "",
  };
}

// ---------------------------------------------------------------- order request (§9.2)
export const OrderRequestSchema = z.object({
  instId: z.string().min(1).max(32),
  side: z.literal("buy"),
  px: Dec8,
  sz: Dec8,
  stopPx: Dec8,
  tpPx: Dec8,
  timeStopMin: NonNegInt.refine((n) => n <= 0xffff_ffff, "uint32"),
  decisionHash: Hex32,
  nonce: Hex32,
});
export type OrderRequest = z.infer<typeof OrderRequestSchema>;

// ---------------------------------------------------------------- agent decision (§9.3)
export const REGIMES = ["TREND_UP", "TREND_DOWN", "RANGE", "HIGH_VOLATILITY", "NEWS_DRIVEN", "UNCLEAR"] as const;
export const PLAYBOOKS = ["TREND_PULLBACK", "RANGE_REVERSION", "BREAKOUT_RETEST", "STAND_ASIDE", "MANAGE_POSITION"] as const;
export const ACTIONS = ["BUY", "CLOSE", "HOLD", "ADJUST_STOP"] as const;

const DecisionCommon = {
  instId: z.string().min(1).max(32),
  regime: z.enum(REGIMES),
  playbook: z.enum(PLAYBOOKS),
  evidence: z.array(z.string().min(1).max(140)).min(1).max(6),
  scenarios: z.object({ bull: z.string().max(200), bear: z.string().max(200) }),
  thesis: z.string().min(1).max(400),
  invalidation: z.string().min(1).max(300),
  confidence: Int.refine((n) => n >= 0 && n <= 100, "0..100"),
  nextCheckInMin: Int.refine((n) => n >= 0 && n <= 1440, "0..1440"),
  lesson: z.string().max(300).optional(),
};

export const BuyDecisionSchema = z.object({
  action: z.literal("BUY"),
  ...DecisionCommon,
  quoteAmount: PDec,
  limitPx: PDec.optional(),
  stopPx: PDec.optional(),
  tpPx: PDec.optional(),
  timeStopMin: NonNegInt.refine((n) => n <= 0xffff_ffff, "uint32").optional(),
});
export const CloseDecisionSchema = z.object({ action: z.literal("CLOSE"), ...DecisionCommon });
export const HoldDecisionSchema = z.object({ action: z.literal("HOLD"), ...DecisionCommon });
export const AdjustDecisionSchema = z.object({
  action: z.literal("ADJUST_STOP"),
  ...DecisionCommon,
  newStopPx: PDec.optional(),
  newTpPx: PDec.optional(),
});

/** Shape only; missing stops, foreign instruments and oversize amounts are for the contract. Unknown fields are stripped. */
export const AgentDecisionSchema = z
  .discriminatedUnion("action", [BuyDecisionSchema, CloseDecisionSchema, HoldDecisionSchema, AdjustDecisionSchema])
  .superRefine((d, ctx) => {
    if (d.action === "ADJUST_STOP" && d.newStopPx === undefined && d.newTpPx === undefined) {
      ctx.addIssue({ code: "custom", message: "ADJUST_STOP needs newStopPx or newTpPx", path: ["newStopPx"] });
    }
  });
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;
export type BuyDecision = z.infer<typeof BuyDecisionSchema>;

// ---------------------------------------------------------------- positions, executor, agent state (§9.5)
export const ModeSchema = z.enum(["fake", "paper", "demo", "live"]);
export const ChainNameSchema = z.enum(["fake", "local", "fuji", "mainnet"]);
export type Mode = z.infer<typeof ModeSchema>;
export type ChainName = z.infer<typeof ChainNameSchema>;

export const PositionSchema = z.object({
  entryOrderHash: Hex32,
  clOrdId: ClOrdId,
  instId: z.string(),
  sz: PDec,
  entryPx: PDec,
  costQuote: PDec,
  openedAt: Ms,
  stopPx: PDec,
  tpPx: PDec.nullable(),
  timeStopAt: Ms,
  exiting: z
    .object({ clOrdId: ClOrdId, reason: ExitReasonSchema, reservedSz: Dec, since: Ms })
    .nullable(),
});
export type Position = z.infer<typeof PositionSchema>;

export const FillDataSchema = z.object({
  orderHash: Hex32,
  clOrdId: ClOrdId,
  ordId: z.string(),
  state: z.string(),
  accFillSz: Dec,
  avgPx: PDec.nullable(),
  fee: SDec,
  feeCcy: z.string(),
  cTime: Ms,
  dust: z.boolean(),
});
export const NotFilledDataSchema = z.object({ orderHash: Hex32, clOrdId: ClOrdId });
export const UnknownDataSchema = NotFilledDataSchema;
export const ExitDataSchema = z.object({
  entryOrderHash: Hex32,
  exitClOrdId: ClOrdId,
  exitPrefix: Prefix30,
  reason: ExitReasonSchema,
  soldSz: Dec,
  avgPx: PDec,
  proceedsQuote: Dec,
  pnlQuote: SDec,
  cTime: Ms,
});
const StopTp = z.object({ stopPx: PDec, tpPx: PDec.nullable() });
export const AdjustDataSchema = z.object({ entryOrderHash: Hex32, from: StopTp, to: StopTp });
export const CancelDataSchema = z.object({ clOrdIds: z.array(z.string()), by: z.enum(["kill", "pause-watch", "api"]) });
export const PauseSeenExecDataSchema = z.object({ blockTimestamp: NonNegInt });
export const AlertExecDataSchema = z.object({ code: z.string(), details: z.string() });

const ev = <T extends string, S extends z.ZodTypeAny>(type: T, data: S) =>
  z.object({ n: NonNegInt, ts: Ms, type: z.literal(type), data });
export const ExecutorEventSchema = z.discriminatedUnion("type", [
  ev("FILL", FillDataSchema),
  ev("NOT_FILLED", NotFilledDataSchema),
  ev("UNKNOWN", UnknownDataSchema),
  ev("EXIT", ExitDataSchema),
  ev("ADJUST", AdjustDataSchema),
  ev("CANCEL", CancelDataSchema),
  ev("PAUSE_SEEN", PauseSeenExecDataSchema),
  ev("ALERT", AlertExecDataSchema),
]);
export type ExecutorEvent = z.infer<typeof ExecutorEventSchema>;
export const EXECUTOR_EVENT_TYPES = ["FILL", "NOT_FILLED", "UNKNOWN", "EXIT", "ADJUST", "CANCEL", "PAUSE_SEEN", "ALERT"] as const;
export type ExecutorEventType = (typeof EXECUTOR_EVENT_TYPES)[number];

export const ExecutorStateSchema = z.object({
  mode: ModeSchema,
  chainId: NonNegInt,
  policy: Address,
  halted: z.boolean(),
  lastSeenPaused: z.boolean(),
  executed: z.array(Hex32),
  inventory: z.record(z.string(), Dec),
  positions: z.array(PositionSchema),
  events: z.array(ExecutorEventSchema),
});
export type ExecutorState = z.infer<typeof ExecutorStateSchema>;

export const AgentStatusSchema = z.enum(["RUNNING", "HALTED", "STARTUP_FAILED"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export const AgentStateSchema = z.object({
  mode: ModeSchema,
  chainId: NonNegInt,
  policy: Address.nullable(),
  status: AgentStatusSchema,
  haltReason: z.string().nullable(),
  haltedAt: Ms.nullable(),
  lastExecutorEventN: NonNegInt,
  lastLossExitAt: Ms.nullable(),
  realizedPnlTodayQuote: SDec,
  dayKey: z.string(),
  lastDecisions: z
    .array(
      z.object({
        cycleId: z.string(),
        at: Ms,
        action: z.string(),
        outcome: z.string(),
        reasons: z.array(z.string()),
        thesis: z.string(),
      }),
    )
    .max(10),
  lastLesson: z.string().nullable(),
  pendingOwnerNote: z.string().nullable(),
  nextCheckInAt: Ms,
});
export type AgentState = z.infer<typeof AgentStateSchema>;

// ---------------------------------------------------------------- other types (§9.10)
export const InstrumentSpecSchema = z.object({
  instId: z.string(),
  baseCcy: z.string(),
  quoteCcy: z.string(),
  tickSz: PDec,
  lotSz: PDec,
  minSz: PDec,
  state: z.string(),
});
export const MarketSnapshotSchema = z.object({
  instId: z.string(),
  bid: PDec,
  ask: PDec,
  last: PDec,
  bidSz: Dec,
  askSz: Dec,
  exchTs: Ms,
  fetchedAt: Ms,
});
export const AccountSnapshotSchema = z.object({ quoteAvail: Dec, baseAvail: Dec, fetchedAt: Ms });
export const CandleSchema = z.object({ ts: Ms, o: PDec, h: PDec, l: PDec, c: PDec, vol: Dec, confirmed: z.boolean() });
export const OrderStateSchema = z.object({
  ordId: z.string(),
  clOrdId: z.string(),
  instId: z.string(),
  side: z.enum(["buy", "sell"]),
  px: PDec.nullable(),
  sz: PDec,
  state: z.string(),
  accFillSz: Dec,
  avgPx: PDec.nullable(),
  fee: SDec,
  feeCcy: z.string(),
  cTime: Ms,
});
export const ExecutorHealthSchema = z.object({
  ok: z.boolean(),
  mode: ModeSchema,
  chainId: NonNegInt,
  policy: Address,
  paused: z.boolean(),
  policyVersion: NonNegInt,
  halted: z.boolean(),
  inventory: z.record(z.string(), Dec),
  positions: z.array(PositionSchema),
  atk: z.object({
    kind: z.enum(["trade", "read", "fake"]),
    modules: z.array(z.string()),
    readOnly: z.boolean(),
    demo: z.boolean(),
    tools: z.array(z.string()),
  }),
});
export const ToolTraceItemSchema = z.object({
  name: z.string(),
  argsJson: z.string(),
  argsHash: Hex32,
  resultHash: Hex32,
  ms: NonNegInt,
  ok: z.boolean(),
});
export const McpToolSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export const ToolDefSchema = z.object({ name: z.string(), description: z.string(), input_schema: z.record(z.string(), z.unknown()) });
export const LlmResponseSchema = z.object({
  content: z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() }),
    ]),
  ),
  stopReason: z.string(),
  model: z.string(),
});
export const VekilEventSchema = z.object({
  type: z.enum(SSE_EVENT_TYPES),
  ts: Ms,
  cycleId: z.string().optional(),
  test: z.boolean().optional(),
  data: z.record(z.string(), z.unknown()),
}) satisfies z.ZodType<VekilEvent>;

export type InstrumentSpec = z.infer<typeof InstrumentSpecSchema>;
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;
export type AccountSnapshot = z.infer<typeof AccountSnapshotSchema>;
export type Candle = z.infer<typeof CandleSchema>;
export type OrderState = z.infer<typeof OrderStateSchema>;
export type ExecutorHealth = z.infer<typeof ExecutorHealthSchema>;
export type ToolTraceItem = z.infer<typeof ToolTraceItemSchema>;
export type McpTool = z.infer<typeof McpToolSchema>;
export type ToolDef = z.infer<typeof ToolDefSchema>;
export type LlmResponse = z.infer<typeof LlmResponseSchema>;

// ---------------------------------------------------------------- result types (§9.8)
export const CYCLE_TRIGGERS = ["schedule", "manual", "redteam-injection", "redteam-rogue"] as const;
export const CYCLE_OUTCOMES = [
  "SKIPPED", "NO_DECISION", "INVALID_DECISION", "LLM_ERROR", "HOLD", "LOCAL_BLOCK", "CHAIN_REQUEST_FAILED",
  "REJECTED", "ENTRY_ABORTED", "EXECUTED", "NOT_FILLED", "ORDER_STATE_UNKNOWN", "ADJUSTED", "CLOSING", "TEST_CYCLE",
] as const;
export const CycleTriggerSchema = z.enum(CYCLE_TRIGGERS);
export const CycleOutcomeSchema = z.enum(CYCLE_OUTCOMES);
export const ChainStatusSchema = z.enum(["APPROVED", "REJECTED"]);

export const CycleResultSchema = z.object({
  cycleId: z.string(),
  test: z.boolean(),
  trigger: CycleTriggerSchema,
  decision: AgentDecisionSchema.nullable(),
  naive: z.boolean(),
  outcome: CycleOutcomeSchema,
  reasons: z.array(ReasonTrSchema),
  chain: z
    .object({ orderHash: Hex32, txHash: z.string().nullable(), status: z.enum(["APPROVED", "REJECTED", "FAILED"]), reasons: z.array(z.string()), critical: z.boolean() })
    .optional(),
  clOrdId: z.string().optional(),
  toolTrace: z.array(ToolTraceItemSchema),
  note: z.string().optional(),
});
export const RedTeamResultSchema = z.object({ naive: CycleResultSchema, fallback: CycleResultSchema.nullable() });
export const KillSourceSchema = z.enum(["dashboard", "cli", "chain", "system"]);
export const KillReportSchema = z.object({
  haltedAt: Ms,
  source: KillSourceSchema,
  reason: z.string(),
  alreadyHalted: z.boolean(),
  steps: z.object({ localMs: NonNegInt, executorMs: NonNegInt.nullable(), chainMs: NonNegInt.nullable() }),
  cancelled: z.array(z.string()),
  flattened: z.boolean(),
  pauseTx: z.string().nullable(),
  errors: z.array(z.string()),
});
export const ProofReportSchema = z.object({
  seq: NonNegInt,
  entryHash: Hex32,
  anchorIndex: NonNegInt,
  root: Hex32,
  proof: z.array(Hex32),
  onChainVerified: z.boolean(),
});
export const VERIFY_CHECK_IDS = ["V1", "V2", "V3", "V4", "V5", "V6"] as const;
export const VerifyReportSchema = z.object({
  ok: z.boolean(),
  checks: z.array(z.object({ id: z.enum(VERIFY_CHECK_IDS), ok: z.boolean(), tr: z.string(), details: z.string() })),
  failures: z.array(z.object({ seq: NonNegInt.nullable(), check: z.string(), message: z.string() })),
  proof: ProofReportSchema.optional(),
});
export const AuditReportSchema = z.object({
  ok: z.boolean(),
  source: z.enum(["fake", "paper", "exchange"]),
  contract: Address,
  checkedOrders: NonNegInt,
  items: z.array(
    z.object({
      clOrdId: z.string(),
      kind: z.enum(["ENTRY", "EXIT", "MANUAL"]),
      status: z.enum(["OK", "VIOLATION", "PENDING"]),
      detail: z.string(),
    }),
  ),
});
export const StartupReportSchema = z.object({
  ok: z.boolean(),
  checks: z.array(z.object({ id: z.string(), ok: z.boolean(), level: z.enum(["fail", "warn"]), tr: z.string(), details: z.string() })),
});
export const PolicyProposalSchema = z.object({
  id: z.string(),
  policy: PolicyShape,
  summaryTr: z.string(),
  mapping: z.array(z.object({ phrase: z.string(), field: z.string(), value: z.string() })),
  assumptions: z.array(z.string()),
  questions: z.array(z.string()),
  errors: z.array(z.string()),
});
export const ExecResultSchema = z.object({
  result: z.enum(["FILLED", "NOT_FILLED", "UNKNOWN", "REFUSED", "OK"]),
  refusal: ExecutorRefusalSchema.nullable(),
  event: ExecutorEventSchema.nullable(),
});
export const ChainRequestResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    orderHash: Hex32,
    txHash: Hex32,
    status: ChainStatusSchema,
    reasonsMask: NonNegInt,
    critical: z.boolean(),
    policyVersion: NonNegInt,
    worstCase: Dec,
  }),
  z.object({ ok: z.literal(false), orderHash: Hex32, error: z.string() }),
]);
export const TxResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), txHash: Hex32, blockNumber: NonNegInt }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type CycleResult = z.infer<typeof CycleResultSchema>;
export type CycleTrigger = z.infer<typeof CycleTriggerSchema>;
export type CycleOutcome = z.infer<typeof CycleOutcomeSchema>;
export type RedTeamResult = z.infer<typeof RedTeamResultSchema>;
export type KillReport = z.infer<typeof KillReportSchema>;
export type KillSource = z.infer<typeof KillSourceSchema>;
export type VerifyReport = z.infer<typeof VerifyReportSchema>;
export type ProofReport = z.infer<typeof ProofReportSchema>;
export type AuditReport = z.infer<typeof AuditReportSchema>;
export type StartupReport = z.infer<typeof StartupReportSchema>;
export type PolicyProposal = z.infer<typeof PolicyProposalSchema>;
export type ExecResult = z.infer<typeof ExecResultSchema>;
export type ChainRequestResult = z.infer<typeof ChainRequestResultSchema>;
export type TxResult = z.infer<typeof TxResultSchema>;

// ---------------------------------------------------------------- ledger (§9.6)
export const LEDGER_KINDS = [
  "STARTUP", "POLICY", "OWNER_NOTE", "CYCLE_START", "DECISION", "PREFLIGHT", "CHAIN_REQUEST", "EXECUTE", "FILL",
  "EXIT", "EXIT_RECORDED", "ADJUST", "CANCEL", "PAUSE_SEEN", "KILL", "RESUME", "ANCHOR", "ASK", "ALERT", "ERROR",
] as const;
export const LedgerKindSchema = z.enum(LEDGER_KINDS);
export type LedgerKind = z.infer<typeof LedgerKindSchema>;

export const LEDGER_PAYLOAD_SCHEMAS = {
  STARTUP: z.object({
    mode: ModeSchema,
    chainId: NonNegInt,
    policy: Address.nullable(),
    agent: Address.nullable(),
    atkVersion: z.string().nullable(),
    manifestHash: Hex32.nullable(),
    report: StartupReportSchema,
  }),
  POLICY: z.object({
    version: NonNegInt,
    policyHash: Hex32,
    policy: ChainPolicySchema,
    sourceTextHash: Hex32,
    txHash: z.string().nullable(),
    source: z.enum(["deploy", "text", "script", "reload"]),
  }),
  OWNER_NOTE: z.object({ text: z.string() }),
  CYCLE_START: z.object({ trigger: CycleTriggerSchema, test: z.boolean() }),
  DECISION: z.object({
    decision: AgentDecisionSchema.nullable(),
    raw: z.string().nullable(),
    error: z.string().nullable(),
    model: z.string(),
    toolTrace: z.array(ToolTraceItemSchema),
    naive: z.boolean(),
  }),
  PREFLIGHT: z.object({
    route: z.enum(["LOCAL_BLOCK", "CHAIN", "NONE"]),
    suspect: z.boolean(),
    forceChain: z.boolean(),
    reasons: z.array(z.string()),
    order: OrderRequestSchema.nullable(),
    snapshotHash: Hex32.nullable(),
  }),
  CHAIN_REQUEST: z.object({
    order: OrderRequestSchema,
    orderHash: Hex32,
    txHash: z.string().nullable(),
    status: z.enum(["APPROVED", "REJECTED", "FAILED"]),
    reasonsMask: NonNegInt,
    reasons: z.array(z.string()),
    critical: z.boolean(),
    policyVersion: NonNegInt,
    worstCase: Dec.nullable(),
    error: z.string().nullable(),
  }),
  EXECUTE: z.object({
    orderHash: Hex32,
    clOrdId: ClOrdId,
    result: z.enum(["FILLED", "NOT_FILLED", "UNKNOWN", "REFUSED"]),
    refusal: z.string().nullable(),
  }),
  FILL: FillDataSchema,
  EXIT: ExitDataSchema,
  EXIT_RECORDED: z.object({ entryOrderHash: Hex32, txHash: z.string(), blockNumber: NonNegInt }),
  ADJUST: AdjustDataSchema,
  CANCEL: CancelDataSchema,
  PAUSE_SEEN: z.object({ by: z.enum(["core", "executor"]), blockTimestamp: NonNegInt }),
  KILL: KillReportSchema,
  RESUME: z.object({ by: z.literal("human") }),
  ANCHOR: z.object({ index: NonNegInt, root: Hex32, fromSeq: NonNegInt, toSeq: NonNegInt, txHash: z.string() }),
  ASK: z.object({ question: z.string(), answer: z.string() }),
  ALERT: z.object({ code: z.string(), tr: z.string(), details: z.string() }),
  ERROR: z.object({ where: z.string(), message: z.string() }),
} as const satisfies Record<LedgerKind, z.ZodTypeAny>;
export type LedgerPayload<K extends LedgerKind> = z.infer<(typeof LEDGER_PAYLOAD_SCHEMAS)[K]>;

export const LedgerEntrySchema = z.object({
  seq: Int.refine((n) => n >= 1, "seq starts at 1"),
  ts: Ms,
  kind: LedgerKindSchema,
  cycleId: z.string().nullable(),
  test: z.boolean(),
  payload: z.record(z.string(), z.unknown()),
  prevHash: Hex32,
  hash: Hex32,
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

// ---------------------------------------------------------------- HTTP bodies (§14, §19)
export const ExecuteBodySchema = z.object({ req: OrderRequestSchema, orderHash: Hex32 });
export const ExitBodySchema = z.object({ entryOrderHash: Hex32, reason: ExitReasonSchema });
export const AdjustBodySchema = z
  .object({ entryOrderHash: Hex32, newStopPx: PDec.optional(), newTpPx: PDec.optional() })
  .refine((b) => b.newStopPx !== undefined || b.newTpPx !== undefined, "newStopPx or newTpPx");
export const CancelAllBodySchema = z.object({ by: z.enum(["kill", "api"]) });
export const ProposeBodySchema = z.object({ text: z.string().min(1).max(1000) });
export const ApplyBodySchema = z.object({ id: z.string().min(1) });
export const CloseBodySchema = z.object({ entryOrderHash: Hex32 });
export const KillBodySchema = z.object({ flatten: z.boolean().optional(), pauseOnChain: z.boolean().optional() });
const Seq = Int.refine((n) => n >= 1, "seq starts at 1");
export const VerifyBodySchema = z.object({ tamperSeq: Seq.optional(), proveSeq: Seq.optional() });
export const RogueBodySchema = z.object({ id: z.enum(["R1", "R2", "R3"]) });
export const OwnerNoteBodySchema = z.object({ text: z.string().min(1).max(300) });
export const AskBodySchema = z.object({ question: z.string().min(1).max(500) });
