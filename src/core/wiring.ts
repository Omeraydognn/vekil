// Binds CoreDeps to the real modules by mode (SPEC §8.1, PLAN M2): fake → in-process executor + FakeExchange +
// FakeMarket; paper → executor process (PaperExchange) + core read instance; live/demo → armed executor process +
// core read instance. CHAIN=fake → FakePolicyChain; local → own anvil + deploy from bytecode; fuji/mainnet → deployment.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { makeAgentPort } from "../agent/agent.js";
import { makeMarketContextFn } from "../agent/context.js";
import { makeIndicatorsFn } from "../agent/indicators.js";
import { makeLlm } from "../agent/llm/factory.js";
import { ScriptedLlm, ScriptFileSchema } from "../agent/llm/scripted.js";
import { makePolicyParser, PROPOSE_POLICY } from "../agent/policy-parser.js";
import { makeRogueBuilder, R1_PAIR } from "../agent/redteam.js";
import { AtkClient, stdioSpawner, type AtkSpawner } from "../atk/client.js";
import { readAllowlist } from "../atk/manifest.js";
import { executorOrderSource, runAudit } from "../audit/auditor.js";
import { startLocalChain } from "../chain/anvil.js";
import { readDeployment, writeDeployment, openPolicyChain } from "../chain/deployment.js";
import { FAKE_AGENT, FakePolicyChain } from "../chain/fake-policy-chain.js";
import { InProcessExecutor } from "../executor/client.js";
import { AtkExchange, AtkOrderHistory } from "../executor/exchanges/atk-exchange.js";
import { FakeExchange } from "../executor/exchanges/fake-exchange.js";
import { Executor } from "../executor/executor.js";
import { launchExecutor, type LaunchedExecutor } from "../executor/launch.js";
import { MemoryStateStore } from "../executor/store.js";
import { FileLedger } from "../ledger/ledger.js";
import { verifyLedger } from "../ledger/verify.js";
import { AtkMarket } from "../market/atk-market.js";
import { FakeMarket } from "../market/fake-market.js";
import { preflight } from "../preflight/preflight.js";
import type { Config } from "../shared/config.js";
import { InMemoryEventBus } from "../shared/events.js";
import { manifestHash } from "../shared/hash.js";
import type { AtkReader, Clock, EventBus, ExecutorApi, LlmClient, MarketData, PolicyChain } from "../shared/interfaces.js";
import type { Address, ExecutorState } from "../shared/schemas.js";
import { SystemClock } from "../shared/time.js";
import type { CoreDeps } from "./deps.js";
import { agentStateStore } from "./state-store.js";
import { Vekil } from "./vekil.js";

export const SMOKE_SCRIPT = "fixtures/smoke-script.json";

export interface RuntimeOpts {
  /** Set only by scripts/live.ts after the TTY + CANLI confirmation. */
  liveArmed?: boolean;
  armToken?: string;
  clock?: Clock;
  bus?: EventBus;
  /** Scripted LLM fixture (default fixtures/smoke-script.json). */
  scriptPath?: string;
  /** Tests: the ATK spawner (never spawn okx-trade-mcp in tests). */
  spawner?: AtkSpawner;
  /** Wipe the data dir of an ephemeral chain (fake/local) on start (default true, SPEC §8). */
  wipeEphemeral?: boolean;
  /** Start the in-process executor's monitor and pause watcher (default true; smoke drives them by hand). */
  executorLoops?: boolean;
}

export interface Runtime {
  core: Vekil;
  deps: CoreDeps;
  bus: EventBus;
  clock: Clock;
  chain: PolicyChain;
  market: MarketData;
  executorApi: ExecutorApi;
  /** fake mode only: the in-process executor and its exchange (smoke, tests). */
  inProcess: { executor: Executor; exchange: FakeExchange } | null;
  fakeMarket: FakeMarket | null;
  llm: LlmClient;
  stop(): Promise<void>;
}

/** AtkReader that offers no tools (fake mode). */
const NO_ATK: AtkReader = { listTools: async () => [], callTool: async () => "{}" };

