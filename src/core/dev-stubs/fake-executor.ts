// DEV STUB (deleted at M2): an in-process ExecutorApi with the §14 semantics core relies on.
// Entries are re-checked against the chain; buys fill at the ask, sells at the bid. Tests can hook calls.
import { randomBytes } from "node:crypto";
import type { Clock, ExecutorApi, MarketData, PolicyChain } from "../../shared/interfaces.js";
import { D, decMin, decMul, decSub, floorToLot, isZero, toDecString } from "../../shared/money.js";
import { entryClOrdId, exitClOrdId, clOrdIdPrefix, orderHash as computeOrderHash } from "../../shared/order-hash.js";
import type { ExitReason } from "../../shared/reasons.js";
import type {
  AccountSnapshot, ExecResult, ExecutorEvent, ExecutorHealth, Hex32, OrderRequest, OrderState, PDec, Position,
} from "../../shared/schemas.js";

type Hook = "execute" | "exit" | "adjust" | "halt" | "cancelAll" | "health" | "events";

export interface FakeExecutorOpts {
  clock: Clock;
  chain: PolicyChain;
  market: MarketData;
  startQuote: string;
  feeRate: string;
  /** Runs before every call; throw to fail it, await to delay it. */
  before?: (call: Hook, args: unknown[]) => Promise<void> | void;
  /** Force the next execute result (tests). */
  forceResult?: "UNKNOWN" | "NOT_FILLED" | null;
}

export class FakeExecutor implements ExecutorApi {
  halted = false;
  positions: Position[] = [];
  inventory: Record<string, string> = {};
  quote: string;
  orderLog: OrderState[] = [];
  resting: OrderState[] = [];
  private evs: ExecutorEvent[] = [];
  private executed = new Set<string>();
  before: FakeExecutorOpts["before"];
  forceResult: FakeExecutorOpts["forceResult"];

  constructor(private readonly o: FakeExecutorOpts) {
    this.quote = o.startQuote;
    this.before = o.before;
    this.forceResult = o.forceResult ?? null;
  }

  private push(type: ExecutorEvent["type"], data: Record<string, unknown>): ExecutorEvent {
    const e = { n: this.evs.length + 1, ts: this.o.clock.now(), type, data } as ExecutorEvent;
    this.evs.push(e);
    return e;
  }

  async health(): Promise<ExecutorHealth> {
    await this.before?.("health", []);
    const v = await this.o.chain.readView();
    return {
      ok: true, mode: "fake", chainId: this.o.chain.chainId, policy: this.o.chain.address, paused: v.paused, policyVersion: v.policyVersion,
      halted: this.halted, inventory: { ...this.inventory }, positions: this.positions.map((p) => ({ ...p })),
      atk: { kind: "fake", modules: [], readOnly: true, demo: false, tools: [] },
    };
  }

  async account(instId: string): Promise<AccountSnapshot> {
    return { quoteAvail: this.quote, baseAvail: this.inventory[instId] ?? "0", fetchedAt: this.o.clock.now() };
  }

  async orders(instIds: string[], sinceMs: number): Promise<OrderState[]> {
    return [...this.orderLog, ...this.resting].filter((o) => instIds.includes(o.instId) && o.cTime >= sinceMs);
  }

  async execute(req: OrderRequest, orderHash: Hex32): Promise<ExecResult> {
    await this.before?.("execute", [req, orderHash]);
    const refuse = (refusal: ExecResult["refusal"]): ExecResult => ({ result: "REFUSED", refusal, event: null });
    if (computeOrderHash(this.o.chain.chainId, this.o.chain.address, req) !== orderHash) return refuse("HASH_MISMATCH");
    if (this.halted) return refuse("EXEC_HALTED");
    const a = await this.o.chain.approval(orderHash);
    const v = await this.o.chain.readView();
    if (a.status !== 1) return refuse("NOT_APPROVED");
    if (a.expiresAt * 1000 < this.o.clock.now()) return refuse("APPROVAL_EXPIRED");
    if (a.policyVersion !== v.policyVersion) return refuse("POLICY_CHANGED");
    if (v.paused) return refuse("EXEC_PAUSED");
    if (this.executed.has(orderHash)) return refuse("ALREADY_EXECUTED");
    this.executed.add(orderHash);
    const clOrdId = entryClOrdId(orderHash);
    if (this.forceResult) {
      const r = this.forceResult;
      this.forceResult = null;
      return { result: r, refusal: null, event: this.push(r, { orderHash, clOrdId }) };
    }
    const snap = await this.o.market.getSnapshot(req.instId);
    if (D(req.px).lt(D(snap.ask))) return { result: "NOT_FILLED", refusal: null, event: this.push("NOT_FILLED", { orderHash, clOrdId }) };
    const spec = await this.o.market.getInstrument(req.instId);
    const fee = toDecString(D(req.sz).mul(D(this.o.feeRate)));
    const net = floorToLot(decSub(req.sz, fee), spec.lotSz);
    const cost = decMul(snap.ask, req.sz);
    this.quote = decSub(this.quote, cost);
    const now = this.o.clock.now();
    this.orderLog.push({ ordId: `f${this.orderLog.length + 1}`, clOrdId, instId: req.instId, side: "buy", px: req.px, sz: req.sz, state: "filled", accFillSz: req.sz, avgPx: snap.ask, fee: `-${fee}`, feeCcy: spec.baseCcy, cTime: now });
    const dust = D(net).lt(D(spec.minSz));
    if (!dust) {
      this.inventory[req.instId] = toDecString(D(this.inventory[req.instId] ?? "0").add(D(net)));
      this.positions.push({
        entryOrderHash: orderHash, clOrdId, instId: req.instId, sz: net, entryPx: snap.ask, costQuote: cost, openedAt: now,
        stopPx: req.stopPx, tpPx: isZero(req.tpPx) ? null : req.tpPx, timeStopAt: a.at * 1000 + req.timeStopMin * 60_000, exiting: null,
      });
    }
    const event = this.push("FILL", { orderHash, clOrdId, ordId: `f${this.orderLog.length}`, state: "filled", accFillSz: req.sz, avgPx: snap.ask, fee: `-${fee}`, feeCcy: spec.baseCcy, cTime: now, dust });
    return { result: "FILLED", refusal: null, event };
  }

