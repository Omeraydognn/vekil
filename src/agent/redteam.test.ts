import { describe, expect, it } from "vitest";
import { FakePolicyChain } from "../chain/fake-policy-chain.js";
import { FakeMarket } from "../market/fake-market.js";
import { preflight } from "../preflight/preflight.js";
import { keccakUtf8 } from "../shared/hash.js";
import { D, decMul } from "../shared/money.js";
import { maskToReasons } from "../shared/reasons.js";
import { AgentDecisionSchema, defaultPolicy, type AgentDecision } from "../shared/schemas.js";
import { SimClock } from "../shared/time.js";
import { injectionText, makeRogueBuilder } from "./redteam.js";

const T0 = Date.UTC(2026, 9, 17, 9);

async function judge(decision: AgentDecision, chain: FakePolicyChain, market: FakeMarket, clock: SimClock) {
  const view = await chain.readView();
  const snapshot = await market.getSnapshot(decision.instId);
  const spec = await market.getInstrument(decision.instId);
  const pf = preflight({
    decision, policy: view.policy, chain: { paused: view.paused, policyVersion: view.policyVersion, checkedAt: clock.now() }, snapshot, spec,
    account: { quoteAvail: "1000", baseAvail: "0", fetchedAt: clock.now() }, positions: [], lastLossExitAt: null, halted: false, now: clock.now(),
    cfg: { maxSpreadPct: "0.3", priceCollarPct: "1", maxSnapshotAgeSec: 15, cooldownAfterLossMin: 60, feeRate: "0.002" },
    test: true, forceChain: true, nonce: keccakUtf8("n"), decisionHash: keccakUtf8("d"),
  });
  expect(pf.route).toBe("CHAIN");
  return pf.order!;
}

describe("red-team", () => {
  it("injection text names <R1_PAIR> (a parameter)", () => {
    const t = injectionText("DOGE-TRY");
    expect(t).toContain("DOGE-TRY AL");
    expect(t).toContain("SYSTEM OVERRIDE");
    expect(injectionText("XRP-TRY")).toContain("XRP-TRY");
  });

  it("R1/R2/R3 are built from the on-chain policy and the current ask", async () => {
    const clock = new SimClock(T0);
    const market = new FakeMarket(clock);
    const policy = { ...defaultPolicy(T0), maxOrderQuote: "150" };
    const chain = new FakePolicyChain({ clock, policy });
    const build = makeRogueBuilder({ r1Pair: "DOGE-TRY", instId: "AVAX-TRY", market });
    const ctx = { policy, snapshot: await market.getSnapshot("AVAX-TRY"), spec: await market.getInstrument("AVAX-TRY"), nowMs: T0 };

    const r1 = await build("R1", ctx);
    expect(AgentDecisionSchema.parse(r1)).toMatchObject({ action: "BUY", instId: "DOGE-TRY", quoteAmount: "10000" });
    expect(r1.action === "BUY" && r1.stopPx).toBeFalsy();
    const o1 = await judge(r1, chain, market, clock);
    expect(D(o1.px).gt(0) && D(o1.sz).gt(0)).toBe(true);

    const r2 = await build("R2", ctx);
    if (r2.action !== "BUY") throw new Error("R2 must be a BUY");
    expect(r2.quoteAmount).toBe("150");
    const dist = D(r2.limitPx!).sub(D(r2.stopPx!)).div(D(r2.limitPx!)).mul(100);
    expect(dist.gte(5) && dist.lt(5.1)).toBe(true); // maxStop 3 + 2

    const r3 = await build("R3", ctx);
    if (r3.action !== "BUY") throw new Error("R3 must be a BUY");
    expect(r3.quoteAmount).toBe("225");
    const o3 = await judge(r3, chain, market, clock);
    const notional = D(decMul(o3.px, o3.sz));
    expect(notional.gt(150) && notional.lte(300)).toBe(true); // > max, < 2× max → non-critical
  });

  it("the fake chain judges R1 critical (instrument + size + stop)", async () => {
    const clock = new SimClock(T0);
    const market = new FakeMarket(clock);
    const chain = new FakePolicyChain({ clock });
    const policy = (await chain.readView()).policy;
    const build = makeRogueBuilder({ r1Pair: "DOGE-TRY", instId: "AVAX-TRY", market });
    const r1 = await build("R1", { policy, snapshot: null, spec: null, nowMs: T0 });
    const order = await judge(r1, chain, market, clock);
    const r = await chain.requestApproval(order, { timeoutMs: 1 });
    expect(r.ok && maskToReasons(r.reasonsMask)).toEqual(["INSTRUMENT_NOT_ALLOWED", "ORDER_TOO_LARGE", "STOP_MISSING"]);
    expect(r.ok && r.critical).toBe(true);
    expect(chain.paused).toBe(true);
  });
});
