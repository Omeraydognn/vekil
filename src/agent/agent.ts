// The agent as core sees it (core/deps.ts AgentPort): C1/C2 from the ON-CHAIN view and counters, the cycle message
// from the agent state, and one run of the loop with the read-only tools. Core validates the raw decision with zod.
import type { AgentDeps, AtkReader, ChainCounters, ChainView, Clock, EventBus, LlmClient, RunAgent, RunAgentResult } from "../shared/interfaces.js";
import { withTr } from "../shared/reasons.js";
import type { AgentState, Position } from "../shared/schemas.js";
import { makeRunAgent } from "./loop.js";
import { buildCycleMessage, buildSystemPrompt } from "./prompt.js";

export interface AgentPortDeps {
  llm: LlmClient;
  model: string;
  atk: AtkReader;
  allowlist: string[];
  clock: Clock;
  bus: EventBus;
  instId: string;
  mode: string;
  maxToolCalls: number;
  cooldownAfterLossMin: number;
  indicators: (instId: string) => Promise<object>;
  marketContext: (instId: string) => Promise<object>;
  /** The executor's positions (ExecutorApi.health()). */
  positions: () => Promise<Position[]>;
  runAgent?: RunAgent;
}

export interface DecideCtx {
  profile: "normal" | "naive";
  injection: string | null;
  view: ChainView | null;
  counters: ChainCounters | null;
  state: AgentState;
  ownerNote: string | null;
  signal: AbortSignal;
}

export function makeAgentPort(d: AgentPortDeps): { model: string; decide(ctx: DecideCtx): Promise<RunAgentResult> } {
  const run = d.runAgent ?? makeRunAgent({ maxToolCalls: d.maxToolCalls });
  return {
    model: d.model,
    async decide(ctx) {
      // C1 is built from the on-chain policy and counters only; without them the agent does not run (fail closed).
      if (!ctx.view || !ctx.counters) return { rawDecision: null, toolTrace: [], model: d.model, error: "zincir durumu alınamadı" };
      const view = ctx.view;
      const counters = ctx.counters;
      let positions: Position[] = [];
      try {
        positions = await d.positions();
      } catch {
        positions = [];
      }
      const now = d.clock.now();
      const cooldownUntil = ctx.state.lastLossExitAt === null ? null : ctx.state.lastLossExitAt + d.cooldownAfterLossMin * 60_000;
      const last = ctx.state.lastDecisions.at(-1);
      const lastRejection = last && last.outcome === "REJECTED" ? withTr(last.reasons) : null;
      const system = buildSystemPrompt({
        view, counters, instId: d.instId, maxToolCalls: d.maxToolCalls, profile: ctx.profile, test: ctx.profile === "naive",
      });
      const message = buildCycleMessage({
        now, mode: d.mode, test: ctx.profile === "naive",
        positions: positions.map((p) => ({ instId: p.instId, entryPx: p.entryPx, sz: p.sz, stopPx: p.stopPx, tpPx: p.tpPx, openedAt: p.openedAt, timeStopAt: p.timeStopAt })),
        realizedPnlTodayQuote: ctx.state.realizedPnlTodayQuote,
        tradesInHour: counters.tradesInHour, tradesInDay: counters.tradesInDay,
        maxTradesPerHour: view.policy.maxTradesPerHour, maxTradesPerDay: view.policy.maxTradesPerDay,
        riskUsedToday: counters.riskUsedToday, dailyRiskBudgetQuote: view.policy.dailyRiskBudgetQuote,
        cooldownUntil, lastDecisions: ctx.state.lastDecisions, lastRejection, lastLesson: ctx.state.lastLesson, ownerNote: ctx.ownerNote,
      });
      const agentState = (): object => ({
        positions, realizedPnlTodayQuote: ctx.state.realizedPnlTodayQuote,
        onChain: {
          policyVersion: view.policyVersion, paused: view.paused,
          tradesInHour: counters.tradesInHour, maxTradesPerHour: view.policy.maxTradesPerHour,
          tradesInDay: counters.tradesInDay, maxTradesPerDay: view.policy.maxTradesPerDay,
          riskUsedToday: counters.riskUsedToday, dailyRiskBudgetQuote: view.policy.dailyRiskBudgetQuote,
        },
        cooldownUntil: cooldownUntil !== null && cooldownUntil > now ? new Date(cooldownUntil).toISOString() : null,
        policy: {
          instIds: view.policy.instIds, maxOrderQuote: view.policy.maxOrderQuote,
          stopRangePct: [view.policy.minStopDistancePct, view.policy.maxStopDistancePct], maxHoldMin: view.policy.maxHoldMin,
        },
      });
      const deps: AgentDeps = {
        llm: d.llm, atk: d.atk, allowlist: d.allowlist, clock: d.clock, bus: d.bus, agentState,
        indicators: d.indicators, marketContext: d.marketContext, profile: ctx.profile, injection: ctx.injection,
      };
      return run(deps, system, message, ctx.signal);
    },
  };
}
