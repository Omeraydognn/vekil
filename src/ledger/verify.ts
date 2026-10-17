// Verification of the ledger against the chain (SPEC §16.3): V1–V6, the on-chain inclusion proof and
// the tamper demo. Pure over a ledger snapshot plus chain reads; it never writes.
import { ZERO_HASH } from "../shared/hash.js";
import type { ChainAnchor, PolicyChain } from "../shared/interfaces.js";
import { merkleProof, merkleRoot } from "../shared/merkle.js";
import { entryClOrdId } from "../shared/order-hash.js";
import type { Hex32, LedgerEntry, ProofReport, VerifyReport } from "../shared/schemas.js";
import { entryHash } from "./ledger.js";

type Check = VerifyReport["checks"][number];
type Failure = VerifyReport["failures"][number];

export const NOT_ANCHORED_TR = "henüz zincire yazılmadı";

export interface VerifyOpts {
  entries: LedgerEntry[];
  chain: PolicyChain;
  /** Verify an in-memory copy with one payload field of this seq changed. */
  tamperSeq?: number;
  /** Build the Merkle proof for this seq and check it with the on-chain verifyEntry. */
  proveSeq?: number;
}

/** Change one payload field of the entry (in place on a copy) so its hash no longer recomputes. */
export function tamperEntry(e: LedgerEntry): void {
  const keys = Object.keys(e.payload).sort();
  for (const k of keys) {
    const v = e.payload[k];
    if (typeof v === "string") {
      e.payload = { ...e.payload, [k]: v + "!" };
      return;
    }
    if (typeof v === "number") {
      e.payload = { ...e.payload, [k]: v + 1 };
      return;
    }
    if (typeof v === "boolean") {
      e.payload = { ...e.payload, [k]: !v };
      return;
    }
  }
  e.payload = { ...e.payload, tampered: true };
}

function recompute(e: LedgerEntry): Hex32 {
  const { hash: _hash, ...rest } = e;
  return entryHash(rest);
}

function payload<T>(e: LedgerEntry): T {
  return e.payload as T;
}

