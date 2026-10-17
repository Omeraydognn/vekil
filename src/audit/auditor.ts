// The order auditor (SPEC §16.5): the detection layer. Every agent order in the last 24 h on the policy's instruments
// must map to the chain. Order source by mode: fake/paper → ExecutorApi.orders(); live/demo → core's read-only ATK
// order history, independent of the executor. Needs only a read key and the public chain.
import type { OrderHistorySource, PolicyChain } from "../shared/interfaces.js";
import { decEq, decLte } from "../shared/money.js";
import { ENTRY_CLORDID_RE, EXIT_CLORDID_RE, clOrdIdPrefix } from "../shared/order-hash.js";
import type { AuditReport, Hex32, OrderRequest, OrderState } from "../shared/schemas.js";

export const AUDIT_WINDOW_MS = 24 * 60 * 60_000;
export const EXIT_PENDING_MS = 2 * 60_000;

export interface AuditorDeps {
  source: OrderHistorySource;
  sourceKind: AuditReport["source"];
  chain: PolicyChain;
  /** The policy's instruments (on-chain view), plus anything else to sweep. */
  instIds: () => Promise<string[]>;
  now: () => number;
  /** Optional local cache of approved requests (orderHash → request), used when the log lookup fails. */
  approvedCache?: (orderHash: Hex32) => OrderRequest | null;
}

type Item = AuditReport["items"][number];

export async function runAudit(d: AuditorDeps): Promise<AuditReport> {
  const instIds = await d.instIds();
  const now = d.now();
  const orders = await d.source.listRecentOrders(instIds, now - AUDIT_WINDOW_MS);
  const seen = new Set<string>();
  const unique: OrderState[] = [];
  for (const o of orders) {
    const k = `${o.instId}/${o.ordId}/${o.clOrdId}`;
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(o);
    }
  }
  const items: Item[] = [];
  for (const o of unique.sort((a, b) => a.cTime - b.cTime)) items.push(await auditOrder(d, o, now));
  return {
    ok: items.every((i) => i.status !== "VIOLATION"),
    source: d.sourceKind,
    contract: d.chain.address,
    checkedOrders: unique.length,
    items,
  };
}

async function approvedRequest(d: AuditorDeps, h: Hex32): Promise<OrderRequest | null> {
  try {
    const r = await d.chain.approvedRequest(h);
    if (r) return r;
  } catch {
    // fall through to the cache
  }
  return d.approvedCache?.(h) ?? null;
}

async function auditOrder(d: AuditorDeps, o: OrderState, now: number): Promise<Item> {
  const id = o.clOrdId;
  // A1: entries.
  if (ENTRY_CLORDID_RE.test(id)) {
    const h = await d.chain.orderHashByPrefix(clOrdIdPrefix(id));
    if (!h) return { clOrdId: id, kind: "ENTRY", status: "VIOLATION", detail: "Onaysız emir bulundu: zincirde bu özet yok" };
    const a = await d.chain.approval(h);
    if (a.status !== 1) return { clOrdId: id, kind: "ENTRY", status: "VIOLATION", detail: `Onaysız emir bulundu: onay durumu ${a.status}` };
    const req = await approvedRequest(d, h);
    if (!req) return { clOrdId: id, kind: "ENTRY", status: "VIOLATION", detail: "Onaylı istek okunamadı" };
    const diffs: string[] = [];
    if (req.instId !== o.instId) diffs.push(`çift ${o.instId} ≠ ${req.instId}`);
    if (o.side !== "buy") diffs.push(`yön ${o.side}`);
    if (o.px === null || !decEq(o.px, req.px)) diffs.push(`fiyat ${o.px ?? "piyasa"} ≠ ${req.px}`);
    if (!decEq(o.sz, req.sz)) diffs.push(`miktar ${o.sz} ≠ ${req.sz}`);
    if (diffs.length) return { clOrdId: id, kind: "ENTRY", status: "VIOLATION", detail: `Onaylanandan farklı: ${diffs.join(", ")}` };
    return { clOrdId: id, kind: "ENTRY", status: "OK", detail: `zincirde onaylı (${h.slice(0, 10)}…)` };
  }
  // A2: exits.
  if (EXIT_CLORDID_RE.test(id)) {
    const entry = await d.chain.entryByExitPrefix(clOrdIdPrefix(id));
    if (!entry) {
      if (now - o.cTime < EXIT_PENDING_MS) return { clOrdId: id, kind: "EXIT", status: "PENDING", detail: "bekliyor: çıkış henüz zincirde kayıtlı değil" };
      return { clOrdId: id, kind: "EXIT", status: "VIOLATION", detail: "Çıkış zincirde kayıtlı değil" };
    }
    if (o.side !== "sell") return { clOrdId: id, kind: "EXIT", status: "VIOLATION", detail: "çıkış emri satış değil" };
    const req = await approvedRequest(d, entry);
    if (!req) return { clOrdId: id, kind: "EXIT", status: "VIOLATION", detail: "girişin onaylı isteği okunamadı" };
    if (!decLte(o.sz, req.sz)) return { clOrdId: id, kind: "EXIT", status: "VIOLATION", detail: `satış ${o.sz} > onaylı alış ${req.sz}` };
    return { clOrdId: id, kind: "EXIT", status: "OK", detail: `çıkış zincirde kayıtlı (giriş ${entry.slice(0, 10)}…)` };
  }
  // A3: everything else.
  return { clOrdId: id, kind: "MANUAL", status: "OK", detail: "manuel (ajan dışı)" };
}

/** fake/paper: the executor's own order log is the source. */
export function executorOrderSource(api: { orders(instIds: string[], sinceMs: number): Promise<OrderState[]> }): OrderHistorySource {
  return { listRecentOrders: (instIds, sinceMs) => api.orders(instIds, sinceMs) };
}