  async adjust(entryOrderHash: Hex32, newStopPx?: PDec, newTpPx?: PDec): Promise<ExecResult> {
    await this.before?.("adjust", [entryOrderHash, newStopPx, newTpPx]);
    const p = this.positions.find((x) => x.entryOrderHash === entryOrderHash);
    if (!p) return { result: "REFUSED", refusal: "ADJUST_INVALID", event: null };
    const snap = await this.o.market.getSnapshot(p.instId);
    if (newStopPx !== undefined && (D(newStopPx).lt(D(p.stopPx)) || D(newStopPx).gte(D(snap.bid)))) return { result: "REFUSED", refusal: "ADJUST_INVALID", event: null };
    if (newTpPx !== undefined && D(newTpPx).lte(D(snap.bid))) return { result: "REFUSED", refusal: "ADJUST_INVALID", event: null };
    const from = { stopPx: p.stopPx, tpPx: p.tpPx };
    if (newStopPx !== undefined) p.stopPx = newStopPx;
    if (newTpPx !== undefined) p.tpPx = newTpPx;
    return { result: "OK", refusal: null, event: this.push("ADJUST", { entryOrderHash, from, to: { stopPx: p.stopPx, tpPx: p.tpPx } }) };
  }

  async exit(entryOrderHash: Hex32, reason: ExitReason): Promise<ExecResult> {
    await this.before?.("exit", [entryOrderHash, reason]);
    const p = this.positions.find((x) => x.entryOrderHash === entryOrderHash);
    if (!p) return { result: "REFUSED", refusal: "EXCEEDS_INVENTORY", event: null };
    if (p.exiting) return { result: "REFUSED", refusal: "EXIT_IN_PROGRESS", event: null };
    const spec = await this.o.market.getInstrument(p.instId);
    const sz = floorToLot(decMin(p.sz, this.inventory[p.instId] ?? "0"), spec.lotSz);
    if (isZero(sz)) return { result: "REFUSED", refusal: "EXCEEDS_INVENTORY", event: null };
    const exitClOrd = exitClOrdId(entryOrderHash, `0x${randomBytes(32).toString("hex")}`);
    const snap = await this.o.market.getSnapshot(p.instId);
    const gross = decMul(snap.bid, sz);
    const fee = toDecString(D(gross).mul(D(this.o.feeRate)));
    const proceeds = decSub(gross, fee);
    const pnl = toDecString(D(proceeds).sub(D(p.costQuote)).toDecimalPlaces(8, 1));
    this.quote = toDecString(D(this.quote).add(D(proceeds)));
    this.inventory[p.instId] = decSub(this.inventory[p.instId] ?? "0", sz);
    this.positions = this.positions.filter((x) => x !== p);
    const now = this.o.clock.now();
    this.orderLog.push({ ordId: `f${this.orderLog.length + 1}`, clOrdId: exitClOrd, instId: p.instId, side: "sell", px: null, sz, state: "filled", accFillSz: sz, avgPx: snap.bid, fee: `-${fee}`, feeCcy: spec.quoteCcy, cTime: now });
    const event = this.push("EXIT", { entryOrderHash, exitClOrdId: exitClOrd, exitPrefix: clOrdIdPrefix(exitClOrd), reason, soldSz: sz, avgPx: snap.bid, proceedsQuote: proceeds, pnlQuote: pnl, cTime: now });
    return { result: "FILLED", refusal: null, event };
  }

  async halt(): Promise<void> {
    await this.before?.("halt", []);
    this.halted = true;
  }

  async cancelAll(by: "kill" | "api"): Promise<string[]> {
    await this.before?.("cancelAll", [by]);
    const ids = this.resting.map((o) => o.clOrdId);
    for (const o of this.resting) this.orderLog.push({ ...o, state: "canceled" });
    this.resting = [];
    if (ids.length) this.push("CANCEL", { clOrdIds: ids, by });
    return ids;
  }

  async events(sinceN: number): Promise<ExecutorEvent[]> {
    await this.before?.("events", [sinceN]);
    return this.evs.filter((e) => e.n > sinceN);
  }

  /** Test/dev helpers. */
  injectRestingOrder(clOrdId: string, instId = "AVAX-TRY"): void {
    this.resting.push({ ordId: `r${this.resting.length + 1}`, clOrdId, instId, side: "buy", px: "1", sz: "1", state: "live", accFillSz: "0", avgPx: null, fee: "0", feeCcy: "TRY", cTime: this.o.clock.now() });
  }
  pushEvent(type: ExecutorEvent["type"], data: Record<string, unknown>): ExecutorEvent {
    return this.push(type, data);
  }
}
