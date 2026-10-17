// Core entry (SPEC §7): wires modules by mode, runs the startup checks, serves the dashboard and the API, runs the
// scheduler. `pnpm dev` refuses live/demo/mainnet: those start only through scripts/live.ts (a human, a TTY, CANLI).
import { fileURLToPath } from "node:url";
import { buildRuntime } from "./core/wiring.js";
import { CoreScheduler } from "./core/scheduler.js";
import { coreApp, listen, newServerToken } from "./server/server.js";
import { replayApp } from "./server/replay.js";
import { loadConfig, redactConfig } from "./shared/config.js";

const log = (msg: string, extra: Record<string, unknown> = {}): void => console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));

export interface MainOpts {
  /** Only scripts/live.ts passes true (after armLive()). */
  liveArmed?: boolean;
  armToken?: string;
}

export async function runMain(opts: MainOpts = {}): Promise<void> {
  if (process.env.UI_REPLAY) {
    const port = Number(process.env.PORT || 8788);
    const token = newServerToken("data/ui-replay");
    const r = replayApp({ file: process.env.UI_REPLAY, token });
    await listen(r.app, "127.0.0.1", port);
    log("UI replay", { url: `http://127.0.0.1:${port}/`, file: process.env.UI_REPLAY });
    return;
  }
  const cfg = loadConfig();
  const liveLike = cfg.mode === "live" || cfg.mode === "demo";
  if ((liveLike || cfg.chain === "mainnet") && !opts.liveArmed) {
    throw new Error("Canlı mod sadece `pnpm live` ile başlatılır");
  }
  log("starting", { config: redactConfig(cfg) });
  const rt = await buildRuntime(cfg, { liveArmed: opts.liveArmed ?? false, ...(opts.armToken ? { armToken: opts.armToken } : {}) });
  const report = await rt.core.startup();
  for (const c of report.checks) log(`${c.ok ? "✓" : c.level === "warn" ? "!" : "✗"} ${c.id} ${c.tr}`, { details: c.details });
  const token = newServerToken(cfg.dataDir);
  const srv = await listen(coreApp({ core: rt.core, bus: rt.bus, clock: rt.clock, token }), cfg.host, cfg.port);
  rt.core.start();
  const scheduler = new CoreScheduler(rt.core, rt.clock);
  scheduler.start();
  log("ready", { url: `http://${cfg.host}:${cfg.port}/`, status: rt.core.getState().status, mode: cfg.mode, chain: cfg.chain, contract: rt.chain.address });

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log("shutting down");
    scheduler.stop();
    srv.close();
    await rt.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runMain().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
