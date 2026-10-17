import { describe, expect, it } from "vitest";
import { FakePolicyChain } from "../chain/fake-policy-chain.js";
import { FakeExchange } from "../executor/exchanges/fake-exchange.js";
import { Executor } from "../executor/executor.js";
import { InProcessExecutor } from "../executor/client.js";
import { MemoryStateStore } from "../executor/store.js";
import { FakeMarket } from "../market/fake-market.js";
import { keccakUtf8 } from "../shared/hash.js";
import { ceilToTick, decMul, floorToTick } from "../shared/money.js";
import type { ExecutorState, OrderRequest } from "../shared/schemas.js";
import { SimClock } from "../shared/time.js";
import { executorOrderSource, runAudit } from "./auditor.js";

async function setup() {
  const clock = new SimClock(Date.UTC(2026, 9, 17, 9), { autoAdvance: true });
  const chain = new FakePolicyChain({ clock });
  const market = new FakeMarket(clock);
  const exchange = new FakeExchange(market, clock, { startQuote: "1000", feeRate: "0.002" });
  const ex = new Executor({
    mode: "fake", chainId: chain.chainId, policy: chain.address, chain, exchange, market, clock, store: new MemoryStateStore<ExecutorState>(),
    atk: { kind: "fake", modules: [], readOnly: true, demo: false, tools: [] },
  });
  const api = new InProcessExecutor(ex);
  const audit = () => runAudit({
    source: executorOrderSource(api), sourceKind: "fake", chain, now: () => clock.now(),
    instIds: async () => (await chain.readView()).policy.instIds,
  });
  return { clock, chain, market, exchange, ex, audit };
}

describe("auditor (A1–A3)", () => {
  it("OK for an approved entry and its recorded exit; VIOLATION for an injected v-order; MANUAL otherwise", async () => {
    const { chain, market, exchange, ex, audit, clock } = await setup();
    const s = await market.getSnapshot("AVAX-TRY");
    const px = ceilToTick(decMul(s.ask, "1.001"), "0.1");
    const req: OrderRequest = {
      instId: "AVAX-TRY", side: "buy", px, sz: "0.4", stopPx: floorToTick(decMul(px, "0.99"), "0.1"), tpPx: "0", timeStopMin: 240,
      decisionHash: keccakUtf8("d"), nonce: keccakUtf8("n"),
    };
    const a = await chain.requestApproval(req, { timeoutMs: 1 });
    await ex.execute(req, a.orderHash);
    const exit = await ex.exit(a.orderHash, "OWNER_CLOSE");
    const xId = (exit.event!.data as { exitClOrdId: string }).exitClOrdId;

    // Exit not yet recorded on-chain: PENDING within 2 min, VIOLATION after.
    let r = await audit();
    expect(r.items.find((i) => i.clOrdId === xId)?.status).toBe("PENDING");
    await chain.recordExit(a.orderHash, xId.slice(1), 6, "-1");
    exchange.injectRestingOrder("v" + "b".repeat(30));
    exchange.injectRestingOrder("MANUALORDER");
    r = await audit();
    expect(r.items.map((i) => [i.kind, i.status])).toEqual([
      ["ENTRY", "OK"], ["EXIT", "OK"], ["ENTRY", "VIOLATION"], ["MANUAL", "OK"],
    ]);
    expect(r.ok).toBe(false);
    expect(r.checkedOrders).toBe(4);
    void clock;
  });

  it("an entry whose size differs from the approval is a VIOLATION", async () => {
    const { chain, exchange, audit } = await setup();
    const req: OrderRequest = {
      instId: "AVAX-TRY", side: "buy", px: "500", sz: "0.3", stopPx: "495", tpPx: "0", timeStopMin: 240,
      decisionHash: keccakUtf8("d2"), nonce: keccakUtf8("n2"),
    };
    const a = await chain.requestApproval(req, { timeoutMs: 1 });
    exchange.injectRestingOrder("v" + a.orderHash.slice(2, 32), { px: "500", sz: "0.6" });
    const r = await audit();
    expect(r.items[0]).toMatchObject({ kind: "ENTRY", status: "VIOLATION" });
    expect(r.items[0]!.detail).toContain("miktar");
  });

  it("an x-order older than 2 min without a record is a VIOLATION", async () => {
    const { exchange, audit, clock } = await setup();
    exchange.injectRestingOrder("x" + "c".repeat(30));
    clock.advance(3 * 60_000);
    expect((await audit()).items[0]).toMatchObject({ kind: "EXIT", status: "VIOLATION" });
  });
});
