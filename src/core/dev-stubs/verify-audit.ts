// DEV STUB (deleted at M2; Track C owns verify.ts, Track B owns auditor.ts): compact V1–V6, proof and A1–A3.
import type { Auditor, Verifier } from "../deps.js";
import type { ExecutorApi, PolicyChain } from "../../shared/interfaces.js";
import { ZERO_HASH } from "../../shared/hash.js";
import { merkleProof, merkleRoot } from "../../shared/merkle.js";
import { D } from "../../shared/money.js";
import { ENTRY_CLORDID_RE, EXIT_CLORDID_RE, clOrdIdPrefix, entryClOrdId } from "../../shared/order-hash.js";
import { policyHash, sourceTextHash } from "../../shared/policy-encode.js";
import type { AuditReport, Hex32, LedgerEntry, VerifyReport } from "../../shared/schemas.js";
import { entryHash } from "./ledger.js";

type Check = VerifyReport["checks"][number];

export const verifyStub: Verifier = async ({ entries: input, chain, tamperSeq, proveSeq }) => {
  const entries = structuredClone(input);
  if (tamperSeq !== undefined) {
    const e = entries.find((x) => x.seq === tamperSeq);
    if (e) e.payload = { ...e.payload, __tampered: true };
  }
  const failures: VerifyReport["failures"] = [];
  const checks: Check[] = [];

  // V1
  let prev: string = ZERO_HASH;
  let v1Fail: number | null = null;
  entries.forEach((e, i) => {
    const { hash, ...rest } = e;
    if (v1Fail === null && (e.seq !== i + 1 || e.prevHash !== prev || entryHash(rest) !== hash)) v1Fail = e.seq;
    prev = hash;
  });
  if (v1Fail !== null) failures.push({ seq: v1Fail, check: "V1", message: `Kayıt zinciri bozuk: #${v1Fail}` });
  checks.push({ id: "V1", ok: v1Fail === null, tr: v1Fail === null ? "Kayıt zinciri sağlam" : `Kayıt zinciri bozuk: #${v1Fail}`, details: `${entries.length} kayıt` });

  // V2
  const anchors = await chain.readAnchors();
  let next = 1;
  let v2ok = true;
  for (const a of anchors) {
    const slice = entries.filter((e) => e.seq >= a.fromSeq && e.seq <= a.toSeq).map((e) => e.hash);
    if (a.fromSeq !== next || slice.length !== a.toSeq - a.fromSeq + 1 || merkleRoot(slice) !== a.root) {
      v2ok = false;
      failures.push({ seq: a.fromSeq, check: "V2", message: `çapa #${a.index} eşleşmiyor` });
    }
    next = a.toSeq + 1;
  }
  checks.push({ id: "V2", ok: v2ok, tr: "Merkle kökleri zincirle eşleşiyor", details: `${anchors.length} çapa` });

  // V3, V4
  const approved = new Map<string, LedgerEntry>();
  let v3ok = true;
  let v4ok = true;
  for (const e of entries) {
    const p = e.payload as Record<string, unknown>;
    if (e.kind === "CHAIN_REQUEST") {
      const h = p.orderHash as Hex32;
      const a = await chain.approval(h);
      if (p.status === "APPROVED") {
        approved.set(h, e);
        if (a.status !== 1) v3ok = false;
      }
      if (p.status === "REJECTED" && (a.status !== 2 || a.reasons !== p.reasonsMask)) {
        v4ok = false;
        failures.push({ seq: e.seq, check: "V4", message: "ret zincirde yok" });
      }
    }
    if (e.kind === "EXECUTE" && p.result !== "REFUSED") {
      const h = p.orderHash as string;
      if (!approved.has(h) || p.clOrdId !== entryClOrdId(h)) {
        v3ok = false;
        failures.push({ seq: e.seq, check: "V3", message: "onaysız emir" });
      }
    }
  }
  checks.push({ id: "V3", ok: v3ok, tr: "Her emirden önce zincir onayı var", details: `${approved.size} onay` });
  checks.push({ id: "V4", ok: v4ok, tr: "Reddedilenler zincirde kayıtlı", details: "" });

  // V5
  let v5ok = true;
  for (const e of entries.filter((x) => x.kind === "EXIT")) {
    const p = e.payload as { entryOrderHash: Hex32; exitPrefix: string };
    if ((await chain.exitRecordedAt(p.entryOrderHash)) === 0 || (await chain.entryByExitPrefix(p.exitPrefix)) !== p.entryOrderHash) v5ok = false;
  }
  checks.push({ id: "V5", ok: v5ok, tr: "Çıkışlar zincirde kayıtlı", details: "" });

  // V6
  const view = await chain.readView();
  const lastPolicy = [...entries].reverse().find((e) => e.kind === "POLICY");
  const lp = lastPolicy?.payload as { policyHash?: string; sourceTextHash?: string } | undefined;
  const v6ok = !lp || (lp.policyHash === view.policyHash && lp.sourceTextHash === view.sourceTextHash);
  checks.push({ id: "V6", ok: v6ok, tr: "Kurallar zincirdekiyle aynı", details: `v${view.policyVersion}` });
  void policyHash; void sourceTextHash;

  const report: VerifyReport = { ok: checks.every((c) => c.ok), checks, failures };
  if (proveSeq !== undefined) {
    const a = anchors.find((x) => proveSeq >= x.fromSeq && proveSeq <= x.toSeq);
    const target = entries.find((e) => e.seq === proveSeq);
    if (a && target) {
      const slice = entries.filter((e) => e.seq >= a.fromSeq && e.seq <= a.toSeq).map((e) => e.hash);
      const proof = merkleProof(slice, proveSeq - a.fromSeq);
      const ok = await chain.verifyEntry(a.index, target.hash as Hex32, proof);
      report.proof = { seq: proveSeq, entryHash: target.hash as Hex32, anchorIndex: a.index, root: a.root, proof, onChainVerified: ok };
    } else {
      report.failures.push({ seq: proveSeq, check: "PROOF", message: "henüz zincire yazılmadı" });
    }
  }
  return report;
};

