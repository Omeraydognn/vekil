// pnpm kill (SPEC §17): halt core and the executor and cancel the agent's open orders. Asks first (TTY "y" or --yes).
// Fallbacks: 1) core POST /api/kill (server-token); 2) executor /halt + /cancel-all (executor-token);
// 3) live/demo (per state.json): cancel-only ATK client + HALT in state.json; fake/paper: HALT in state.json only.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AtkClient, readStateModeFromFile, stdioSpawner } from "../src/atk/client.js";
import { confirmTty, scriptArgs } from "../src/chain/deployment.js";
import { HttpExecutorClient } from "../src/executor/client.js";
import { executorTokenPath } from "../src/executor/launch.js";
import { OkxOrderRow, rows } from "../src/atk/parse.js";
import { agentStateStore } from "../src/core/state-store.js";
import { serverTokenPath } from "../src/server/server.js";
import { loadConfig } from "../src/shared/config.js";
import { CLORDID_RE } from "../src/shared/order-hash.js";
import { KillReportSchema } from "../src/shared/schemas.js";

const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8").trim() : null);

function haltStateFile(dataDir: string, reason: string): void {
  const store = agentStateStore(join(dataDir, "state.json"));
  const st = store.load();
  if (!st) {
    console.log("state.json yok; yazılacak durdurma kaydı yok");
    return;
  }
  if (st.status !== "HALTED") store.save({ ...st, status: "HALTED", haltReason: reason, haltedAt: Date.now() });
  console.log(`state.json → HALTED (${reason})`);
}

async function main(): Promise<void> {
  const args = scriptArgs();
  const cfg = loadConfig({ env: { LLM_PROVIDER: "scripted", ...process.env } });
  if (!args.includes("--yes") && !(await confirmTty(`Durdur: ${cfg.mode}/${cfg.chain}, ${cfg.dataDir}. Devam? [y/N]`, "y"))) {
    throw new Error("onaylanmadı (TTY'de y yazın veya --yes)");
  }
  const flatten = args.includes("--flatten");

  // 1. Core.
  const serverToken = read(serverTokenPath(cfg.dataDir));
  if (serverToken) {
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.port}/api/kill`, {
        method: "POST",
        headers: { "x-vekil-token": serverToken, "content-type": "application/json" },
        body: JSON.stringify({ pauseOnChain: !args.includes("--no-pause"), flatten }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const r = KillReportSchema.parse(await res.json());
        console.log(`DURDURULDU (çekirdek): yerel ${r.steps.localMs} ms · emirler ${r.steps.executorMs ?? "-"} ms · zincir ${r.steps.chainMs ?? "-"} ms`);
        if (r.cancelled.length) console.log(`iptal: ${r.cancelled.join(", ")}`);
        if (r.pauseTx) console.log(`pause tx: ${r.pauseTx}`);
        for (const e of r.errors) console.log(`! ${e}`);
        if (!r.errors.some((e) => e.startsWith("executor"))) return;
        console.log("çekirdek emir göndericiye ulaşamadı; doğrudan deneniyor");
      }
      console.log(`çekirdek yanıtı ${res.status}; emir göndericiye geçiliyor`);
    } catch (e) {
      console.log(`çekirdeğe ulaşılamadı (${e instanceof Error ? e.message : String(e)}); emir göndericiye geçiliyor`);
    }
  }

  // 2. Executor.
  const execToken = read(executorTokenPath(cfg.dataDir));
  if (execToken) {
    try {
      const ex = new HttpExecutorClient(`http://127.0.0.1:${cfg.executorPort}`, execToken, 15_000);
      await ex.halt();
      const cancelled = await ex.cancelAll("kill");
      console.log(`DURDURULDU (emir gönderici): iptal ${cancelled.length} emir ${cancelled.join(", ")}`);
      if (flatten) {
        for (const p of (await ex.health()).positions) {
          const r = await ex.exit(p.entryOrderHash, "KILL_FLATTEN");
          console.log(`kapat ${p.instId} ${p.clOrdId}: ${r.result}${r.refusal ? " " + r.refusal : ""}`);
        }
      }
      haltStateFile(cfg.dataDir, "pnpm kill (emir gönderici)");
      return;
    } catch (e) {
      console.log(`emir göndericiye ulaşılamadı (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  // 3. Nothing is running: write the HALT first, then try to cancel.
  haltStateFile(cfg.dataDir, "pnpm kill (süreçler kapalı)");
  const mode = readStateModeFromFile(cfg.dataDir);
  if (mode === "live" || mode === "demo") {
    const demo = mode === "demo";
    const listing = await AtkClient.start(
      { profile: demo ? cfg.atk.demoProfile : cfg.atk.readProfile, modules: ["spot"], readOnly: true, demo, allow: ["spot_get_orders"] },
      { spawner: stdioSpawner, mode },
    );
    const cancel = await AtkClient.start(
      { profile: demo ? cfg.atk.demoProfile : cfg.atk.tradeProfile, modules: ["spot"], readOnly: false, cancelOnly: true, demo, allow: [] },
      { spawner: stdioSpawner, mode, dataDir: cfg.dataDir },
    );
    try {
      const open = rows("spot_get_orders", await listing.callData("spot_get_orders", { status: "open" }), OkxOrderRow).filter((o) => CLORDID_RE.test(o.clOrdId));
      for (const o of open) {
        await cancel.callData("spot_cancel_order", { instId: o.instId, clOrdId: o.clOrdId });
        console.log(`iptal (cancel-only): ${o.instId} ${o.clOrdId}`);
      }
      if (!open.length) console.log("açık ajan emri yok");
    } finally {
      await listing.close();
      await cancel.close();
    }
  } else {
    console.log(`${mode ?? "bilinmeyen"} mod: borsada iptal edilecek gerçek emir yok`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
