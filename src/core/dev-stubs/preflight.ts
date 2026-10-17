// DEV STUB (deleted at M2; Track B owns src/preflight/preflight.ts): a compact §12 preflight so core can run.
// Pure: no I/O, no clock, Decimal only.
import type { PreflightInput, PreflightResult } from "../../shared/interfaces.js";
import { ceilToTick, D, floorToLot, round8Down, toDecString } from "../../shared/money.js";
import type { LocalReason } from "../../shared/reasons.js";

export function preflightStub(i: PreflightInput): PreflightResult {
  const d = i.decision;
  const reasons: LocalReason[] = [];
  const base = { suspect: false, order: null, adjust: null, exit: null } as const;
  const pos = i.positions.find((p) => p.instId === d.instId);

  if (d.action === "HOLD") return { ...base, route: "NONE", reasons };
  if (d.action === "CLOSE") {
    if (!pos) return { ...base, route: "LOCAL_BLOCK", reasons: ["NO_POSITION"] };
    return { ...base, route: "NONE", reasons, exit: { entryOrderHash: pos.entryOrderHash as `0x${string}`, reason: "AGENT_CLOSE" } };
  }
  if (d.action === "ADJUST_STOP") {
    if (!pos) return { ...base, route: "LOCAL_BLOCK", reasons: ["NO_POSITION"] };
    if (!i.snapshot) reasons.push("MARKET_DATA_MISSING");
    if (d.newStopPx !== undefined && D(d.newStopPx).lt(D(pos.stopPx))) reasons.push("STOP_LOOSENED");
    if (i.snapshot && d.newStopPx !== undefined && D(d.newStopPx).gte(D(i.snapshot.bid))) reasons.push("STOP_ABOVE_MARKET");
    if (i.snapshot && d.newTpPx !== undefined && D(d.newTpPx).lte(D(i.snapshot.bid))) reasons.push("TP_BELOW_MARKET");
    if (reasons.length) return { ...base, route: "LOCAL_BLOCK", reasons };
    const adjust: NonNullable<PreflightResult["adjust"]> = { entryOrderHash: pos.entryOrderHash as `0x${string}` };
    if (d.newStopPx !== undefined) adjust.newStopPx = d.newStopPx;
    if (d.newTpPx !== undefined) adjust.newTpPx = d.newTpPx;
    return { ...base, route: "NONE", reasons, adjust };
  }

  // BUY
  let suspect = false;
  if (i.policy && i.chain) {
    suspect = !i.policy.instIds.includes(d.instId) || D(d.quoteAmount).gt(D(i.policy.maxOrderQuote)) || d.stopPx === undefined;
  }
  const snap = i.snapshot && i.snapshot.instId === d.instId ? i.snapshot : null;
  const spec = i.spec && i.spec.instId === d.instId ? i.spec : null;
  let px = d.limitPx ?? (snap ? toDecString(D(snap.ask).mul("1.001")) : "0");
  if (spec && !D(px).isZero()) px = ceilToTick(px, spec.tickSz);
  px = round8Down(px);
  let sz = D(px).isZero() ? "0" : toDecString(D(d.quoteAmount).div(D(px)));
  sz = spec ? floorToLot(sz, spec.lotSz) : round8Down(sz);
  const order = {
    instId: d.instId, side: "buy" as const, px, sz, stopPx: d.stopPx ?? "0", tpPx: d.tpPx ?? "0",
    timeStopMin: d.timeStopMin ?? i.policy?.maxHoldMin ?? 240, decisionHash: i.decisionHash, nonce: i.nonce,
  };

  if (i.halted) reasons.push("HALTED");
  if (i.chain?.paused) reasons.push("POLICY_PAUSED");
  if (!i.chain || !i.policy || i.now - i.chain.checkedAt > 30_000) reasons.push("CHAIN_STATE_STALE");
  const marketOk = !!(snap && spec && i.account && !D(snap.bid).gt(D(snap.ask)));
  if (!marketOk) reasons.push("MARKET_DATA_MISSING");
  if (marketOk && snap && spec && i.account) {
    if (spec.state !== "live") reasons.push("INSTRUMENT_NOT_LIVE");
    if (i.now - snap.fetchedAt > i.cfg.maxSnapshotAgeSec * 1000) reasons.push("STALE_MARKET_DATA");
    const mid = D(snap.ask).add(D(snap.bid)).div(2);
    if (D(snap.ask).sub(D(snap.bid)).div(mid).mul(100).gt(D(i.cfg.maxSpreadPct))) reasons.push("SPREAD_TOO_WIDE");
    if (D(px).sub(D(snap.ask)).abs().div(D(snap.ask)).mul(100).gt(D(i.cfg.priceCollarPct))) reasons.push("PRICE_FAR_FROM_MARKET");
    if (D(sz).lt(D(spec.minSz))) reasons.push("ORDER_BELOW_MIN_SIZE");
    if (D(i.account.quoteAvail).lt(D(px).mul(D(sz)).mul(D(1).add(D(i.cfg.feeRate))))) reasons.push("INSUFFICIENT_BALANCE");
  }
  if (pos) reasons.push("POSITION_ALREADY_OPEN");
  if (i.lastLossExitAt !== null && i.now - i.lastLossExitAt < i.cfg.cooldownAfterLossMin * 60_000) reasons.push("COOLDOWN_ACTIVE");

  let route: PreflightResult["route"];
  if (i.forceChain) route = "CHAIN";
  else if (!i.test && (reasons.includes("HALTED") || reasons.includes("POLICY_PAUSED"))) route = "LOCAL_BLOCK";
  else if (suspect) route = "CHAIN";
  else if (i.test) route = "NONE";
  else if (reasons.length) route = "LOCAL_BLOCK";
  else route = "CHAIN";
  return { ...base, route, suspect, reasons, order };
}
