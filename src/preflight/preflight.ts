// Local preflight (SPEC §12): a pure function. No I/O, no clock, no randomness, Decimal only.
// It checks market sanity and routes every suspected policy violation to the chain; it is never the final judge
// of a policy rule. For schema-valid input it never throws.
//
// Routes: BUY → CHAIN | LOCAL_BLOCK | NONE (test, not suspect). CLOSE / ADJUST_STOP → NONE with `exit` / `adjust`
// set when they may proceed, LOCAL_BLOCK with reasons otherwise. HOLD → NONE.
import { Decimal } from "decimal.js";
import type { PreflightInput, PreflightResult } from "../shared/interfaces.js";
import { ceilToTick, D, floorToLot, toDecString } from "../shared/money.js";
import type { LocalReason } from "../shared/reasons.js";
import type { AgentDecision, OrderRequest, PDec } from "../shared/schemas.js";

export const CHAIN_STALE_MS = 30_000;
const DEFAULT_TIME_STOP_MIN = 240;
const ASK_MARKUP = "1.001";

/** Rounding to the on-chain 8 decimals (ceil for buy prices, floor for sizes and stops). */
const ceil8 = (x: Decimal): string => toDecString(x.toDecimalPlaces(8, Decimal.ROUND_CEIL));
const floor8 = (x: Decimal): string => toDecString(x.toDecimalPlaces(8, Decimal.ROUND_DOWN));

type Buy = Extract<AgentDecision, { action: "BUY" }>;
type Adjust = Extract<AgentDecision, { action: "ADJUST_STOP" }>;

export function preflight(input: PreflightInput): PreflightResult {
  const d = input.decision;
  switch (d.action) {
    case "BUY":
      return preflightBuy(input, d);
    case "CLOSE":
      return preflightClose(input, d.instId);
    case "ADJUST_STOP":
      return preflightAdjust(input, d);
    case "HOLD":
      return result("NONE", false, []);
  }
}

function result(route: PreflightResult["route"], suspect: boolean, reasons: LocalReason[], extra: Partial<PreflightResult> = {}): PreflightResult {
  return { route, suspect, reasons, order: null, adjust: null, exit: null, ...extra };
}

