import { beforeEach, describe, expect, it } from "vitest";
import { FakePolicyChain } from "../chain/fake-policy-chain.js";
import { FakeMarket } from "../market/fake-market.js";
import { keccakUtf8 } from "../shared/hash.js";
import { ceilToTick, decMul, floorToTick, toDecString, D } from "../shared/money.js";
import { entryClOrdId, orderHash } from "../shared/order-hash.js";
import type { ExecutorState, Hex32, OrderRequest } from "../shared/schemas.js";
import { SimClock } from "../shared/time.js";
import { FakeExchange } from "./exchanges/fake-exchange.js";
import { EXIT_POLL_MAX_TRIES, Executor, type PendingEntry } from "./executor.js";
import { MemoryStateStore } from "./store.js";

const T0 = Date.UTC(2026, 9, 17, 9, 0, 0);

let clock: SimClock;
let chain: FakePolicyChain;
let market: FakeMarket;
let exchange: FakeExchange;
let store: MemoryStateStore<ExecutorState>;
let ex: Executor;
let n = 0;

function make(): Executor {
  return new Executor({
    mode: "fake", chainId: chain.chainId, policy: chain.address, chain, exchange, market, clock, store,
    atk: { kind: "fake", modules: [], readOnly: true, demo: false, tools: [] },
    randomHex32: () => keccakUtf8(`nonce-${++n}`),
  });
}

beforeEach(() => {
  clock = new SimClock(T0, { autoAdvance: true });
  chain = new FakePolicyChain({ clock });
  market = new FakeMarket(clock);
  exchange = new FakeExchange(market, clock, { startQuote: "1000", feeRate: "0.002" });
  store = new MemoryStateStore();
  ex = make();
});

async function buyReq(over: Partial<OrderRequest> = {}): Promise<OrderRequest> {
  const s = await market.getSnapshot("AVAX-TRY");
  const px = ceilToTick(decMul(s.ask, "1.001"), "0.1");
  return {
    instId: "AVAX-TRY", side: "buy", px, sz: "0.4", stopPx: floorToTick(decMul(px, "0.99"), "0.1"), tpPx: ceilToTick(decMul(px, "1.02"), "0.1"),
    timeStopMin: 240, decisionHash: keccakUtf8("d"), nonce: keccakUtf8(`n-${++n}`), ...over,
  };
}

async function approved(over: Partial<OrderRequest> = {}): Promise<{ req: OrderRequest; h: Hex32 }> {
  const req = await buyReq(over);
  const r = await chain.requestApproval(req, { timeoutMs: 1000 });
  if (!r.ok || r.status !== "APPROVED") throw new Error("not approved");
  return { req, h: r.orderHash };
}

