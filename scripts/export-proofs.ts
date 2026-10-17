// pnpm export:proofs — writes site/proofs.json: the anchored ledger entries worth showing publicly (policy changes,
// chain approvals/rejections, executions, exits) with their Merkle proofs, so anyone can check them on-chain with
// VekilPolicy.verifyEntry from the public site. Reads $DATA_DIR/ledger.jsonl and the contract's anchors; sends nothing.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openPolicyChain } from "../src/chain/deployment.js";
import { FileLedger } from "../src/ledger/ledger.js";
import { loadConfig } from "../src/shared/config.js";
import { merkleProof, merkleRoot } from "../src/shared/merkle.js";
import { SystemClock } from "../src/shared/time.js";

const SHOW = new Set(["POLICY", "CHAIN_REQUEST", "EXECUTE", "EXIT", "EXIT_RECORDED", "KILL"]);

function summary(kind: string, p: Record<string, unknown>): string {
  const o = (p.order ?? {}) as Record<string, string>;
  switch (kind) {
    case "POLICY": return `Kurallar sürüm ${String(p.version)} zincire yazıldı`;
    case "CHAIN_REQUEST": return `${p.status === "APPROVED" ? "ONAYLANDI" : p.status === "REJECTED" ? "REDDEDİLDİ" : "İSTEK BAŞARISIZ"}: ${o.instId} ${o.sz} @ ${o.px}${Array.isArray(p.reasons) && p.reasons.length ? ` (${(p.reasons as string[]).join(", ")})` : ""}`;
    case "EXECUTE": return `Emir ${String(p.result)}: ${String(p.clOrdId)}`;
    case "EXIT": return `Çıkış (${String(p.reason)}): ${String(p.soldSz)} @ ${String(p.avgPx)}, K/Z ${String(p.pnlQuote)} TL`;
    case "EXIT_RECORDED": return "Çıkış zincirde kayıtlı";
    case "KILL": return "DURDUR (kill switch)";
    default: return kind;
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig({ env: { LLM_PROVIDER: "scripted", ...process.env } });
  const { chain } = openPolicyChain(cfg);
  const entries = new FileLedger(join(cfg.dataDir, "ledger.jsonl"), new SystemClock()).readAll();
  const anchors = await chain.readAnchors();
  const out: { seq: number; ts: number; kind: string; test: boolean; summary: string; txHash: string | null; entryHash: string; anchorIndex: number; root: string; proof: string[] }[] = [];
  for (const a of anchors) {
    const range = entries.filter((e) => e.seq >= a.fromSeq && e.seq <= a.toSeq);
    const hashes = range.map((e) => e.hash);
    if (hashes.length === 0 || merkleRoot(hashes) !== a.root) continue; // only ranges that match the chain
    range.forEach((e, i) => {
      if (!SHOW.has(e.kind)) return;
      const p = e.payload as Record<string, unknown>;
      out.push({
        seq: e.seq, ts: e.ts, kind: e.kind, test: e.test, summary: summary(e.kind, p),
        txHash: typeof p.txHash === "string" ? p.txHash : typeof p.pauseTx === "string" ? p.pauseTx : null,
        entryHash: e.hash, anchorIndex: a.index, root: a.root, proof: merkleProof(hashes, i),
      });
    });
  }
  writeFileSync("site/proofs.json", JSON.stringify({ contract: chain.address, chainId: chain.chainId, generatedAt: Date.now(), items: out }, null, 1) + "\n");
  console.log(`site/proofs.json: ${out.length} anchored entries from ${anchors.length} anchors (contract ${chain.address})`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