function preflightBuy(i: PreflightInput, d: Buy): PreflightResult {
  const reasons: LocalReason[] = [];
  const { policy, chain, cfg } = i;
  const chainOk = policy !== null && chain !== null;

  // Suspicion: anything the contract would reject on policy grounds goes to the chain.
  const suspect = chainOk ? !policy.instIds.includes(d.instId) || D(d.quoteAmount).gt(D(policy.maxOrderQuote)) || d.stopPx === undefined : false;

  // Usable market inputs (instId must match; a crossed book is not usable).
  const snap = i.snapshot && i.snapshot.instId === d.instId && D(i.snapshot.bid).lte(D(i.snapshot.ask)) ? i.snapshot : null;
  const spec = i.spec && i.spec.instId === d.instId ? i.spec : null;
  const acct = i.account;
  const marketOk = snap !== null && spec !== null && acct !== null;

  // Build the order.
  let px: string;
  if (d.limitPx !== undefined) px = spec ? ceilToTick(d.limitPx, spec.tickSz) : d.limitPx;
  else if (snap) px = spec ? ceilToTick(toDecString(D(snap.ask).mul(ASK_MARKUP)), spec.tickSz) : toDecString(D(snap.ask).mul(ASK_MARKUP));
  else px = "0";
  px = ceil8(D(px));
  let sz = "0";
  if (!D(px).isZero()) {
    const raw = D(d.quoteAmount).div(D(px));
    sz = floor8(D(spec ? floorToLot(toDecString(raw), spec.lotSz) : toDecString(raw)));
  }
  const order: OrderRequest = {
    instId: d.instId,
    side: "buy",
    px,
    sz,
    stopPx: d.stopPx !== undefined ? floor8(D(d.stopPx)) : "0",
    tpPx: d.tpPx !== undefined ? floor8(D(d.tpPx)) : "0",
    timeStopMin: d.timeStopMin ?? policy?.maxHoldMin ?? DEFAULT_TIME_STOP_MIN,
    decisionHash: i.decisionHash,
    nonce: i.nonce,
  };

  // Local checks, in table order (§12). ‡ = needs market data.
  if (i.halted) reasons.push("HALTED");
  if (chain?.paused) reasons.push("POLICY_PAUSED");
  if (!chainOk || i.now - chain.checkedAt > CHAIN_STALE_MS) reasons.push("CHAIN_STATE_STALE");
  if (!marketOk) reasons.push("MARKET_DATA_MISSING");
  if (marketOk) {
    const bid = D(snap.bid);
    const ask = D(snap.ask);
    if (spec.state !== "live") reasons.push("INSTRUMENT_NOT_LIVE");
    if (i.now - snap.fetchedAt > cfg.maxSnapshotAgeSec * 1000) reasons.push("STALE_MARKET_DATA");
    const mid = bid.add(ask).div(2);
    if (ask.sub(bid).div(mid).mul(100).gt(D(cfg.maxSpreadPct))) reasons.push("SPREAD_TOO_WIDE");
  }
  if (i.positions.some((p) => p.instId === d.instId)) reasons.push("POSITION_ALREADY_OPEN");
  if (marketOk) {
    const ask = D(snap.ask);
    const fee = D(cfg.feeRate);
    if (D(px).sub(ask).abs().div(ask).mul(100).gt(D(cfg.priceCollarPct))) reasons.push("PRICE_FAR_FROM_MARKET");
    const net = floorToLot(toDecString(D(sz).mul(D("1").sub(fee))), spec.lotSz);
    if (D(sz).lt(D(spec.minSz)) || D(net).lt(D(spec.minSz))) reasons.push("ORDER_BELOW_MIN_SIZE");
    if (D(acct.quoteAvail).lt(D(px).mul(D(sz)).mul(D("1").add(fee)))) reasons.push("INSUFFICIENT_BALANCE");
  }
  if (i.lastLossExitAt !== null && i.now - i.lastLossExitAt < i.cfg.cooldownAfterLossMin * 60_000) reasons.push("COOLDOWN_ACTIVE");

  // Routing.
  let route: PreflightResult["route"];
  if (i.forceChain) route = "CHAIN";
  else if (!i.test && (reasons.includes("HALTED") || reasons.includes("POLICY_PAUSED"))) route = "LOCAL_BLOCK";
  else if (suspect) route = "CHAIN";
  else if (i.test) route = "NONE";
  else if (reasons.length > 0) route = "LOCAL_BLOCK";
  else route = "CHAIN";

  return result(route, suspect, reasons, { order });
}

function preflightClose(i: PreflightInput, instId: string): PreflightResult {
  const pos = i.positions.find((p) => p.instId === instId);
  if (!pos) return result("LOCAL_BLOCK", false, ["NO_POSITION"]);
  return result("NONE", false, [], { exit: { entryOrderHash: pos.entryOrderHash, reason: "AGENT_CLOSE" } });
}

function preflightAdjust(i: PreflightInput, d: Adjust): PreflightResult {
  const pos = i.positions.find((p) => p.instId === d.instId);
  if (!pos) return result("LOCAL_BLOCK", false, ["NO_POSITION"]);
  const reasons: LocalReason[] = [];
  if (d.newStopPx !== undefined && D(d.newStopPx).lt(D(pos.stopPx))) reasons.push("STOP_LOOSENED");
  const snap = i.snapshot && i.snapshot.instId === d.instId ? i.snapshot : null;
  if (!snap) {
    reasons.push("MARKET_DATA_MISSING");
  } else {
    const bid = D(snap.bid);
    if (d.newStopPx !== undefined && D(d.newStopPx).gte(bid)) reasons.push("STOP_ABOVE_MARKET");
    if (d.newTpPx !== undefined && D(d.newTpPx).lte(bid)) reasons.push("TP_BELOW_MARKET");
  }
  if (reasons.length > 0) return result("LOCAL_BLOCK", false, reasons);
  const adjust: { entryOrderHash: typeof pos.entryOrderHash; newStopPx?: PDec; newTpPx?: PDec } = { entryOrderHash: pos.entryOrderHash };
  if (d.newStopPx !== undefined) adjust.newStopPx = d.newStopPx;
  if (d.newTpPx !== undefined) adjust.newTpPx = d.newTpPx;
  return result("NONE", false, [], { adjust });
}
