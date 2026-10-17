// The isolated executor (SPEC §14). It is the only component that holds the trade key. It sends an entry only for an
// orderHash it recomputed itself, only if that hash is APPROVED on-chain, unexpired, under the same policy version and
// with the contract not paused. It sells only its own inventory, one exit at a time per position. Exits never wait for
// the chain and work while halted or paused. It reads the chain; it holds no chain key.
import { randomBytes } from "node:crypto";
import type { Clock, Exchange, ExecutorApi, MarketData, PolicyChain, StateStore } from "../shared/interfaces.js";
import { decGt, decGte, decLt, decLte, decMin, decMul, decSub, decAdd, decAbs, decDiv, floorToLot, isZero, toDecString, D } from "../shared/money.js";
import { CLORDID_RE, entryClOrdId, exitClOrdId, orderHash as computeOrderHash } from "../shared/order-hash.js";
import type { ExecutorRefusal, ExitReason } from "../shared/reasons.js";
import {
  OrderRequestSchema,
  type AccountSnapshot,
  type Address,
  type ExecResult,
  type ExecutorEvent,
  type ExecutorHealth,
  type ExecutorState,
  type Hex32,
  type InstrumentSpec,
  type Mode,
  type OrderRequest,
  type OrderState,
  type PDec,
  type Position,
} from "../shared/schemas.js";
import { OrderNotFoundError, TERMINAL_STATES } from "./exchanges/types.js";

export const POLL_MS = 500;
export const POLL_TIMEOUT_MS = 10_000;
export const BACKGROUND_POLL_MS = 5_000;
export const TICKER_FAIL_ALERT = 6;
const CANCEL_RETRIES = 3;
const FALLBACK_LOT = "0.00000001";

type EventData<T extends ExecutorEvent["type"]> = Extract<ExecutorEvent, { type: T }>["data"];

export interface ExecutorOpts {
  mode: Mode;
  chainId: number;
  policy: Address;
  chain: PolicyChain;
  exchange: Exchange;
  market: MarketData;
  clock: Clock;
  store: StateStore<ExecutorState>;
  atk: ExecutorHealth["atk"];
  /** Entries placed but not yet final (survives a restart; recover() resumes them). Default: in memory. */
  pendingStore?: StateStore<PendingEntry[]>;
  /** Extra instruments to sweep on cancel-all (besides the policy's and the positions'). */
  instIds?: string[];
  /** 32 random bytes as 0x-hex (exit nonces); injectable for tests. */
  randomHex32?: () => Hex32;
  pollMs?: number;
  pollTimeoutMs?: number;
  backgroundPollMs?: number;
}

/** An entry that was placed and has no FILL / NOT_FILLED yet. */
export interface PendingEntry {
  orderHash: Hex32;
  req: OrderRequest;
  approvalAt: number;
}

/** Background polls of an exit give up after this many tries, clear `exiting` and alert, so exits can be retried
 * (the next sell is bounded by our inventory and the account's base balance, so it can never oversell). */
export const EXIT_POLL_MAX_TRIES = 12;

export class ExecutorStateMismatchError extends Error {
  override name = "ExecutorStateMismatchError";
}

const refused = (refusal: ExecutorRefusal): ExecResult => ({ result: "REFUSED", refusal, event: null });

export class Executor implements ExecutorApi {
  private st: ExecutorState;
  private readonly specs = new Map<string, InstrumentSpec>();
  private readonly exitLocks = new Set<string>();
  private readonly entryLocks = new Set<string>();
  private readonly tickerFails = new Map<string, number>();
  private readonly background = new Set<string>();
  private pending: PendingEntry[] = [];
  private stopped = false;
  private readonly randomHex32: () => Hex32;

