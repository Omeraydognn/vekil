// pnpm verify [--prove <seq>] — V1–V6 over $DATA_DIR/ledger.jsonl against the contract, and the on-chain proof (SPEC §16.3).
import { join } from "node:path";
import { openPolicyChain, scriptArgs } from "../src/chain/deployment.js";
import { FileLedger } from "../src/ledger/ledger.js";
import { verifyLedger } from "../src/ledger/verify.js";
import { loadConfig } from "../src/shared/config.js";
import { SystemClock } from "../src/shared/time.js";

async function main(): Promise<void> {
  const args = scriptArgs();
  const p = args.indexOf("--prove");
  const proveSeq = p >= 0 ? Number(args[p + 1]) : undefined;
  if (proveSeq !== undefined && !(Number.isSafeInteger(proveSeq) && proveSeq >= 1)) throw new Error("--prove needs a seq ≥ 1");
  const cfg = loadConfig({ env: { LLM_PROVIDER: "scripted", ...process.env } });
  const { chain } = openPolicyChain(cfg);
  const ledger = new FileLedger(join(cfg.dataDir, "ledger.jsonl"), new SystemClock());
  const r = await verifyLedger({ entries: ledger.readAll(), chain, ...(proveSeq !== undefined ? { proveSeq } : {}) });
  console.log(`ledger ${cfg.dataDir}/ledger.jsonl (${ledger.head().seq} entries), contract ${chain.address}`);
  for (const c of r.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.id} ${c.tr}${c.details ? ` (${c.details})` : ""}`);
  for (const f of r.failures) console.log(`  ! ${f.check} #${f.seq ?? "-"}: ${f.message}`);
  if (r.proof) {
    console.log(`proof #${r.proof.seq}: anchor ${r.proof.anchorIndex}, root ${r.proof.root}, ${r.proof.proof.length} siblings → ` +
      (r.proof.onChainVerified ? "Kanıt zincirde doğrulandı ✓" : "✗ verifyEntry false"));
  }
  process.exit(r.ok && (proveSeq === undefined || r.proof?.onChainVerified) ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