describe("execute (§14.2)", () => {
  it("places exactly the approved IOC order with clOrdId from the hash and opens a position", async () => {
    const { req, h } = await approved();
    const r = await ex.execute(req, h);
    expect(r.result).toBe("FILLED");
    const orders = await exchange.listRecentOrders("AVAX-TRY", 0);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ clOrdId: entryClOrdId(h), side: "buy", px: req.px, sz: req.sz });
    const st = ex.state;
    expect(st.executed).toEqual([h]);
    expect(st.positions[0]).toMatchObject({ entryOrderHash: h, stopPx: req.stopPx, tpPx: req.tpPx, sz: "0.3992" });
    const a = await chain.approval(h);
    expect(st.positions[0]!.timeStopAt).toBe(a.at * 1000 + 240 * 60_000);
    expect(st.inventory["AVAX-TRY"]).toBe("0.3992");
    expect(r.event?.type).toBe("FILL");
  });

  it("HASH_MISMATCH when the hash is not ours to recompute", async () => {
    const { req, h } = await approved();
    expect((await ex.execute({ ...req, sz: "0.5" }, h)).refusal).toBe("HASH_MISMATCH");
    const foreign = orderHash(43113, chain.address, req);
    expect((await ex.execute(req, foreign)).refusal).toBe("HASH_MISMATCH");
  });

  it("NOT_APPROVED for unknown and rejected hashes", async () => {
    const req = await buyReq();
    expect((await ex.execute(req, orderHash(chain.chainId, chain.address, req))).refusal).toBe("NOT_APPROVED");
    const bad = await buyReq({ stopPx: "0" });
    const r = await chain.requestApproval(bad, { timeoutMs: 1 });
    expect((await ex.execute(bad, r.orderHash)).refusal).toBe("NOT_APPROVED");
  });

  it("APPROVAL_EXPIRED uses max(clock, block timestamp)", async () => {
    const { req, h } = await approved();
    clock.advance(121_000);
    expect((await ex.execute(req, h)).refusal).toBe("APPROVAL_EXPIRED");

    const b = await approved();
    const real = chain.latestBlockTimestamp.bind(chain);
    chain.latestBlockTimestamp = async () => (await real()) + 500; // the block is ahead of our clock
    expect((await ex.execute(b.req, b.h)).refusal).toBe("APPROVAL_EXPIRED");
  });

  it("POLICY_CHANGED after a new policy version", async () => {
    const { req, h } = await approved();
    const v = await chain.readView();
    await chain.setPolicy({ ...v.policy, maxOrderQuote: "150" });
    expect((await ex.execute(req, h)).refusal).toBe("POLICY_CHANGED");
  });

  it("EXEC_PAUSED while the contract is paused, EXEC_HALTED after halt", async () => {
    const a = await approved();
    await chain.pause();
    expect((await ex.execute(a.req, a.h)).refusal).toBe("EXEC_PAUSED");
    await chain.unpause();
    await ex.halt();
    expect((await ex.execute(a.req, a.h)).refusal).toBe("EXEC_HALTED");
    expect(await exchange.listRecentOrders("AVAX-TRY", 0)).toEqual([]);
  });

  it("ALREADY_EXECUTED for a second call and for an order already on the exchange", async () => {
    const a = await approved();
    expect((await ex.execute(a.req, a.h)).result).toBe("FILLED");
    expect((await ex.execute(a.req, a.h)).refusal).toBe("ALREADY_EXECUTED");
    const b = await approved();
    exchange.injectRestingOrder(entryClOrdId(b.h));
    expect((await ex.execute(b.req, b.h)).refusal).toBe("ALREADY_EXECUTED");
  });

  it("NOT_FILLED when the IOC price is below the ask; no position", async () => {
    const s = await market.getSnapshot("AVAX-TRY");
    const px = floorToTick(decMul(s.ask, "0.999"), "0.1");
    const a = await approved({ px, stopPx: floorToTick(decMul(px, "0.99"), "0.1"), tpPx: ceilToTick(decMul(px, "1.02"), "0.1") });
    const r = await ex.execute(a.req, a.h);
    expect(r.result).toBe("NOT_FILLED");
    expect(ex.state.positions).toEqual([]);
  });

  it("dust: a fill below minSz after the fee creates no position", async () => {
    const a = await approved({ sz: "0.1" }); // net 0.0998 < minSz 0.1
    const r = await ex.execute(a.req, a.h);
    expect(r.result).toBe("FILLED");
    expect(r.event).toMatchObject({ type: "FILL", data: { dust: true } });
    expect(ex.state.positions).toEqual([]);
    expect(ex.state.inventory["AVAX-TRY"]).toBe("0.0998");
  });

  it("UNKNOWN when the order never reaches a terminal state; resolves in the background", async () => {
    const a = await approved();
    const orig = exchange.getOrder.bind(exchange);
    let stuck = true;
    exchange.getOrder = async (i, c) => {
      const o = await orig(i, c);
      return stuck ? { ...o, state: "live" } : o;
    };
    const r = await ex.execute(a.req, a.h);
    expect(r.result).toBe("UNKNOWN");
    expect(ex.state.positions).toEqual([]);
    stuck = false;
    clock.advance(5_000);
    await new Promise((res) => setTimeout(res, 0));
    expect(ex.state.positions).toHaveLength(1);
    expect(ex.state.events.map((e) => e.type)).toEqual(["UNKNOWN", "FILL"]);
    ex.stop();
  });
});

