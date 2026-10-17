// Shared interfaces (SPEC §9.9). FROZEN after M0: propose changes, don't edit.
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { VekilEvent } from "./events.js";
import type {
  AccountSnapshot, Address, AgentDecision, AuditReport, Candle, ChainRequestResult, CycleResult, CycleTrigger, Dec,
  ExecResult, ExecutorEvent, ExecutorHealth, Hex32, InstrumentSpec, KillReport, KillSource, LedgerEntry, LedgerKind,
  LlmResponse, MarketSnapshot, McpTool, Ms, OrderRequest, OrderState, PDec, Policy, PolicyProposal, Position,
  RedTeamResult, SDec, StartupReport, ToolDef, ToolTraceItem, TxResult, VerifyReport, AgentStatus,
} from "./schemas.js";
import type { ExitReason, LocalReason } from "./reasons.js";

export interface Clock {
  now(): Ms;
  sleep(ms: number): Promise<void>;
  every(ms: number, fn: () => void | Promise<void>): () => void;
}

export interface EventBus {
  emit(e: VekilEvent): void;
  subscribe(fn: (e: VekilEvent) => void): () => void;
}

/** Atomic write (tmp file + rename). */
export interface StateStore<T> {
  load(): T | null;
  save(s: T): void;
}

export interface Ledger {
  append(kind: LedgerKind, payload: object, opts: { cycleId: string | null; test: boolean }): LedgerEntry;
  head(): { seq: number; hash: Hex32 };
  readAll(): LedgerEntry[];
}

// ---------------------------------------------------------------- LLM
/** Anthropic MessageParam (role "user" | "assistant"; string or content blocks incl. tool_use / tool_result). */
export type Message = MessageParam;
export interface LlmRequest {
  system: string;
  tools: ToolDef[];
  messages: Message[];
  toolChoice: { type: "auto" } | { type: "tool"; name: string };
  maxTokens: number;
}
export interface LlmClient {
  create(req: LlmRequest, signal: AbortSignal): Promise<LlmResponse>;
}

// ---------------------------------------------------------------- ATK and market
export interface AtkReader {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: unknown): Promise<string>;
}

export type Bar = "5m" | "15m" | "1H";
export interface MarketData {
  getInstrument(instId: string): Promise<InstrumentSpec>;
  getSnapshot(instId: string): Promise<MarketSnapshot>;
  /** Confirmed candles only, oldest first. */
  getCandles(instId: string, bar: Bar, limit: number): Promise<Candle[]>;
  getBook(instId: string, depth: number): Promise<{ bids: [Dec, Dec][]; asks: [Dec, Dec][] }>;
  getTrades(instId: string, limit: number): Promise<{ px: Dec; sz: Dec; side: "buy" | "sell"; ts: Ms }[]>;
}

/** Implementations are used only inside the executor. */
export interface Exchange {
  getAccount(instId: string): Promise<AccountSnapshot>;
  placeOrder(o: {
    instId: string;
    side: "buy" | "sell";
    ordType: "ioc" | "market";
    px: PDec | null;
    sz: PDec;
    clOrdId: string;
  }): Promise<{ ordId: string; sentAt: Ms }>;
  getOrder(instId: string, clOrdId: string): Promise<OrderState>;
  listOpenOrders(instId: string): Promise<OrderState[]>;
  listRecentOrders(instId: string, sinceMs: Ms): Promise<OrderState[]>;
  cancelOrder(instId: string, clOrdId: string): Promise<void>;
}

/** Auditor input (§16.5). */
export interface OrderHistorySource {
  listRecentOrders(instIds: string[], sinceMs: Ms): Promise<OrderState[]>;
}

// ---------------------------------------------------------------- chain (§13.2)
export interface ChainView {
  paused: boolean;
  policyVersion: number;
  policy: Policy;
  policyHash: Hex32;
  sourceTextHash: Hex32;
  agent: Address;
  owner: Address;
  agentId: number;
  checkedAt: Ms;
  blockTimestamp: number;
}
export interface ChainCounters {
  hourIndex: number;
  dayIndex: number;
  tradesInHour: number;
  tradesInDay: number;
  riskUsedToday: Dec;
}
export interface ChainApproval {
  status: 0 | 1 | 2;
  reasons: number;
  at: number;
  expiresAt: number;
  policyVersion: number;
  worstCase: Dec;
}
export interface ChainAnchor {
  index: number;
  root: Hex32;
  fromSeq: number;
  toSeq: number;
  at: number;
}
export interface PolicyChain {
  chainId: number;
  address: Address;
  explorerTxUrl(hash: string): string | null;
  readView(): Promise<ChainView>;
  counters(): Promise<ChainCounters>;
  latestBlockTimestamp(): Promise<number>;
  requestApproval(req: OrderRequest, opts: { timeoutMs: number }): Promise<ChainRequestResult>;
  approval(orderHash: Hex32): Promise<ChainApproval>;
  orderHashByPrefix(prefix30hex: string): Promise<Hex32 | null>;
  entryByExitPrefix(prefix30hex: string): Promise<Hex32 | null>;
  recordExit(entryOrderHash: Hex32, exitPrefix30hex: string, reasonCode: number, pnlQuote: SDec): Promise<TxResult>;
  exitRecordedAt(entryOrderHash: Hex32): Promise<number>;
  lastAnchoredSeq(): Promise<number>;
  anchor(root: Hex32, fromSeq: number, toSeq: number): Promise<TxResult>;
  readAnchors(): Promise<ChainAnchor[]>;
  verifyEntry(index: number, entryHash: Hex32, proof: Hex32[]): Promise<boolean>;
  /** From the OrderApproved log (topic filter on orderHash), for the auditor. */
  approvedRequest(orderHash: Hex32): Promise<OrderRequest | null>;
  setPolicy(policy: Policy): Promise<TxResult>;
  pause(): Promise<TxResult>;
  unpause(): Promise<TxResult>;
  setAgentId(id: number): Promise<TxResult>;
  /** S1: unsigned owner call for a browser wallet. */
  encodeOwnerCall(fn: "setPolicy" | "pause" | "unpause", args?: { policy: Policy }): { to: Address; data: `0x${string}`; chainId: number };
}