export function auditStub(deps: { executor: ExecutorApi; chain: PolicyChain; instIds: () => string[]; now: () => number }): Auditor {
  return async (): Promise<AuditReport> => {
    const orders = await deps.executor.orders(deps.instIds(), deps.now() - 86_400_000);
    const items: AuditReport["items"] = [];
    for (const o of orders) {
      if (ENTRY_CLORDID_RE.test(o.clOrdId)) {
        const h = await deps.chain.orderHashByPrefix(clOrdIdPrefix(o.clOrdId));
        const req = h ? await deps.chain.approvedRequest(h) : null;
        const ok = !!req && req.instId === o.instId && o.side === "buy" && o.px !== null && D(req.px).eq(D(o.px)) && D(req.sz).eq(D(o.sz));
        items.push({ clOrdId: o.clOrdId, kind: "ENTRY", status: ok ? "OK" : "VIOLATION", detail: ok ? "Zincirde onaylı" : "Onaysız emir bulundu" });
      } else if (EXIT_CLORDID_RE.test(o.clOrdId)) {
        const h = await deps.chain.entryByExitPrefix(clOrdIdPrefix(o.clOrdId));
        const pending = !h && deps.now() - o.cTime < 120_000;
        const ok = !!h && o.side === "sell";
        items.push({ clOrdId: o.clOrdId, kind: "EXIT", status: ok ? "OK" : pending ? "PENDING" : "VIOLATION", detail: ok ? "Çıkış zincirde kayıtlı" : pending ? "bekliyor" : "Kayıtsız çıkış" });
      } else {
        items.push({ clOrdId: o.clOrdId, kind: "MANUAL", status: "OK", detail: "manuel (ajan dışı)" });
      }
    }
    return { ok: items.every((i) => i.status !== "VIOLATION"), source: "fake", contract: deps.chain.address, checkedOrders: orders.length, items };
  };
}