describe("exits, adjust, inventory (§14.3)", () => {
  async function open(): Promise<Hex32> {
    const a = await approved();
    await ex.execute(a.req, a.h);
    return a.h;
  }

  it("sells only its own inventory with an x-clOrdId and records EXIT with PnL", async () => {
    const h = await open();
    const r = await ex.exit(h, "OWNER_CLOSE");
    expect(r.result).toBe("FILLED");
    expect(r.event).toMatchObject({ type: "EXIT", data: { entryOrderHash: h, reason: "OWNER_CLOSE", soldSz: "0.3992" } });
    const sell = (await exchange.listRecentOrders("AVAX-TRY", 0)).find((o) => o.side === "sell");
    expect(sell?.clOrdId).toMatch(/^x[0-9a-f]{30}$/);
    expect(ex.state.positions).toEqual([]);
    expect(ex.state.inventory["AVAX-TRY"]).toBe("0");
    expect(D((r.event!.data as { pnlQuote: string }).pnlQuote).isNegative()).toBe(true);
  });

  it("EXCEEDS_INVENTORY for an unknown position", async () => {
    expect((await ex.exit(keccakUtf8("nope"), "AGENT_CLOSE")).refusal).toBe("EXCEEDS_INVENTORY");
  });

  it("never sells more than the account holds", async () => {
    const h = await open();
    exchange.getAccount = async () => ({ quoteAvail: "0", baseAvail: "0.2", fetchedAt: clock.now() });
    const r = await ex.exit(h, "AGENT_CLOSE");
    expect(r.event).toMatchObject({ type: "EXIT", data: { soldSz: "0.2" } });
    expect(ex.state.positions[0]?.sz).toBe("0.1992");
  });

  it("one in-flight exit per position: a concurrent exit gets EXIT_IN_PROGRESS", async () => {
    const h = await open();
    const [a, b] = await Promise.all([ex.exit(h, "STOP_HIT"), ex.exit(h, "OWNER_CLOSE")]);
    expect([a.result, b.refusal].sort()).toEqual(["EXIT_IN_PROGRESS", "FILLED"].sort());
  });

  it("exits work while halted and while paused", async () => {
    const h = await open();
    await ex.halt();
    await chain.pause();
    expect((await ex.exit(h, "KILL_FLATTEN")).result).toBe("FILLED");
  });

  it("adjust tightens only; ADJUST_INVALID otherwise", async () => {
    const h = await open();
    const pos = ex.state.positions[0]!;
    const bid = (await market.getSnapshot("AVAX-TRY")).bid;
    expect((await ex.adjust(h, toDecString(D(pos.stopPx).sub("0.5")))).refusal).toBe("ADJUST_INVALID");
    expect((await ex.adjust(h, bid)).refusal).toBe("ADJUST_INVALID");
    expect((await ex.adjust(h, undefined, bid)).refusal).toBe("ADJUST_INVALID");
    expect((await ex.adjust(keccakUtf8("x"), "1")).refusal).toBe("ADJUST_INVALID");
    const tighter = toDecString(D(pos.stopPx).add("0.5"));
    const r = await ex.adjust(h, tighter);
    expect(r.result).toBe("OK");
    expect(r.event).toMatchObject({ type: "ADJUST", data: { from: { stopPx: pos.stopPx }, to: { stopPx: tighter } } });
  });
});