  constructor(private readonly o: ExecutorOpts) {
    this.randomHex32 = o.randomHex32 ?? (() => `0x${randomBytes(32).toString("hex")}` as Hex32);
    const loaded = o.store.load();
    if (loaded) {
      if (loaded.mode !== o.mode || loaded.chainId !== o.chainId || loaded.policy !== o.policy) {
        throw new ExecutorStateMismatchError(
          `executor-state.json belongs to ${loaded.mode}/${loaded.chainId}/${loaded.policy}, not ${o.mode}/${o.chainId}/${o.policy}`,
        );
      }
      this.st = loaded;
      this.pending = o.pendingStore?.load() ?? [];
    } else {
      this.st = { mode: o.mode, chainId: o.chainId, policy: o.policy, halted: false, lastSeenPaused: false, executed: [], inventory: {}, positions: [], events: [] };
      this.save();
    }
  }

  // ------------------------------------------------------------ state helpers
  private save(): void {
    this.o.store.save(this.st);
  }

  private push<T extends ExecutorEvent["type"]>(type: T, data: EventData<T>): ExecutorEvent {
    const n = (this.st.events.at(-1)?.n ?? 0) + 1;
    const e = { n, ts: this.o.clock.now(), type, data } as ExecutorEvent;
    this.st.events.push(e);
    this.save();
    return structuredClone(e);
  }

  private position(entryOrderHash: string): Position | undefined {
    return this.st.positions.find((p) => p.entryOrderHash === entryOrderHash);
  }

  private async spec(instId: string): Promise<InstrumentSpec | null> {
    const cached = this.specs.get(instId);
    if (cached) return cached;
    try {
      const s = await this.o.market.getInstrument(instId);
      this.specs.set(instId, s);
      return s;
    } catch {
      return null;
    }
  }

  private baseCcy(instId: string, spec: InstrumentSpec | null): string {
    return spec?.baseCcy ?? instId.split("-")[0] ?? instId;
  }

  private savePending(): void {
    this.o.pendingStore?.save(this.pending);
  }

  /**
   * After a restart: resolve every exit that was in flight and every entry that was placed but never reached a final
   * state, so no position is left unprotected or un-exitable. Call once before serving.
   */
  async recover(): Promise<void> {
    for (const pos of this.st.positions) {
      if (!pos.exiting) continue;
      const spec = await this.spec(pos.instId);
      const clOrdId = pos.exiting.clOrdId;
      try {
        const o = await this.o.exchange.getOrder(pos.instId, clOrdId);
        if (TERMINAL_STATES.has(o.state)) this.onExitFinal(pos.entryOrderHash, o, spec);
        else this.pollExitInBackground(pos.entryOrderHash, pos.instId, clOrdId, spec);
      } catch (e) {
        if (e instanceof OrderNotFoundError) {
          pos.exiting = null; // never reached the exchange: the monitor / owner can exit again
          this.save();
        } else this.pollExitInBackground(pos.entryOrderHash, pos.instId, clOrdId, spec);
      }
    }
    for (const p of [...this.pending]) {
      const spec = await this.spec(p.req.instId);
      const clOrdId = entryClOrdId(p.orderHash);
      const final = (o: OrderState): void => {
        this.onEntryFinal(p.req, p.orderHash, o, p.approvalAt, spec);
      };
      try {
        const o = await this.o.exchange.getOrder(p.req.instId, clOrdId);
        if (TERMINAL_STATES.has(o.state)) final(o);
        else this.pollInBackground(p.req.instId, clOrdId, final);
      } catch (e) {
        if (e instanceof OrderNotFoundError) final({ ordId: "", clOrdId, instId: p.req.instId, side: "buy", px: p.req.px, sz: p.req.sz, state: "canceled", accFillSz: "0", avgPx: null, fee: "0", feeCcy: "", cTime: this.o.clock.now() });
        else this.pollInBackground(p.req.instId, clOrdId, final);
      }
    }
  }

  /** Read-only view for tests and the in-process adapter. */
  get state(): ExecutorState {
    return structuredClone(this.st);
  }

  // ------------------------------------------------------------ ExecutorApi
  async health(): Promise<ExecutorHealth> {
    let paused = this.st.lastSeenPaused;
    let policyVersion = 0;
    let ok = true;
    try {
      const v = await this.o.chain.readView();
      paused = v.paused;
      policyVersion = v.policyVersion;
    } catch {
      ok = false;
    }
    return {
      ok,
      mode: this.o.mode,
      chainId: this.o.chainId,
      policy: this.o.policy,
      paused,
      policyVersion,
      halted: this.st.halted,
      inventory: { ...this.st.inventory },
      positions: structuredClone(this.st.positions),
      atk: structuredClone(this.o.atk),
    };
  }

