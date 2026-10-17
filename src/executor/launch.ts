// Spawning the executor process from core (paper) or live.ts (live/demo). The token is random per launch and also
// written to $DATA_DIR/executor-token (0600) for `pnpm kill` (SPEC §14.1, §17).
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Mode } from "../shared/schemas.js";
import { HttpExecutorClient } from "./client.js";

export const executorTokenPath = (dataDir: string): string => join(dataDir, "executor-token");

export interface LaunchOpts {
  mode: Exclude<Mode, "fake">;
  chainId: number;
  rpcUrl: string;
  policy: string;
  fromBlock?: number;
  dataDir: string;
  port: number;
  instId: string;
  feeRate: string;
  paperStartQuote: string;
  monitorIntervalSec: number;
  chainWatchIntervalSec: number;
  atk: { readProfile: string; tradeProfile: string; demoProfile: string };
  /** live/demo only: set by live.ts. */
  armToken?: string;
  readyTimeoutMs?: number;
}

export interface LaunchedExecutor {
  client: HttpExecutorClient;
  child: ChildProcess;
  stop(): Promise<void>;
}

export async function launchExecutor(o: LaunchOpts): Promise<LaunchedExecutor> {
  const token = randomBytes(32).toString("hex");
  mkdirSync(o.dataDir, { recursive: true });
  writeFileSync(executorTokenPath(o.dataDir), token, { mode: 0o600 });
  const entry = fileURLToPath(new URL("./main.ts", import.meta.url));
  const tsx = createRequire(import.meta.url).resolve("tsx");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    EXECUTION_MODE: o.mode,
    CHAIN_ID: String(o.chainId),
    RPC_URL: o.rpcUrl,
    VEKIL_POLICY_ADDRESS: o.policy,
    ...(o.fromBlock !== undefined ? { FROM_BLOCK: String(o.fromBlock) } : {}),
    DATA_DIR: o.dataDir,
    EXECUTOR_PORT: String(o.port),
    EXECUTOR_TOKEN: token,
    ATK_READ_PROFILE: o.atk.readProfile,
    ATK_TRADE_PROFILE: o.atk.tradeProfile,
    ATK_DEMO_PROFILE: o.atk.demoProfile,
    INST_ID: o.instId,
    FEE_RATE: o.feeRate,
    PAPER_START_QUOTE: o.paperStartQuote,
    MONITOR_INTERVAL_SEC: String(o.monitorIntervalSec),
    CHAIN_WATCH_INTERVAL_SEC: String(o.chainWatchIntervalSec),
    ...(o.armToken && (o.mode === "live" || o.mode === "demo") ? { EXECUTOR_ARM_TOKEN: o.armToken } : {}),
  };
  const child = spawn(process.execPath, ["--import", tsx, entry], { env, stdio: ["ignore", "inherit", "inherit"] });
  const client = new HttpExecutorClient(`http://127.0.0.1:${o.port}`, token);
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000).unref();
    });
  };
  const deadline = Date.now() + (o.readyTimeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`executor exited with code ${child.exitCode}`);
    try {
      await client.health();
      return { client, child, stop };
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  await stop();
  throw new Error("executor did not become healthy");
}
