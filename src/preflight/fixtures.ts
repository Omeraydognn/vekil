// Shared test fixtures for preflight tests (not imported by production code).
import type { PreflightInput } from "../shared/interfaces.js";
import type { AgentDecision, Position } from "../shared/schemas.js";

export const NOW = 1_792_219_459_000;
export const H = (c: string): `0x${string}` => `0x${c.repeat(64)}`;

const common = {
  instId: "AVAX-TRY",
  regime: "TREND_UP" as const,
  playbook: "TREND_PULLBACK" as const,
  evidence: ["ticker: ask 494.7"],
  scenarios: { bull: "b", bear: "b" },
  thesis: "t",
  invalidation: "i",
  confidence: 60,
  nextCheckInMin: 15,
};

export function buy(o: Partial<Extract<AgentDecision, { action: "BUY" }>> = {}): AgentDecision {
  return { ...common, action: "BUY", quoteAmount: "100", stopPx: "490", tpPx: "505", ...o };
}
export const hold = (): AgentDecision => ({ ...common, action: "HOLD" });
export const close = (instId = "AVAX-TRY"): AgentDecision => ({ ...common, instId, action: "CLOSE" });
export const adjust = (o: { newStopPx?: string; newTpPx?: string }): AgentDecision => ({ ...common, action: "ADJUST_STOP", ...o });

export function position(o: Partial<Position> = {}): Position {
  return {
    entryOrderHash: H("a"),
    clOrdId: "v" + "a".repeat(30),
    instId: "AVAX-TRY",
    sz: "0.2",
    entryPx: "494.7",
    costQuote: "98.94",
    openedAt: NOW - 60_000,
    stopPx: "490",
    tpPx: "505",
    timeStopAt: NOW + 3_600_000,
    exiting: null,
    ...o,
  };
}

export function input(o: Partial<PreflightInput> = {}): PreflightInput {
  return {
    decision: buy(),
    policy: {
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
      validUntil: NOW + 3_600_000,
      sourceText: "",
    },
    chain: { paused: false, policyVersion: 1, checkedAt: NOW - 1_000 },
    snapshot: { instId: "AVAX-TRY", bid: "494.1", ask: "494.7", last: "494.6", bidSz: "496", askSz: "100", exchTs: NOW - 2_000, fetchedAt: NOW - 1_000 },
    spec: { instId: "AVAX-TRY", baseCcy: "AVAX", quoteCcy: "TRY", tickSz: "0.1", lotSz: "0.00001", minSz: "0.1", state: "live" },
    account: { quoteAvail: "1000", baseAvail: "0", fetchedAt: NOW - 1_000 },
    positions: [],
    lastLossExitAt: null,
    halted: false,
    now: NOW,
    cfg: { maxSpreadPct: "0.3", priceCollarPct: "1", maxSnapshotAgeSec: 15, cooldownAfterLossMin: 60, feeRate: "0.002" },
    test: false,
    forceChain: false,
    nonce: H("2"),
    decisionHash: H("1"),
    ...o,
  };
}
