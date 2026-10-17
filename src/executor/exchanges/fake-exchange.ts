// FakeExchange (SPEC §14.7): IOC buys fill fully at the ask if px ≥ ask; market sells fill at the bid.
// Buy fee in base, sell fee in quote, as negative strings like OKX. Full order history; injectRestingOrder for tests.
import type { Clock, Exchange, MarketData } from "../../shared/interfaces.js";
import { decAdd, decGte, decLt, decMul, decSub, round8Down } from "../../shared/money.js";
import type { AccountSnapshot, Ms, OrderState, PDec } from "../../shared/schemas.js";
import { OPEN_STATES, OrderNotFoundError, OrderRejectedError } from "./types.js";

export interface PaperBook {
  quote: string;
  base: Record<string, string>;
  orders: OrderState[];
  nextOrdId: number;
}

export class FakeExchange implements Exchange {
  protected book: PaperBook;

  constructor(
    protected readonly market: MarketData,
    protected readonly clock: Clock,
    protected readonly opts: { startQuote: string; feeRate: string; quoteCcy?: string; initial?: PaperBook },
  ) {
    this.book = opts.initial ? structuredClone(opts.initial) : { quote: opts.startQuote, base: {}, orders: [], nextOrdId: 1 };
  }

  /** Called after every mutation (PaperExchange persists). */
  protected changed(): void {}

  private baseCcy(instId: string): string {
    return instId.split("-")[0] ?? instId;
  }

  async getAccount(instId: string): Promise<AccountSnapshot> {
    return { quoteAvail: this.book.quote, baseAvail: this.book.base[this.baseCcy(instId)] ?? "0", fetchedAt: this.clock.now() };
  }

  async placeOrder(o: { instId: string; side: "buy" | "sell"; ordType: "ioc" | "market"; px: PDec | null; sz: PDec; clOrdId: string }): Promise<{ ordId: string; sentAt: Ms }> {
    if (this.book.orders.some((x) => x.clOrdId === o.clOrdId)) throw new OrderRejectedError("51016", "Duplicated clOrdId");
    const snap = await this.market.getSnapshot(o.instId);
    const now = this.clock.now();
    const ordId = String(this.book.nextOrdId++);
    const base = this.baseCcy(o.instId);
    const order: OrderState = {
      ordId, clOrdId: o.clOrdId, instId: o.instId, side: o.side, px: o.px, sz: o.sz, state: "canceled",
      accFillSz: "0", avgPx: null, fee: "0", feeCcy: o.side === "buy" ? base : (this.opts.quoteCcy ?? "TRY"), cTime: now,
    };
    if (o.side === "buy") {
      if (o.ordType !== "ioc" || o.px === null) throw new OrderRejectedError("51000", "fake exchange: buys are IOC limit only");
      if (decGte(o.px, snap.ask)) {
        const cost = decMul(snap.ask, o.sz);
        if (decLt(this.book.quote, cost)) throw new OrderRejectedError("51008", "Insufficient balance");
        const fee = round8Down(decMul(o.sz, this.opts.feeRate));
        this.book.quote = decSub(this.book.quote, cost);
        this.book.base[base] = decAdd(this.book.base[base] ?? "0", decSub(o.sz, fee));
        Object.assign(order, { state: "filled", accFillSz: o.sz, avgPx: snap.ask, fee: fee === "0" ? "0" : `-${fee}` });
      }
    } else {
      if (o.ordType !== "market") throw new OrderRejectedError("51000", "fake exchange: sells are market only");
      if (decLt(this.book.base[base] ?? "0", o.sz)) throw new OrderRejectedError("51008", "Insufficient balance");
      const gross = decMul(snap.bid, o.sz);
      const fee = round8Down(decMul(gross, this.opts.feeRate));
      this.book.base[base] = decSub(this.book.base[base] ?? "0", o.sz);
      this.book.quote = decAdd(this.book.quote, decSub(gross, fee));
      Object.assign(order, { state: "filled", accFillSz: o.sz, avgPx: snap.bid, fee: fee === "0" ? "0" : `-${fee}` });
    }
    this.book.orders.push(order);
    this.changed();
    return { ordId, sentAt: now };
  }

  async getOrder(instId: string, clOrdId: string): Promise<OrderState> {
    const o = this.book.orders.find((x) => x.instId === instId && x.clOrdId === clOrdId);
    if (!o) throw new OrderNotFoundError(`${instId} ${clOrdId}`);
    return structuredClone(o);
  }

  async listOpenOrders(instId: string): Promise<OrderState[]> {
    return structuredClone(this.book.orders.filter((o) => o.instId === instId && OPEN_STATES.has(o.state)));
  }

  async listRecentOrders(instId: string, sinceMs: Ms): Promise<OrderState[]> {
    return structuredClone(this.book.orders.filter((o) => o.instId === instId && o.cTime >= sinceMs));
  }

  async cancelOrder(instId: string, clOrdId: string): Promise<void> {
    const o = this.book.orders.find((x) => x.instId === instId && x.clOrdId === clOrdId);
    if (!o) throw new OrderNotFoundError(`${instId} ${clOrdId}`);
    if (OPEN_STATES.has(o.state)) {
      o.state = "canceled";
      this.changed();
    }
  }

  // ------------------------------------------------------------ test hooks
  /** A resting limit order that the executor never sent (an "injected" order, SPEC §23.3 step 10b). */
  injectRestingOrder(clOrdId: string, opts: { instId?: string; px?: string; sz?: string } = {}): OrderState {
    const order: OrderState = {
      ordId: String(this.book.nextOrdId++), clOrdId, instId: opts.instId ?? "AVAX-TRY", side: "buy", px: opts.px ?? "400", sz: opts.sz ?? "0.5",
      state: "live", accFillSz: "0", avgPx: null, fee: "0", feeCcy: this.baseCcy(opts.instId ?? "AVAX-TRY"), cTime: this.clock.now(),
    };
    this.book.orders.push(order);
    this.changed();
    return structuredClone(order);
  }

  /** Make the next getOrder for this clOrdId report a non-terminal state (UNKNOWN path in tests). */
  setOrderState(clOrdId: string, state: string): void {
    const o = this.book.orders.find((x) => x.clOrdId === clOrdId);
    if (o) {
      o.state = state;
      this.changed();
    }
  }

  balances(): { quote: string; base: Record<string, string> } {
    return { quote: this.book.quote, base: { ...this.book.base } };
  }
}