  account(instId: string): Promise<AccountSnapshot> {
    return this.o.exchange.getAccount(instId);
  }

  async orders(instIds: string[], sinceMs: number): Promise<OrderState[]> {
    const out: OrderState[] = [];
    for (const id of instIds) out.push(...(await this.o.exchange.listRecentOrders(id, sinceMs)));
    return out;
  }

  async events(sinceN: number): Promise<ExecutorEvent[]> {
    return structuredClone(this.st.events.filter((e) => e.n > sinceN));
  }

  async halt(): Promise<void> {
    if (!this.st.halted) {
      this.st.halted = true;
      this.save();
    }
  }

  /** §14.2 Execute an entry. */
  async execute(reqIn: OrderRequest, orderHashIn: Hex32): Promise<ExecResult> {
    const parsed = OrderRequestSchema.safeParse(reqIn);
    if (!parsed.success) return refused("HASH_MISMATCH");
    const req = parsed.data;
    // 1. Recompute the hash with our own chainId and policy address.
    let h: Hex32;
    try {
      h = computeOrderHash(this.o.chainId, this.o.policy, req);
    } catch {
      return refused("HASH_MISMATCH");
    }
    if (h !== orderHashIn.toLowerCase()) return refused("HASH_MISMATCH");
    // 2. Halted.
    if (this.st.halted) return refused("EXEC_HALTED");
    if (this.entryLocks.has(h)) return refused("ALREADY_EXECUTED");
    this.entryLocks.add(h);
    try {
      return await this.executeChecked(req, h);
    } finally {
      this.entryLocks.delete(h);
    }
  }

  private async executeChecked(req: OrderRequest, h: Hex32): Promise<ExecResult> {
    const clOrdId = entryClOrdId(h);
    // 3. Chain checks; any read failure fails closed.
    let approvalAt: number;
    try {
      const a = await this.o.chain.approval(h);
      if (a.status !== 1) return refused("NOT_APPROVED");
      const blockTs = await this.o.chain.latestBlockTimestamp();
      if (a.expiresAt * 1000 < Math.max(this.o.clock.now(), blockTs * 1000)) return refused("APPROVAL_EXPIRED");
      const view = await this.o.chain.readView();
      if (a.policyVersion !== view.policyVersion) return refused("POLICY_CHANGED");
      if (view.paused) return refused("EXEC_PAUSED");
      approvalAt = a.at;
    } catch {
      return refused("NOT_APPROVED");
    }
    if (this.st.halted) return refused("EXEC_HALTED");
    // 4. Never twice.
    if (this.st.executed.includes(h)) return refused("ALREADY_EXECUTED");
    try {
      await this.o.exchange.getOrder(req.instId, clOrdId);
      this.st.executed.push(h);
      this.save();
      return refused("ALREADY_EXECUTED");
    } catch (e) {
      if (!(e instanceof OrderNotFoundError)) return refused("ALREADY_EXECUTED"); // can't prove it was never sent
    }
    // 5. Persist first, then place exactly the approved order.
    this.st.executed.push(h);
    this.save();
    this.pending.push({ orderHash: h, req, approvalAt });
    this.savePending();
    const spec = await this.spec(req.instId);
    try {
      await this.o.exchange.placeOrder({ instId: req.instId, side: "buy", ordType: "ioc", px: req.px, sz: req.sz, clOrdId });
    } catch (e) {
      // Before treating it as unsent, look it up (never send twice).
      try {
        await this.o.exchange.getOrder(req.instId, clOrdId);
      } catch (e2) {
        if (e2 instanceof OrderNotFoundError) {
          this.push("ALERT", { code: "ORDER_FAILED", details: `${clOrdId}: ${e instanceof Error ? e.message : String(e)}` });
          const ev = this.push("NOT_FILLED", { orderHash: h, clOrdId });
          return { result: "NOT_FILLED", refusal: null, event: ev };
        }
      }
    }
    // 6. Poll to a terminal state.
    const final = await this.pollTerminal(req.instId, clOrdId);
    if (!final) {
      const ev = this.push("UNKNOWN", { orderHash: h, clOrdId });
      this.pollInBackground(req.instId, clOrdId, (o) => this.onEntryFinal(req, h, o, approvalAt, spec));
      return { result: "UNKNOWN", refusal: null, event: ev };
    }
    // 7–8.
    const ev = this.onEntryFinal(req, h, final, approvalAt, spec);
    return { result: ev.type === "FILL" ? "FILLED" : "NOT_FILLED", refusal: null, event: ev };
  }

