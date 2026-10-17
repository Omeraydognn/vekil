// AtkExchange (SPEC §14.7): the live/demo executor's Exchange over the TRADE instance (market,spot) plus a separate
// read-only `account` instance for balances. Tool names and shapes: ATK_NOTES §2–3. Never used outside the executor,
// and never called against the live exchange in tests (they inject fake data sources).
import { OkxAckRow, OkxOrderRow, rows, AtkToolError } from "../../atk/parse.js";
import type { AtkDataSource } from "../../market/atk-market.js";
import type { Clock, Exchange } from "../../shared/interfaces.js";
import { z } from "zod";
import type { AccountSnapshot, Ms, OrderState, PDec } from "../../shared/schemas.js";
import { OrderNotFoundError, OrderRejectedError } from "./types.js";

const BalanceRow = z.looseObject({ details: z.array(z.looseObject({ ccy: z.string(), availBal: z.string() })) });
const DecStr = /^\d+(\.\d+)?$/;
// VERIFIED on OKX TR (ATK_NOTES §8): an unknown order is isError { code: "51603", message: "Order does not exist" }.
// Anything else is "unknown": entries fail closed and an unknown exit is never released.
const OKX_ORDER_NOT_FOUND = new Set(["51603"]);
const NOT_FOUND_MSG = /does not exist|not exist|not found/i;

function toOrderState(tool: string, r: z.infer<typeof OkxOrderRow>): OrderState {
  const cTime = Number(r.cTime);
  if (!Number.isSafeInteger(cTime)) throw new AtkToolError(tool, "BAD_DATA", "cTime");
  const px = r.px === "" || /^0(\.0+)?$/.test(r.px) ? null : r.px;
  const avgPx = r.avgPx === "" || /^0(\.0+)?$/.test(r.avgPx) ? null : r.avgPx;
  if (px !== null && !DecStr.test(px)) throw new AtkToolError(tool, "BAD_DATA", "px");
  if (avgPx !== null && !DecStr.test(avgPx)) throw new AtkToolError(tool, "BAD_DATA", "avgPx");
  const fee = r.fee === "" ? "0" : r.fee;
  if (!/^-?\d+(\.\d+)?$/.test(fee)) throw new AtkToolError(tool, "BAD_DATA", "fee");
  return { ordId: r.ordId, clOrdId: r.clOrdId, instId: r.instId, side: r.side, px, sz: r.sz, state: r.state, accFillSz: r.accFillSz, avgPx, fee, feeCcy: r.feeCcy, cTime };
}

export class AtkExchange implements Exchange {
  constructor(
    private readonly trade: AtkDataSource,
    private readonly account: AtkDataSource,
    private readonly clock: Clock,
  ) {}

  async getAccount(instId: string): Promise<AccountSnapshot> {
    const [base, quote] = instId.split("-");
    const tool = "account_get_balance";
    const row = rows(tool, await this.account.callData(tool, {}), BalanceRow)[0];
    const bal = (ccy: string | undefined): string => {
      const v = row?.details.find((d) => d.ccy === ccy)?.availBal ?? "0";
      if (!DecStr.test(v)) throw new AtkToolError(tool, "BAD_DATA", `availBal for ${ccy}`);
      return v;
    };
    return { quoteAvail: bal(quote), baseAvail: bal(base), fetchedAt: this.clock.now() };
  }

  async placeOrder(o: { instId: string; side: "buy" | "sell"; ordType: "ioc" | "market"; px: PDec | null; sz: PDec; clOrdId: string }): Promise<{ ordId: string; sentAt: Ms }> {
    const tool = "spot_place_order";
    const args: Record<string, unknown> = { instId: o.instId, tdMode: "cash", side: o.side, ordType: o.ordType, sz: o.sz, clOrdId: o.clOrdId };
    if (o.ordType === "ioc") {
      if (o.px === null) throw new OrderRejectedError("LOCAL", "ioc needs px");
      args.px = o.px;
    }
    if (o.side === "sell") args.tgtCcy = "base_ccy";
    const sentAt = this.clock.now();
    const ack = rows(tool, await this.trade.callData(tool, args), OkxAckRow)[0];
    // Per-order failures come back ok:true with sCode != "0" (ATK_NOTES §3).
    if (!ack || ack.sCode !== "0") throw new OrderRejectedError(ack?.sCode ?? "NO_ACK", ack?.sMsg ?? "no acknowledgement");
    return { ordId: ack.ordId ?? "", sentAt };
  }

  async getOrder(instId: string, clOrdId: string): Promise<OrderState> {
    const tool = "spot_get_order";
    let data: unknown;
    try {
      data = await this.trade.callData(tool, { instId, clOrdId });
    } catch (e) {
      if (e instanceof AtkToolError && ((e.code !== null && OKX_ORDER_NOT_FOUND.has(e.code)) || NOT_FOUND_MSG.test(e.message))) {
        throw new OrderNotFoundError(`${instId} ${clOrdId}`);
      }
      throw e;
    }
    const r = rows(tool, data, OkxOrderRow)[0];
    if (!r) throw new OrderNotFoundError(`${instId} ${clOrdId}`);
    return toOrderState(tool, r);
  }

  async listOpenOrders(instId: string): Promise<OrderState[]> {
    const tool = "spot_get_orders";
    return rows(tool, await this.trade.callData(tool, { status: "open", instId }), OkxOrderRow).map((r) => toOrderState(tool, r));
  }

  async listRecentOrders(instId: string, sinceMs: Ms): Promise<OrderState[]> {
    const tool = "spot_get_orders";
    const data = await this.trade.callData(tool, { status: "history", instId, begin: String(sinceMs), limit: 100 });
    return rows(tool, data, OkxOrderRow).map((r) => toOrderState(tool, r)).filter((o) => o.cTime >= sinceMs);
  }

  /** Retries 3 times (SPEC §14.7). */
  async cancelOrder(instId: string, clOrdId: string): Promise<void> {
    const tool = "spot_cancel_order";
    let last: unknown = null;
    for (let i = 0; i < 3; i++) {
      try {
        const ack = rows(tool, await this.trade.callData(tool, { instId, clOrdId }), OkxAckRow)[0];
        if (ack && ack.sCode === "0") return;
        last = new OrderRejectedError(ack?.sCode ?? "NO_ACK", ack?.sMsg ?? "cancel failed");
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
}

/** Order history from core's read-only instance for the live auditor (§16.5), independent of the executor. */
export class AtkOrderHistory {
  constructor(private readonly read: AtkDataSource) {}
  async listRecentOrders(instIds: string[], sinceMs: Ms): Promise<OrderState[]> {
    const tool = "spot_get_orders";
    const out: OrderState[] = [];
    for (const instId of instIds) {
      for (const status of ["open", "history"] as const) {
        const args: Record<string, unknown> = { status, instId, limit: 100 };
        if (status === "history") args.begin = String(sinceMs);
        out.push(...rows(tool, await this.read.callData(tool, args), OkxOrderRow).map((r) => toOrderState(tool, r)).filter((o) => o.cTime >= sinceMs));
      }
    }
    return out;
  }
}