// ---------------------------------------------------------------- executor (§14)
/** HTTP client (paper/live) or in-process adapter (fake): same semantics. */
export interface ExecutorApi {
  health(): Promise<ExecutorHealth>;
  account(instId: string): Promise<AccountSnapshot>;
  orders(instIds: string[], sinceMs: Ms): Promise<OrderState[]>;
  execute(req: OrderRequest, orderHash: Hex32): Promise<ExecResult>;
  adjust(entryOrderHash: Hex32, newStopPx?: PDec, newTpPx?: PDec): Promise<ExecResult>;
  exit(entryOrderHash: Hex32, reason: ExitReason): Promise<ExecResult>;
  halt(): Promise<void>;
  cancelAll(by: "kill" | "api"): Promise<string[]>;
  events(sinceN: number): Promise<ExecutorEvent[]>;
}

// ---------------------------------------------------------------- agent (§10)
export interface AgentDeps {
  llm: LlmClient;
  atk: AtkReader;
  allowlist: string[];
  clock: Clock;
  bus: EventBus;
  agentState(): object;
  indicators(instId: string): Promise<object>;
  marketContext(instId: string): Promise<object>;
  profile: "normal" | "naive";
  injection: string | null;
}
export interface RunAgentResult {
  rawDecision: unknown | null;
  toolTrace: ToolTraceItem[];
  model: string;
  error: string | null;
}
export type RunAgent = (deps: AgentDeps, system: string, cycleMessage: string, signal: AbortSignal) => Promise<RunAgentResult>;

// ---------------------------------------------------------------- preflight (§12; types only, the function is Track B's)
export interface PreflightConfig {
  maxSpreadPct: string;
  priceCollarPct: string;
  maxSnapshotAgeSec: number;
  cooldownAfterLossMin: number;
  feeRate: string;
}
export interface PreflightInput {
  decision: AgentDecision;
  policy: Policy | null;
  chain: { paused: boolean; policyVersion: number; checkedAt: Ms } | null;
  snapshot: MarketSnapshot | null;
  spec: InstrumentSpec | null;
  account: AccountSnapshot | null;
  positions: Position[];
  lastLossExitAt: Ms | null;
  halted: boolean;
  now: Ms;
  cfg: PreflightConfig;
  test: boolean;
  forceChain: boolean;
  nonce: Hex32;
  decisionHash: Hex32;
}
export interface PreflightResult {
  route: "LOCAL_BLOCK" | "CHAIN" | "NONE";
  suspect: boolean;
  reasons: LocalReason[];
  order: OrderRequest | null;
  adjust: { entryOrderHash: Hex32; newStopPx?: PDec; newTpPx?: PDec } | null;
  exit: { entryOrderHash: Hex32; reason: ExitReason } | null;
}

// ---------------------------------------------------------------- core (§15, §19)
export interface PublicState {
  status: AgentStatus;
  haltReason: string | null;
  mode: string;
  chain: { name: string; chainId: number; policyAddress: Address | null; paused: boolean; policyVersion: number; explorerBase: string | null };
  policy: Policy | null;
  sourceText: string;
  executor: { ok: boolean; halted: boolean; positions: Position[]; inventory: Record<string, Dec> };
  today: { realizedPnl: SDec; unrealizedPnl: SDec; tradesUsedHour: number; tradesUsedDay: number; riskUsedToday: Dec; riskBudget: Dec };
  agent: {
    model: string;
    lastDecision: AgentDecision | null;
    lastOutcome: string | null;
    nextCheckInAt: Ms;
    cycleRunning: boolean;
    pendingOwnerNote: string | null;
  };
  startup: StartupReport | null;
  ledger: { seq: number; head: Hex32; lastAnchoredSeq: number; lastAnchorTx: string | null };
  erc8004: { agentId: number | null };
  alerts: { code: string; tr: string; details: string; ts: Ms }[];
}

export interface RunCycleOpts {
  trigger: CycleTrigger;
  test?: boolean;
  rogue?: AgentDecision;
  naive?: boolean;
  injection?: string;
  forceChain?: boolean;
}

export interface VekilCore {
  startup(): Promise<StartupReport>;
  runCycle(opts: RunCycleOpts): Promise<CycleResult>;
  runInjectionTest(): Promise<RedTeamResult>;
  runRogue(id: "R1" | "R2" | "R3"): Promise<CycleResult>;
  proposePolicy(text: string): Promise<PolicyProposal>;
  applyPolicy(id: string): Promise<{ version: number; txHash: string }>;
  syncExecutor(): Promise<void>;
  ownerClose(entryOrderHash: Hex32): Promise<ExecResult>;
  kill(opts: { source: KillSource; reason: string; flatten?: boolean; pauseOnChain?: boolean }): Promise<KillReport>;
  requestAnchor(): void;
  anchorNow(): Promise<void>;
  verify(opts?: { tamperSeq?: number; proveSeq?: number }): Promise<VerifyReport>;
  audit(): Promise<AuditReport>;
  setOwnerNote(text: string): void;
  getState(): PublicState;
}

/** tick(): HALTED → SKIPPED (no LLM call); otherwise one cycle if due, else null. */
export interface Scheduler {
  start(): void;
  stop(): void;
  tick(): Promise<CycleResult | null>;
}