  private onEntryFinal(req: OrderRequest, h: Hex32, o: OrderState, approvalAt: number, spec: InstrumentSpec | null): ExecutorEvent {
    const clOrdId = entryClOrdId(h);
    this.pending = this.pending.filter((p) => p.orderHash !== h);
    this.savePending();
    if (!decGt(o.accFillSz, "0")) return this.push("NOT_FILLED", { orderHash: h, clOrdId });
    const base = this.baseCcy(req.instId, spec);
    const feeAbs = decAbs(o.fee);
    const net = o.feeCcy === base ? decSub(o.accFillSz, feeAbs) : o.accFillSz;
    const lot = spec?.lotSz ?? FALLBACK_LOT;
    const dust = spec ? decLt(floorToLot(net, lot), spec.minSz) : !decGt(floorToLot(net, lot), "0");
    if (decGt(net, "0")) this.st.inventory[req.instId] = decAdd(this.st.inventory[req.instId] ?? "0", net);
    const avgPx = o.avgPx ?? req.px;
    if (!dust) {
      const quoteFee = o.feeCcy === base ? "0" : feeAbs;
      this.st.positions.push({
        entryOrderHash: h,
        clOrdId,
        instId: req.instId,
        sz: net,
        entryPx: avgPx,
        costQuote: decAdd(decMul(avgPx, o.accFillSz), quoteFee),
        openedAt: o.cTime,
        stopPx: req.stopPx,
        tpPx: isZero(req.tpPx) ? null : req.tpPx,
        timeStopAt: approvalAt * 1000 + req.timeStopMin * 60_000,
        exiting: null,
      });
    }
    return this.push("FILL", {
      orderHash: h, clOrdId, ordId: o.ordId, state: o.state, accFillSz: o.accFillSz, avgPx: o.avgPx, fee: o.fee, feeCcy: o.feeCcy, cTime: o.cTime, dust,
    });
  }

  /** §14.3 Exit: sell own inventory immediately; allowed while halted or paused; one in-flight exit per position. */
  async exit(entryOrderHash: Hex32, reason: ExitReason): Promise<ExecResult> {
    const key = entryOrderHash.toLowerCase();
    const pos = this.position(key);
    if (!pos) return refused("EXCEEDS_INVENTORY");
    if (pos.exiting !== null || this.exitLocks.has(key)) return refused("EXIT_IN_PROGRESS");
    this.exitLocks.add(key);
    try {
      return await this.exitLocked(pos, reason);
    } finally {
      this.exitLocks.delete(key);
    }
  }

