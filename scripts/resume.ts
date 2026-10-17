// pnpm resume — HUMAN ONLY (SPEC §17). With the processes stopped (and the contract unpaused first with
// `pnpm owner:pause --unpause`): TTY + DEVAM, then clear the core HALT and the executor `halted`, and append RESUME.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { confirmTty, loadScriptConfig, openPolicyChain } from "../src/chain/deployment.js";
import { agentStateStore } from "../src/core/state-store.js";
import { ExecutorStateStore, executorStatePath } from "../src/executor/store.js";
import { FileLedger } from "../src/ledger/ledger.js";
import { SystemClock } from "../src/shared/time.js";

async function portUp(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("pnpm resume bir terminal (TTY) ister");
  const cfg = loadScriptConfig();
  if ((await portUp(cfg.port)) || (await portUp(cfg.executorPort))) throw new Error("önce süreçleri durdurun (çekirdek veya emir gönderici çalışıyor)");
  if (cfg.chain !== "fake") {
    try {
      if ((await openPolicyChain(cfg).chain.readView()).paused) throw new Error("kontrat hâlâ durdurulmuş: önce `pnpm owner:pause --unpause`");
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("kontrat")) throw e;
      console.log(`! zincir okunamadı: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const store = agentStateStore(join(cfg.dataDir, "state.json"));
  const st = store.load();
  if (!st) throw new Error(`${cfg.dataDir}/state.json yok`);
  console.log(`durum: ${st.status} (${st.haltReason ?? "-"})`);
  if (!(await confirmTty("Devam ettirmek için DEVAM yazın:", "DEVAM"))) throw new Error("onaylanmadı");
  store.save({ ...st, status: "RUNNING", haltReason: null, haltedAt: null });
  const exPath = executorStatePath(cfg.dataDir);
  if (existsSync(exPath)) {
    const ex = new ExecutorStateStore(exPath);
    const s = ex.load();
    if (s) ex.save({ ...s, halted: false, lastSeenPaused: false });
  }
  new FileLedger(join(cfg.dataDir, "ledger.jsonl"), new SystemClock()).append("RESUME", { by: "human" }, { cycleId: null, test: false });
  console.log("DEVAM: durdurma kaldırıldı. Şimdi `pnpm dev` veya `pnpm live` ile başlatın.");
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