export async function buildRuntime(cfg: Config, opts: RuntimeOpts = {}): Promise<Runtime> {
  const clock = opts.clock ?? new SystemClock();
  const bus = opts.bus ?? new InMemoryEventBus();
  const closers: (() => Promise<void>)[] = [];
  const stop = async (): Promise<void> => {
    for (const c of closers.reverse()) await c().catch(() => undefined);
  };
  try {
    // Only our own per-mode dirs under ./data are wiped; a mistaken DATA_DIR override is never deleted.
    const ownDataDir = resolve(cfg.dataDir).startsWith(resolve("data") + sep);
    if ((cfg.chain === "fake" || cfg.chain === "local") && (opts.wipeEphemeral ?? true) && ownDataDir && existsSync(cfg.dataDir)) {
      rmSync(cfg.dataDir, { recursive: true, force: true });
    }

    // ---- chain
    let chain: PolicyChain;
    let agentAddress: Address | null;
    let fromBlock: number | undefined;
    let rpcUrl = cfg.rpcUrl;
    if (cfg.chain === "fake") {
      chain = new FakePolicyChain({ clock });
      agentAddress = FAKE_AGENT;
    } else if (cfg.chain === "local") {
      const lc = await startLocalChain({ clock });
      closers.push(() => lc.stop());
      writeDeployment(cfg.dataDir, { chainId: lc.chain.chainId, ...lc.deployment, deployedAt: clock.now() });
      chain = lc.chain;
      agentAddress = lc.deployment.agent;
      fromBlock = lc.deployment.deployBlock;
      rpcUrl = lc.anvil.rpcUrl;
    } else {
      chain = openPolicyChain(cfg, { agent: true, owner: cfg.ownerPrivateKey !== null }).chain;
      agentAddress = cfg.agentPrivateKey ? (privateKeyToAccount(cfg.agentPrivateKey).address.toLowerCase() as Address) : null;
      fromBlock = readDeployment(cfg.dataDir)?.deployBlock;
    }

    // ---- market + core read instance
    const allow = readAllowlist("config/atk-allowlist.json");
    let market: MarketData;
    let fakeMarket: FakeMarket | null = null;
    let read: AtkClient | null = null;
    if (cfg.mode === "fake") {
      fakeMarket = new FakeMarket(clock);
      market = fakeMarket;
    } else {
      read = await AtkClient.start(
        {
          profile: cfg.mode === "demo" ? cfg.atk.demoProfile : cfg.atk.readProfile, modules: cfg.atk.readModules, readOnly: true,
          demo: cfg.mode === "demo", allow: [...new Set([...allow.core, ...allow.llm])],
        },
        { spawner: opts.spawner ?? stdioSpawner, mode: cfg.mode },
      );
      const r = read;
      closers.push(() => r.close());
      market = new AtkMarket(read, clock);
    }

    // ---- executor
    let executorApi: ExecutorApi;
    let inProcess: Runtime["inProcess"] = null;
    if (cfg.mode === "fake") {
      const exchange = new FakeExchange(market, clock, { startQuote: cfg.paperStartQuote, feeRate: cfg.feeRate });
      const executor = new Executor({
        mode: "fake", chainId: chain.chainId, policy: chain.address, chain, exchange, market, clock, store: new MemoryStateStore<ExecutorState>(),
        atk: { kind: "fake", modules: [], readOnly: true, demo: false, tools: [] }, instIds: [cfg.instId],
      });
      await executor.recover();
      const stopLoops = opts.executorLoops === false
        ? () => undefined
        : executor.start({ monitorIntervalMs: cfg.monitorIntervalSec * 1000, chainWatchIntervalMs: cfg.chainWatchIntervalSec * 1000 });
      closers.push(async () => {
        stopLoops();
        executor.stop();
      });
      executorApi = new InProcessExecutor(executor);
      inProcess = { executor, exchange };
    } else {
      if (!rpcUrl) throw new Error("the executor process needs a real chain (CHAIN=local, fuji or mainnet)");
      const launched: LaunchedExecutor = await launchExecutor({
        mode: cfg.mode, chainId: chain.chainId, rpcUrl,
        policy: chain.address, ...(fromBlock !== undefined ? { fromBlock } : {}), dataDir: cfg.dataDir, port: cfg.executorPort, instId: cfg.instId,
        feeRate: cfg.feeRate, paperStartQuote: cfg.paperStartQuote, monitorIntervalSec: cfg.monitorIntervalSec, chainWatchIntervalSec: cfg.chainWatchIntervalSec,
        atk: { readProfile: cfg.atk.readProfile, tradeProfile: cfg.atk.tradeProfile, demoProfile: cfg.atk.demoProfile },
        ...(opts.armToken ? { armToken: opts.armToken } : {}),
      });
      closers.push(() => launched.stop());
      executorApi = launched.client;
    }

    // ---- LLM, agent, parser, red-team
    const policyFromChain = async () => (await chain.readView()).policy;
    const indicators = makeIndicatorsFn({ market, policy: policyFromChain, profile: cfg.strategyProfile, clock });
    let llm: LlmClient;
    let model: string;
    let parserLlm: LlmClient;
    if (cfg.llmProvider === "scripted") {
      // One fixture file; propose_policy turns feed the parser, all other turns feed the agent, each in order.
      const script = ScriptFileSchema.parse(JSON.parse(readFileSync(opts.scriptPath ?? SMOKE_SCRIPT, "utf8")));
      const isParserTurn = (t: (typeof script.turns)[number]): boolean => t.content.some((b) => b.type === "tool_use" && b.name === PROPOSE_POLICY);
      const resolver = {
        clock, indicators, r1Pair: R1_PAIR, defaultInstId: cfg.instId,
        currentStopPx: async (instId: string) => (await executorApi.health()).positions.find((p) => p.instId === instId)?.stopPx ?? null,
      };
      llm = new ScriptedLlm(script.turns.filter((t) => !isParserTurn(t)), resolver);
      parserLlm = new ScriptedLlm(script.turns.filter(isParserTurn), resolver);
      model = "scripted";
    } else {
      llm = makeLlm(cfg, clock);
      parserLlm = llm;
      model = cfg.llm.model;
    }
    const agent = makeAgentPort({
      llm, model, atk: read ?? NO_ATK, allowlist: read ? allow.llm : [], clock, bus, instId: cfg.instId, mode: cfg.mode,
      maxToolCalls: cfg.llm.maxToolCalls, cooldownAfterLossMin: cfg.preflight.cooldownAfterLossMin, indicators,
      marketContext: makeMarketContextFn({ market, clock }), positions: async () => (await executorApi.health()).positions,
    });
    const buildRogue = makeRogueBuilder({ r1Pair: R1_PAIR, instId: cfg.instId, market, indicators });
    const parsePolicy = makePolicyParser({ llm: parserLlm, clock, instrument: (id) => market.getInstrument(id) });

    // ---- ledger, state, audit
    const ledger = new FileLedger(join(cfg.dataDir, "ledger.jsonl"), clock);
    const liveLike = cfg.mode === "live" || cfg.mode === "demo";
    const auditSource = liveLike && read ? new AtkOrderHistory(read) : executorOrderSource(executorApi);
    const readClient = read;
    const deps: CoreDeps = {
      cfg, clock, bus, ledger, stateStore: agentStateStore(join(cfg.dataDir, "state.json")), chain, agentAddress, executor: executorApi, market,
      readAccount: liveLike && read ? (instId) => new AtkExchange(readClient!, readClient!, clock).getAccount(instId) : null,
      preflight,
      agent,
      buildRogue: (id, ctx) => buildRogue(id, ctx),
      parsePolicy,
      verify: (o) => verifyLedger(o),
      audit: () => runAudit({
        source: auditSource, sourceKind: cfg.mode === "fake" ? "fake" : cfg.mode === "paper" ? "paper" : "exchange", chain, now: () => clock.now(),
        instIds: async () => [...new Set([...(await chain.readView()).policy.instIds, cfg.instId])],
      }),
      atkRead: read
        ? {
            atkVersion: read.version,
            manifestHash: manifestHash(await read.listTools()),
            capabilities: async () => ({ readOnly: readClient!.capabilities.readOnly, modules: Object.keys(readClient!.capabilities.moduleAvailability) }),
            listTools: () => readClient!.listTools(),
          }
        : null,
      ask: null,
      dataDir: cfg.dataDir,
      r1Pair: R1_PAIR,
      liveArmed: opts.liveArmed ?? false,
    };
    const core = new Vekil(deps);
    closers.push(() => core.shutdown());
    return { core, deps, bus, clock, chain, market, executorApi, inProcess, fakeMarket, llm, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