  private async exitLocked(pos: Position, reason: ExitReason): Promise<ExecResult> {
    const spec = await this.spec(pos.instId);
    const lot = spec?.lotSz ?? FALLBACK_LOT;
    let avail: string | null = null;
    try {
      avail = (await this.o.exchange.getAccount(pos.instId)).baseAvail;
    } catch {
      avail = null; // exits never wait: fall back to our own books
    }
    const inv = this.st.inventory[pos.instId] ?? "0";
    const reservedSz = floorToLot(decMin(pos.sz, inv, ...(avail === null ? [] : [avail])), lot);
    if (!decGt(reservedSz, "0")) return refused("EXCEEDS_INVENTORY");
    const clOrdId = exitClOrdId(pos.entryOrderHash, this.randomHex32());
    pos.exiting = { clOrdId, reason, reservedSz, since: this.o.clock.now() };
    this.save();
    try {
      await this.o.exchange.placeOrder({ instId: pos.instId, side: "sell", ordType: "market", px: null, sz: reservedSz, clOrdId });
    } catch (e) {
      try {
        await this.o.exchange.getOrder(pos.instId, clOrdId);
      } catch (e2) {
        if (e2 instanceof OrderNotFoundError) {
          pos.exiting = null;
          this.save();
          this.push("ALERT", { code: "ORDER_FAILED", details: `${clOrdId}: ${e instanceof Error ? e.message : String(e)}` });
          const ev = this.push("NOT_FILLED", { orderHash: pos.entryOrderHash, clOrdId });
          return { result: "NOT_FILLED", refusal: null, event: ev };
        }
      }
    }
    const final = await this.pollTerminal(pos.instId, clOrdId);
    if (!final) {
      const ev = this.push("UNKNOWN", { orderHash: pos.entryOrderHash, clOrdId });
      this.pollExitInBackground(pos.entryOrderHash, pos.instId, clOrdId, spec);
      return { result: "UNKNOWN", refusal: null, event: ev };
    }
    const ev = this.onExitFinal(pos.entryOrderHash, final, spec);
    return { result: ev.type === "EXIT" ? "FILLED" : "NOT_FILLED", refusal: null, event: ev };
  }

  private onExitFinal(entryOrderHash: Hex32, o: OrderState, spec: InstrumentSpec | null): ExecutorEvent {
    const pos = this.position(entryOrderHash);
    const clOrdId = o.clOrdId;
    if (!pos) return this.push("ALERT", { code: "EXIT_WITHOUT_POSITION", details: clOrdId });
    if (!decGt(o.accFillSz, "0")) {
      pos.exiting = null;
      this.save();
      return this.push("NOT_FILLED", { orderHash: entryOrderHash, clOrdId });
    }
    const reason: ExitReason = pos.exiting?.reason ?? "AGENT_CLOSE";
    const sold = o.accFillSz;
    const avgPx = o.avgPx ?? "0";
    const base = this.baseCcy(pos.instId, spec);
    const feeAbs = decAbs(o.fee);
    const gross = decMul(avgPx, sold);
    const proceeds = o.feeCcy === base ? decMul(avgPx, decSub(sold, feeAbs)) : decSub(gross, feeAbs);
    const share = decLt(sold, pos.sz) ? decDiv(sold, pos.sz) : "1";
    const cost = toDecString(D(pos.costQuote).mul(D(share)).toDecimalPlaces(8));
    const pnl = toDecString(D(proceeds).sub(D(cost)).toDecimalPlaces(8));
    this.st.inventory[pos.instId] = decGt(this.st.inventory[pos.instId] ?? "0", sold) ? decSub(this.st.inventory[pos.instId] ?? "0", sold) : "0";
    const remaining = decSub(pos.sz, decMin(sold, pos.sz));
    const lot = spec?.lotSz ?? FALLBACK_LOT;
    const minSz = spec?.minSz ?? FALLBACK_LOT;
    if (decLt(floorToLot(remaining, lot), minSz)) {
      this.st.positions = this.st.positions.filter((p) => p.entryOrderHash !== entryOrderHash);
    } else {
      pos.sz = remaining;
      pos.costQuote = toDecString(D(pos.costQuote).sub(D(cost)));
      pos.exiting = null;
    }
    return this.push("EXIT", {
      entryOrderHash, exitClOrdId: clOrdId, exitPrefix: clOrdId.slice(1), reason, soldSz: sold,
      avgPx: decGt(avgPx, "0") ? avgPx : "0.00000001", proceedsQuote: proceeds, pnlQuote: pnl, cTime: o.cTime,
    });
  }

