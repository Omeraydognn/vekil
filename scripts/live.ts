// pnpm live — HUMAN ONLY (SPEC §8.2). Requires a TTY, PORT=8787 and EXECUTOR_PORT=8789, the word CANLI (and MAINNET
// on mainnet). Then arms core and spawns the executor with a random EXECUTOR_ARM_TOKEN. Claude Code never runs this.
import { randomBytes } from "node:crypto";
import { confirmTty } from "../src/chain/deployment.js";
import { runMain } from "../src/main.js";
import { armLive } from "../src/shared/arming.js";
import { loadConfig } from "../src/shared/config.js";

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("pnpm live bir terminal (TTY) ister");
  const cfg = loadConfig();
  if (cfg.mode !== "live" && cfg.mode !== "demo") throw new Error("EXECUTION_MODE live veya demo olmalı");
  if (cfg.port !== 8787 || cfg.executorPort !== 8789) throw new Error("canlı mod PORT=8787 ve EXECUTOR_PORT=8789 ister");
  console.log(`CANLI: ${cfg.mode} · ${cfg.chain} · ${cfg.dataDir} · ${cfg.instId}`);
  if (!(await confirmTty("Gerçek para. Devam etmek için CANLI yazın:", "CANLI"))) throw new Error("onaylanmadı");
  if (cfg.chain === "mainnet" && !(await confirmTty("Avalanche ana ağ. MAINNET yazın:", "MAINNET"))) throw new Error("onaylanmadı");
  armLive();
  await runMain({ liveArmed: true, armToken: randomBytes(32).toString("hex") });
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
