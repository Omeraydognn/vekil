// The executor process (SPEC §14.1): spawned by `pnpm dev` (paper) or `pnpm live` (live/demo). It reads no .env; the
// parent passes everything in the environment. It holds the trade key only in live/demo and only when armed.
import { join } from "node:path";
import { z } from "zod";
import { AtkClient, stdioSpawner } from "../atk/client.js";
import { readAllowlist } from "../atk/manifest.js";
import { ViemPolicyChain } from "../chain/policy-chain.js";
import { AtkMarket } from "../market/atk-market.js";
import { isLiveArmed } from "../shared/arming.js";
import type { Exchange, MarketData } from "../shared/interfaces.js";
import { Address, Dec, ModeSchema, PDec, type ExecutorHealth } from "../shared/schemas.js";
import { SystemClock } from "../shared/time.js";
import { AtkExchange } from "./exchanges/atk-exchange.js";
import { PaperExchange, paperAccountPath } from "./exchanges/paper-exchange.js";
import { Executor } from "./executor.js";
import { executorApp, listenExecutor } from "./server.js";
import { ExecutorStateStore, PendingEntryStore, executorPendingPath, executorStatePath } from "./store.js";

const EnvSchema = z.object({
  EXECUTION_MODE: ModeSchema,
  CHAIN_ID: z.coerce.number().int().positive(),
  RPC_URL: z.string().url(),
  VEKIL_POLICY_ADDRESS: Address,
  FROM_BLOCK: z.coerce.number().int().nonnegative().optional(),
  DATA_DIR: z.string().min(1),
  EXECUTOR_PORT: z.coerce.number().int().min(1).max(65535),
  EXECUTOR_TOKEN: z.string().min(32),
  ATK_READ_PROFILE: z.string().default("tr-read"),
  ATK_TRADE_PROFILE: z.string().default("tr-trade"),
  ATK_DEMO_PROFILE: z.string().default("tr-demo"),
  INST_ID: z.string().default("AVAX-TRY"),
  FEE_RATE: Dec.default("0.002"),
  PAPER_START_QUOTE: PDec.default("1000"),
  MONITOR_INTERVAL_SEC: z.coerce.number().int().positive().default(10),
  CHAIN_WATCH_INTERVAL_SEC: z.coerce.number().int().positive().default(3),
});

async function main(): Promise<void> {
  const env = EnvSchema.parse(process.env);
  const mode = env.EXECUTION_MODE;
  if (mode === "fake") throw new Error("fake mode runs the executor in-process");
  const clock = new SystemClock();
  const allow = readAllowlist("config/atk-allowlist.json");
  const closers: (() => Promise<void>)[] = [];
  let exchange: Exchange;
  let market: MarketData;
  let atkInfo: ExecutorHealth["atk"];

  if (mode === "paper") {
    // One read-only instance for prices; balances and orders are PaperExchange's own.
    const read = await AtkClient.start(
      { profile: env.ATK_READ_PROFILE, modules: ["market", "spot"], readOnly: true, allow: allow.core.filter((n) => n.startsWith("market_")) },
      { spawner: stdioSpawner, mode },
    );
    closers.push(() => read.close());
    market = new AtkMarket(read, clock);
    exchange = new PaperExchange(market, clock, paperAccountPath(env.DATA_DIR), { startQuote: env.PAPER_START_QUOTE, feeRate: env.FEE_RATE });
    atkInfo = { kind: "read", modules: ["market", "spot"], readOnly: true, demo: false, tools: read.allowedTools() };
  } else {
    if (!isLiveArmed({ mode, env: process.env })) throw new Error("live/demo executor needs EXECUTOR_ARM_TOKEN (started by pnpm live)");
    const demo = mode === "demo";
    const profile = demo ? env.ATK_DEMO_PROFILE : env.ATK_TRADE_PROFILE;
    const trade = await AtkClient.start({ profile, modules: ["market", "spot"], readOnly: false, demo, allow: allow.executorTrade }, { spawner: stdioSpawner, mode });
    closers.push(() => trade.close());
    // The trade instance never gets the account module: balances come from a separate read-only instance.
    const acct = await AtkClient.start(
      { profile: env.ATK_READ_PROFILE, modules: ["account"], readOnly: true, demo, allow: ["account_get_balance"] },
      { spawner: stdioSpawner, mode },
    );
    closers.push(() => acct.close());
    market = new AtkMarket(trade, clock);
    exchange = new AtkExchange(trade, acct, clock);
    atkInfo = { kind: "trade", modules: ["market", "spot"], readOnly: false, demo, tools: (await trade.listTools()).map((t) => t.name).sort() };
  }

  const chain = new ViemPolicyChain({
    rpcUrl: env.RPC_URL, chainId: env.CHAIN_ID, address: env.VEKIL_POLICY_ADDRESS, clock,
    ...(env.FROM_BLOCK !== undefined ? { fromBlock: env.FROM_BLOCK } : {}),
  });
  const ex = new Executor({
    mode, chainId: env.CHAIN_ID, policy: env.VEKIL_POLICY_ADDRESS, chain, exchange, market, clock,
    store: new ExecutorStateStore(executorStatePath(env.DATA_DIR)), atk: atkInfo, instIds: [env.INST_ID],
    pendingStore: new PendingEntryStore(executorPendingPath(env.DATA_DIR)),
  });
  await ex.recover();
  const stopLoops = ex.start({ monitorIntervalMs: env.MONITOR_INTERVAL_SEC * 1000, chainWatchIntervalMs: env.CHAIN_WATCH_INTERVAL_SEC * 1000 });
  const srv = await listenExecutor(executorApp(ex, env.EXECUTOR_TOKEN), "127.0.0.1", env.EXECUTOR_PORT);
  console.log(JSON.stringify({ msg: "executor ready", mode, port: env.EXECUTOR_PORT, policy: env.VEKIL_POLICY_ADDRESS, data: join(env.DATA_DIR) }));

  const shutdown = async (): Promise<void> => {
    stopLoops();
    ex.stop();
    srv.close();
    for (const c of closers) await c().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e: unknown) => {
  console.error(JSON.stringify({ msg: "executor failed", error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