  /** §14.3 Adjust: tighten only. */
  async adjust(entryOrderHash: Hex32, newStopPx?: PDec, newTpPx?: PDec): Promise<ExecResult> {
    const pos = this.position(entryOrderHash.toLowerCase());
    if (!pos || pos.exiting !== null || (newStopPx === undefined && newTpPx === undefined)) return refused("ADJUST_INVALID");
    let bid: string;
    try {
      bid = (await this.o.market.getSnapshot(pos.instId)).bid;
    } catch {
      return refused("ADJUST_INVALID");
    }
    if (newStopPx !== undefined && !(decGte(newStopPx, pos.stopPx) && decLt(newStopPx, bid))) return refused("ADJUST_INVALID");
    if (newTpPx !== undefined && !decGt(newTpPx, bid)) return refused("ADJUST_INVALID");
    const from = { stopPx: pos.stopPx, tpPx: pos.tpPx };
    if (newStopPx !== undefined) pos.stopPx = newStopPx;
    if (newTpPx !== undefined) pos.tpPx = newTpPx;
    const ev = this.push("ADJUST", { entryOrderHash: pos.entryOrderHash, from, to: { stopPx: pos.stopPx, tpPx: pos.tpPx } });
    return { result: "OK", refusal: null, event: ev };
  }