describe("monitor and pause watcher (§14.4, §14.5)", () => {
  it("STOP_HIT, TP_HIT and TIME_STOP", async () => {
    const a = await approved();
    await ex.execute(a.req, a.h);
    market.forcePrice("AVAX-TRY", toDecString(D(a.req.stopPx).sub("1")));
    await ex.monitorTick();
    expect(ex.state.events.at(-1)).toMatchObject({ type: "EXIT", data: { reason: "STOP_HIT" } });

    market.clearForcedPrice("AVAX-TRY");
    const b = await approved();
    await ex.execute(b.req, b.h);
    market.forcePrice("AVAX-TRY", toDecString(D(b.req.tpPx).add("1")));
    await ex.monitorTick();
    expect(ex.state.events.at(-1)).toMatchObject({ type: "EXIT", data: { reason: "TP_HIT" } });

    market.clearForcedPrice("AVAX-TRY");
    await chain.setPolicy({ ...(await chain.readView()).policy, maxTradesPerHour: 5, maxTradesPerDay: 10 });
    const c = await approved({ timeStopMin: 15 });
    await ex.execute(c.req, c.h);
    clock.advance(16 * 60_000);
    market.forcePrice("AVAX-TRY", (await market.getSnapshot("AVAX-TRY")).last);
    await ex.monitorTick();
    expect(ex.state.events.at(-1)).toMatchObject({ type: "EXIT", data: { reason: "TIME_STOP" } });
  });

  it("never sells blind: ticker outage raises one ALERT after 6 failures", async () => {
    const a = await approved();
    await ex.execute(a.req, a.h);
    clock.advance(10 * 60 * 60_000); // past the time stop
    market.setFailing("AVAX-TRY", true);
    for (let i = 0; i < 8; i++) await ex.monitorTick();
    expect(ex.state.positions).toHaveLength(1);
    expect(ex.state.events.filter((e) => e.type === "ALERT")).toHaveLength(1);
  });

  it("on pause: cancels our resting orders, halts, appends CANCEL and PAUSE_SEEN", async () => {
    exchange.injectRestingOrder("v" + "a".repeat(30));
    exchange.injectRestingOrder("MANUAL1");
    await ex.pauseWatchTick();
    expect(ex.state.halted).toBe(false);
    await chain.pause();
    await ex.pauseWatchTick();
    const st = ex.state;
    expect(st.halted).toBe(true);
    expect(st.lastSeenPaused).toBe(true);
    expect(st.events.map((e) => e.type)).toEqual(["CANCEL", "PAUSE_SEEN"]);
    expect(st.events[0]).toMatchObject({ data: { clOrdIds: ["v" + "a".repeat(30)], by: "pause-watch" } });
    expect((await exchange.listOpenOrders("AVAX-TRY")).map((o) => o.clOrdId)).toEqual(["MANUAL1"]);
    await ex.pauseWatchTick();
    expect(ex.state.events).toHaveLength(2);
  });

  it("start() runs both loops on the clock", async () => {
    const stop = ex.start({ monitorIntervalMs: 10_000, chainWatchIntervalMs: 3_000 });
    await chain.pause();
    clock.advance(3_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(ex.state.halted).toBe(true);
    stop();
  });

  it("refuses a state file from another run", async () => {
    await ex.halt();
    expect(() => new Executor({
      mode: "paper", chainId: chain.chainId, policy: chain.address, chain, exchange, market, clock, store,
      atk: { kind: "fake", modules: [], readOnly: true, demo: false, tools: [] },
    })).toThrow(/belongs to/);
    expect(make().state.halted).toBe(true); // same run: reloads
  });
});

describe("restart recovery", () => {
  it("an exit in flight at restart is resolved (filled) or released (never sent)", async () => {
    const a = await approved();
    await ex.execute(a.req, a.h);
    // Simulate a crash right after `exiting` was persisted, before the sell reached the exchange.
    const st = store.load()!;
    st.positions[0]!.exiting = { clOrdId: `x${"1".repeat(30)}`, reason: "STOP_HIT", reservedSz: "0.3992", since: clock.now() };
    store.save(st);
    const ex2 = make();
    expect((await ex2.exit(a.h, "OWNER_CLOSE")).refusal).toBe("EXIT_IN_PROGRESS");
    await ex2.recover();
    expect(ex2.state.positions[0]!.exiting).toBeNull();
    expect((await ex2.exit(a.h, "OWNER_CLOSE")).result).toBe("FILLED");
  });

  it("an entry placed before a restart becomes a protected position", async () => {
    const pendingStore = new MemoryStateStore<PendingEntry[]>();
    const mk = () => new Executor({
      mode: "fake", chainId: chain.chainId, policy: chain.address, chain, exchange, market, clock, store, pendingStore,
      atk: { kind: "fake", modules: [], readOnly: true, demo: false, tools: [] },
    });
    const e1 = mk();
    const a = await approved();
    const orig = exchange.getOrder.bind(exchange);
    exchange.getOrder = async (i, c) => ({ ...(await orig(i, c)), state: "live" });
    expect((await e1.execute(a.req, a.h)).result).toBe("UNKNOWN");
    e1.stop(); // "crash"
    exchange.getOrder = orig;
    expect(pendingStore.load()).toHaveLength(1);
    const e2 = mk();
    await e2.recover();
    expect(e2.state.positions.map((p) => p.entryOrderHash)).toEqual([a.h]);
    expect(pendingStore.load()).toEqual([]);
  });

  it("an exit whose state stays unknown is released after a bounded number of polls", async () => {
    const a = await approved();
    await ex.execute(a.req, a.h);
    const orig = exchange.getOrder.bind(exchange);
    exchange.getOrder = async (i, c) => ({ ...(await orig(i, c)), state: "live" });
    expect((await ex.exit(a.h, "STOP_HIT")).result).toBe("UNKNOWN");
    for (let i = 0; i < EXIT_POLL_MAX_TRIES; i++) {
      clock.advance(5_000);
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(ex.state.positions[0]?.exiting ?? null).toBeNull();
    expect(ex.state.events.at(-1)).toMatchObject({ type: "ALERT", data: { code: "EXIT_STATE_UNKNOWN" } });
    ex.stop();
  });
});