export async function verifyLedger(opts: VerifyOpts): Promise<VerifyReport> {
  const entries = structuredClone(opts.entries);
  if (opts.tamperSeq !== undefined) {
    const t = entries.find((e) => e.seq === opts.tamperSeq);
    if (t) tamperEntry(t);
  }
  const { chain } = opts;
  const checks: Check[] = [];
  const failures: Failure[] = [];
  const recomputed = entries.map(recompute);

  // V1 integrity: every hash recomputes, prevHash links, seq is contiguous.
  let prev: Hex32 = ZERO_HASH;
  let v1Fail: number | null = null;
  entries.forEach((e, i) => {
    if (v1Fail === null && (e.seq !== i + 1 || e.prevHash !== prev || recomputed[i] !== e.hash)) v1Fail = e.seq;
    prev = e.hash;
  });
  if (v1Fail !== null) failures.push({ seq: v1Fail, check: "V1", message: `Kayıt zinciri bozuk: #${v1Fail}` });
  checks.push({
    id: "V1",
    ok: v1Fail === null,
    tr: v1Fail === null ? "Kayıt zinciri sağlam" : `Kayıt zinciri bozuk: #${v1Fail}`,
    details: `${entries.length} kayıt`,
  });

  // V2 anchors: every on-chain root equals the recomputed root of its range; ranges contiguous from 1.
  let anchors: ChainAnchor[] = [];
  let v2ok = true;
  let v2Details = "";
  try {
    anchors = await chain.readAnchors();
    let next = 1;
    for (const a of anchors) {
      const idx = entries.findIndex((e) => e.seq === a.fromSeq);
      const count = a.toSeq - a.fromSeq + 1;
      const hashes = idx >= 0 ? recomputed.slice(idx, idx + count) : [];
      let problem: string | null = null;
      if (a.fromSeq !== next) problem = `çapa #${a.index} aralığı ${next}'den başlamıyor`;
      else if (hashes.length !== count) problem = `çapa #${a.index} kayıtları eksik (${a.fromSeq}–${a.toSeq})`;
      else if (merkleRoot(hashes) !== a.root) problem = `çapa #${a.index} kökü eşleşmiyor`;
      if (problem) {
        v2ok = false;
        const bad = hashes.findIndex((h, j) => h !== entries[idx + j]?.hash);
        failures.push({ seq: bad >= 0 ? a.fromSeq + bad : a.fromSeq, check: "V2", message: problem });
      }
      next = a.toSeq + 1;
    }
    v2Details = `${anchors.length} çapa, son #${anchors.at(-1)?.toSeq ?? 0}`;
  } catch (e) {
    v2ok = false;
    v2Details = `zincir okunamadı: ${String(e)}`;
    failures.push({ seq: null, check: "V2", message: v2Details });
  }
  checks.push({ id: "V2", ok: v2ok, tr: "Merkle kökleri zincirle eşleşiyor", details: v2Details });

  // V3 approval before execution, V4 rejections on record.
  const approvedSeq = new Map<string, number>();
  const fillTimes = new Map<string, number>();
  for (const e of entries) {
    if (e.kind === "FILL") {
      const p = payload<{ orderHash: string; cTime: number }>(e);
      fillTimes.set(p.orderHash, p.cTime);
    }
  }
  let v3ok = true;
  let v4ok = true;
  let executes = 0;
  let rejections = 0;
  for (const e of entries) {
    if (e.kind === "CHAIN_REQUEST") {
      const p = payload<{ orderHash: Hex32; status: string; reasonsMask: number }>(e);
      if (p.status === "APPROVED") approvedSeq.set(p.orderHash, e.seq);
      if (p.status === "REJECTED") {
        rejections += 1;
        try {
          const a = await chain.approval(p.orderHash);
          if (a.status !== 2 || a.reasons !== p.reasonsMask) {
            v4ok = false;
            failures.push({ seq: e.seq, check: "V4", message: `ret zincirde yok veya farklı (durum ${a.status}, maske ${a.reasons})` });
          }
        } catch (err) {
          v4ok = false;
          failures.push({ seq: e.seq, check: "V4", message: `zincir okunamadı: ${String(err)}` });
        }
      }
    }
    if (e.kind === "EXECUTE") {
      const p = payload<{ orderHash: Hex32; clOrdId: string; result: string }>(e);
      if (p.result === "REFUSED") continue;
      executes += 1;
      const problems: string[] = [];
      const reqSeq = approvedSeq.get(p.orderHash);
      if (reqSeq === undefined || reqSeq >= e.seq) problems.push("önceden onay kaydı yok");
      if (p.clOrdId !== entryClOrdId(p.orderHash)) problems.push("clOrdId özetten türetilmemiş");
      try {
        const a = await chain.approval(p.orderHash);
        if (a.status !== 1) problems.push(`zincirde onay yok (durum ${a.status})`);
        const cTime = fillTimes.get(p.orderHash);
        if (a.status === 1 && cTime !== undefined && a.at > Math.ceil(cTime / 1000)) problems.push("onay emirden sonra");
      } catch (err) {
        problems.push(`zincir okunamadı: ${String(err)}`);
      }
      if (problems.length) {
        v3ok = false;
        failures.push({ seq: e.seq, check: "V3", message: `Onaysız emir bulundu: ${problems.join(", ")}` });
      }
    }
  }
  checks.push({ id: "V3", ok: v3ok, tr: "Her emirden önce zincir onayı var", details: `${executes} emir` });
  checks.push({ id: "V4", ok: v4ok, tr: "Reddedilenler zincirde kayıtlı", details: `${rejections} ret` });

  // V5 exits: recorded on-chain; an exit with no EXIT_RECORDED yet is pending (a warning, not a failure).
  const recorded = new Set(entries.filter((e) => e.kind === "EXIT_RECORDED").map((e) => payload<{ entryOrderHash: string }>(e).entryOrderHash));
  let v5ok = true;
  let pending = 0;
  let exits = 0;
  for (const e of entries.filter((x) => x.kind === "EXIT")) {
    exits += 1;
    const p = payload<{ entryOrderHash: Hex32; exitPrefix: string }>(e);
    try {
      const at = await chain.exitRecordedAt(p.entryOrderHash);
      const entry = await chain.entryByExitPrefix(p.exitPrefix);
      if (at > 0 && entry === p.entryOrderHash) continue;
      if (!recorded.has(p.entryOrderHash)) {
        pending += 1;
        continue;
      }
      v5ok = false;
      failures.push({ seq: e.seq, check: "V5", message: "çıkış zincirde kayıtlı değil" });
    } catch (err) {
      v5ok = false;
      failures.push({ seq: e.seq, check: "V5", message: `zincir okunamadı: ${String(err)}` });
    }
  }
  checks.push({
    id: "V5",
    ok: v5ok,
    tr: "Çıkışlar zincirde kayıtlı",
    details: pending ? `${exits} çıkış, ${pending} bekliyor` : `${exits} çıkış`,
  });

  // V6 policy: the latest POLICY entry equals the on-chain policyHash and sourceTextHash.
  let v6ok = true;
  let v6Details = "";
  try {
    const view = await chain.readView();
    const last = entries.findLast((e) => e.kind === "POLICY");
    if (last) {
      const p = payload<{ policyHash: string; sourceTextHash: string; version: number }>(last);
      v6ok = p.policyHash === view.policyHash && p.sourceTextHash === view.sourceTextHash;
      if (!v6ok) failures.push({ seq: last.seq, check: "V6", message: `kayıttaki kural v${p.version} zincirdeki v${view.policyVersion} ile aynı değil` });
    }
    v6Details = `v${view.policyVersion}`;
  } catch (err) {
    v6ok = false;
    v6Details = `zincir okunamadı: ${String(err)}`;
    failures.push({ seq: null, check: "V6", message: v6Details });
  }
  checks.push({ id: "V6", ok: v6ok, tr: "Kurallar zincirdekiyle aynı", details: v6Details });

  failures.sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER));
  const report: VerifyReport = { ok: checks.every((c) => c.ok), checks, failures };

  if (opts.proveSeq !== undefined) {
    const proof = await proveEntry(entries, anchors, chain, opts.proveSeq);
    if ("error" in proof) report.failures.push({ seq: opts.proveSeq, check: "PROOF", message: proof.error });
    else report.proof = proof;
  }
  return report;
}

/** Proof for one seq against the anchor that covers it (§16.3). */
export async function proveEntry(
  entries: LedgerEntry[],
  anchors: ChainAnchor[],
  chain: PolicyChain,
  seq: number,
): Promise<ProofReport | { error: string }> {
  const target = entries.find((e) => e.seq === seq);
  if (!target) return { error: `kayıt #${seq} yok` };
  const a = anchors.find((x) => seq >= x.fromSeq && seq <= x.toSeq);
  if (!a) return { error: NOT_ANCHORED_TR };
  const hashes = entries.filter((e) => e.seq >= a.fromSeq && e.seq <= a.toSeq).map((e) => e.hash);
  const proof = merkleProof(hashes, seq - a.fromSeq);
  const onChainVerified = await chain.verifyEntry(a.index, target.hash, proof);
  return { seq, entryHash: target.hash, anchorIndex: a.index, root: a.root, proof, onChainVerified };
}