  /** §14.6 Cancel open orders matching our clOrdId pattern (3 retries each). */
  async cancelAll(by: "kill" | "api" | "pause-watch"): Promise<string[]> {
    const known = new Set<string>([...(this.o.instIds ?? []), ...this.st.positions.map((p) => p.instId), ...Object.keys(this.st.inventory)]);
    const cancelled: string[] = [];
    const failed: string[] = [];
    const sweep = async (instIds: Iterable<string>): Promise<void> => {
      for (const instId of instIds) {
        let open: OrderState[] = [];
        try {
          open = await this.o.exchange.listOpenOrders(instId);
        } catch (e) {
          failed.push(`${instId}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        for (const ord of open.filter((x) => CLORDID_RE.test(x.clOrdId))) {
          let ok = false;
          for (let i = 0; i < CANCEL_RETRIES && !ok; i++) {
            try {
              await this.o.exchange.cancelOrder(instId, ord.clOrdId);
              ok = true;
            } catch {
              // retry
            }
          }
          if (ok) cancelled.push(ord.clOrdId);
          else failed.push(ord.clOrdId);
        }
      }
    };
    // Cancel what we know first; the chain read (policy instruments) never delays it.
    await sweep(known);
    try {
      const extra = (await this.o.chain.readView()).policy.instIds.filter((id) => !known.has(id));
      await sweep(extra);
    } catch {
      // the known instruments are already done
    }
    this.push("CANCEL", { clOrdIds: cancelled, by });
    if (failed.length) this.push("ALERT", { code: "CANCEL_FAILED", details: failed.join(", ") });
    return cancelled;
  }

  // ------------------------------------------------------------ loops (§14.4, §14.5)
  /** One monitor pass: stop / TP / time stop for every position without an exit in flight. Never sells blind. */
  async monitorTick(): Promise<void> {
    const now = this.o.clock.now();
    for (const pos of [...this.st.positions]) {
      if (pos.exiting !== null || this.exitLocks.has(pos.entryOrderHash)) continue;
      let bid: string;
      try {
        bid = (await this.o.market.getSnapshot(pos.instId)).bid;
        this.tickerFails.set(pos.instId, 0);
      } catch (e) {
        const n = (this.tickerFails.get(pos.instId) ?? 0) + 1;
        this.tickerFails.set(pos.instId, n);
        if (n === TICKER_FAIL_ALERT) this.push("ALERT", { code: "MARKET_DATA_UNAVAILABLE", details: `Piyasa verisi alınamıyor: ${pos.instId} (${e instanceof Error ? e.message : String(e)})` });
        continue;
      }
      let reason: ExitReason | null = null;
      if (decLte(bid, pos.stopPx)) reason = "STOP_HIT";
      else if (pos.tpPx !== null && decGte(bid, pos.tpPx)) reason = "TP_HIT";
      else if (now >= pos.timeStopAt) reason = "TIME_STOP";
      if (reason) await this.exit(pos.entryOrderHash, reason);
    }
  }

  /** One pause-watch pass: on false → true, cancel-all, halt, CANCEL + PAUSE_SEEN. Independent of core. */
  async pauseWatchTick(): Promise<void> {
    let paused: boolean;
    let blockTimestamp: number;
    try {
      const v = await this.o.chain.readView();
      paused = v.paused;
      blockTimestamp = v.blockTimestamp;
    } catch {
      return;
    }
    if (paused && !this.st.lastSeenPaused) {
      this.st.lastSeenPaused = true;
      this.st.halted = true;
      this.save();
      await this.cancelAll("pause-watch");
      this.push("PAUSE_SEEN", { blockTimestamp });
    } else if (paused !== this.st.lastSeenPaused) {
      this.st.lastSeenPaused = paused;
      this.save();
    }
  }

  /** Start the monitor and pause watcher on the clock. Returns a stop function. */
  start(opts: { monitorIntervalMs: number; chainWatchIntervalMs: number }): () => void {
    this.stopped = false;
    let monitorBusy = false;
    let watchBusy = false;
    const stopMonitor = this.o.clock.every(opts.monitorIntervalMs, async () => {
      if (monitorBusy) return;
      monitorBusy = true;
      try {
        await this.monitorTick();
      } catch (e) {
        this.push("ALERT", { code: "MONITOR_ERROR", details: e instanceof Error ? e.message : String(e) });
      } finally {
        monitorBusy = false;
      }
    });
    const stopWatch = this.o.clock.every(opts.chainWatchIntervalMs, async () => {
      if (watchBusy) return;
      watchBusy = true;
      try {
        await this.pauseWatchTick();
      } finally {
        watchBusy = false;
      }
    });
    return () => {
      this.stopped = true;
      stopMonitor();
      stopWatch();
    };
  }

  // ------------------------------------------------------------ polling
  private async pollTerminal(instId: string, clOrdId: string): Promise<OrderState | null> {
    const pollMs = this.o.pollMs ?? POLL_MS;
    const deadline = this.o.clock.now() + (this.o.pollTimeoutMs ?? POLL_TIMEOUT_MS);
    for (;;) {
      try {
        const o = await this.o.exchange.getOrder(instId, clOrdId);
        if (TERMINAL_STATES.has(o.state)) return o;
      } catch {
        // keep polling until the deadline
      }
      if (this.o.clock.now() >= deadline) return null;
      await this.o.clock.sleep(pollMs);
    }
  }

  private pollExitInBackground(entryOrderHash: Hex32, instId: string, clOrdId: string, spec: InstrumentSpec | null): void {
    this.pollInBackground(instId, clOrdId, (o) => this.onExitFinal(entryOrderHash, o, spec), {
      maxTries: EXIT_POLL_MAX_TRIES,
      onGiveUp: () => {
        const pos = this.position(entryOrderHash);
        if (pos?.exiting?.clOrdId === clOrdId) {
          pos.exiting = null;
          this.save();
        }
        this.push("ALERT", { code: "EXIT_STATE_UNKNOWN", details: `${clOrdId}: durum bilinmiyor; çıkış yeniden denenebilir` });
      },
    });
  }

  private pollInBackground(
    instId: string,
    clOrdId: string,
    onFinal: (o: OrderState) => void,
    limit: { maxTries: number; onGiveUp: () => void } | null = null,
  ): void {
    if (this.background.has(clOrdId)) return;
    let tries = 0;
    const stop = this.o.clock.every(this.o.backgroundPollMs ?? BACKGROUND_POLL_MS, async () => {
      if (this.stopped) {
        stop();
        return;
      }
      tries++;
      try {
        const o = await this.o.exchange.getOrder(instId, clOrdId);
        if (TERMINAL_STATES.has(o.state) && this.background.has(clOrdId)) {
          this.background.delete(clOrdId);
          stop();
          onFinal(o);
        }
      } catch {
        // keep polling
      }
      if (limit && this.background.has(clOrdId) && tries >= limit.maxTries) {
        this.background.delete(clOrdId);
        stop();
        limit.onGiveUp();
      }
    });
    this.background.add(clOrdId);
  }

  /** Stop background work (tests, shutdown). */
  stop(): void {
    this.stopped = true;
  }
}
