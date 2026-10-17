// The ports core needs from the other tracks. src/core/wiring.ts binds them to concrete modules
// (dev-stubs during M1, the real A/B/C modules from M2).
import type { Config } from "../shared/config.js";
import type {
  ChainCounters, ChainView, Clock, EventBus, ExecutorApi, Ledger, MarketData, PolicyChain, PreflightInput,
  PreflightResult, RunAgentResult, StateStore,
} from "../shared/interfaces.js";
import type {
  AccountSnapshot, Address, AgentDecision, AgentState, AuditReport, InstrumentSpec, LedgerEntry, MarketSnapshot,
  McpTool, Policy, PolicyProposal, VerifyReport,
} from "../shared/schemas.js";

/** Track A: one agent cycle (prompt C1/C2 + loop). */
export interface AgentPort {
  model: string;
  decide(ctx: {
    profile: "normal" | "naive";
    injection: string | null;
    view: ChainView | null;
    counters: ChainCounters | null;
    state: AgentState;
    ownerNote: string | null;
    signal: AbortSignal;
  }): Promise<RunAgentResult>;
}

/** Track A: red-team rogue decisions built at run time from the on-chain policy and the current ask (§10.6). */
export type RogueBuilder = (
  id: "R1" | "R2" | "R3",
  ctx: { policy: Policy; snapshot: MarketSnapshot | null; spec: InstrumentSpec | null; nowMs: number },
) => Promise<AgentDecision>;

/** Track A: Text-to-Policy parse (Appendix D). Core re-validates everything. */
export type PolicyParser = (text: string, ctx: { nowMs: number }) => Promise<Omit<PolicyProposal, "id">>;

/** Track C: V1–V6 and the on-chain proof over a ledger snapshot. */
export type Verifier = (opts: { entries: LedgerEntry[]; chain: PolicyChain; tamperSeq?: number; proveSeq?: number }) => Promise<VerifyReport>;

/** Track B: the order auditor (§16.5) with the source chosen by mode. */
export type Auditor = () => Promise<AuditReport>;

/** Track B: core's read-only ATK instance, as far as the startup checks need it (SC3). */
export interface AtkReadInfo {
  capabilities(): Promise<{ readOnly: boolean; modules: string[] } | null>;
  listTools(): Promise<McpTool[]>;
}

export interface CoreDeps {
  cfg: Config;
  clock: Clock;
  bus: EventBus;
  ledger: Ledger;
  stateStore: StateStore<AgentState>;
  chain: PolicyChain;
  /** Our agent address (the contract's agent() must equal it, SC8). */
  agentAddress: Address | null;
  executor: ExecutorApi;
  market: MarketData;
  /** live/demo: the core read instance. null → ExecutorApi.account() (fake/paper, §8.1). */
  readAccount: ((instId: string) => Promise<AccountSnapshot>) | null;
  preflight: (i: PreflightInput) => PreflightResult;
  agent: AgentPort;
  buildRogue: RogueBuilder;
  parsePolicy: PolicyParser;
  verify: Verifier;
  audit: Auditor;
  atkRead: AtkReadInfo | null;
  ask: ((question: string) => Promise<string>) | null;
  /** Data dir files (policy-cache.json). */
  dataDir: string;
  /** Live arming as seen by core (SC2). */
  liveArmed: boolean;
}
