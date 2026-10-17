// pnpm audit:orders — every agent order on the exchange must map to an on-chain approval (SPEC §16.5).
// Source by mode: fake → core's /api/audit (the executor is in-process); paper → the executor's order log;
// live/demo → core's read-only ATK order history (independent of the executor). Contract: $DATA_DIR/deployment.json.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AtkClient, stdioSpawner } from "../src/atk/client.js";
import { readAllowlist } from "../src/atk/manifest.js";
import { runAudit, executorOrderSource } from "../src/audit/auditor.js";
import { openPolicyChain, scriptArgs } from "../src/chain/deployment.js";
import { HttpExecutorClient } from "../src/executor/client.js";
import { AtkOrderHistory } from "../src/executor/exchanges/atk-exchange.js";
import { executorTokenPath } from "../src/executor/launch.js";
import { loadConfig } from "../src/shared/config.js";
import { AuditReportSchema, type AuditReport } from "../src/shared/schemas.js";

function print(r: AuditReport): void {
  console.log(`audit source=${r.source} contract=${r.contract} orders=${r.checkedOrders}`);
  for (const i of r.items) {
    const mark = i.status === "OK" ? (i.kind === "MANUAL" ? "·" : "✓") : i.status === "PENDING" ? "…" : "✗";
    console.log(`${mark} ${i.kind.padEnd(6)} ${i.clOrdId.padEnd(32)} ${i.status.padEnd(9)} ${i.detail}`);
  }
  console.log(r.ok ? "Tüm ajan emirleri onaylı" : "Onaysız emir bulundu");
}

async function main(): Promise<void> {
  scriptArgs();
  const cfg = loadConfig({ env: { LLM_PROVIDER: "scripted", ...process.env } });
  let report: AuditReport;
  if (cfg.mode === "fake") {
    const tokenPath = join(cfg.dataDir, "server-token");
    if (!existsSync(tokenPath)) throw new Error("fake mode audits through the running core (pnpm dev): server-token not found");
    const res = await fetch(`http://127.0.0.1:${cfg.port}/api/audit`, { headers: { "x-vekil-token": readFileSync(tokenPath, "utf8").trim() } });
    if (!res.ok) throw new Error(`core /api/audit: ${res.status}`);
    report = AuditReportSchema.parse(await res.json());
  } else {
    const { chain } = openPolicyChain(cfg);
    const instIds = async (): Promise<string[]> => [...new Set([...(await chain.readView()).policy.instIds, cfg.instId])];
    if (cfg.mode === "paper") {
      const token = readFileSync(executorTokenPath(cfg.dataDir), "utf8").trim();
      const exec = new HttpExecutorClient(`http://127.0.0.1:${cfg.executorPort}`, token);
      report = await runAudit({ source: executorOrderSource(exec), sourceKind: "paper", chain, instIds, now: () => Date.now() });
    } else {
      const allow = readAllowlist("config/atk-allowlist.json").core.filter((n) => n === "spot_get_orders");
      const atk = await AtkClient.start({ profile: cfg.atk.readProfile, modules: cfg.atk.readModules, readOnly: true, demo: cfg.mode === "demo", allow }, { spawner: stdioSpawner, mode: cfg.mode });
      try {
        report = await runAudit({ source: new AtkOrderHistory(atk), sourceKind: "exchange", chain, instIds, now: () => Date.now() });
      } finally {
        await atk.close();
      }
    }
  }
  print(report);
  process.exit(report.ok ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
