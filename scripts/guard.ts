// pnpm guard — VEKİL Guard: the VekilPolicy rule engine as a read-only HTTP JSON service (docs/GUARD_PLAN.md).
// Holds no keys. Env: CHAIN (fuji by default) + RPC, VEKIL_POLICY_ADDRESS or $DATA_DIR/deployment.json,
// GUARD_HOST (127.0.0.1), GUARD_PORT (8791), GUARD_PRICE (optional simulated per-check fee), GUARD_PROPOSE=0 to turn
// Text-to-Policy off. `pnpm guard --write-manifest` only writes docs/guard-manifest.json and exits.
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { makeLlm } from "../src/agent/llm/factory.js";
import { makePolicyParser } from "../src/agent/policy-parser.js";
import { AtkClient, stdioSpawner } from "../src/atk/client.js";
import { readAllowlist } from "../src/atk/manifest.js";
import { loadScriptConfig, openPolicyChain, scriptArgs } from "../src/chain/deployment.js";
import { guardApp, isLoopbackHost } from "../src/guard/server.js";
import { guardManifest } from "../src/guard/manifest.js";
import { AtkMarket } from "../src/market/atk-market.js";
import { loadConfig } from "../src/shared/config.js";
import { SystemClock } from "../src/shared/time.js";

const GuardEnv = z.object({
  GUARD_HOST: z.string().default("127.0.0.1"),
  GUARD_PORT: z.coerce.number().int().min(1).max(65535).default(8791),
  GUARD_PRICE: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  GUARD_PROPOSE: z.enum(["0", "1"]).default("1"),
});

async function main(): Promise<void> {
  const args = scriptArgs();
  const env = GuardEnv.parse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")));
  // Guard signs nothing; the scripted provider keeps config from demanding an LLM key unless Text-to-Policy is on.
  const wantPropose = env.GUARD_PROPOSE === "1" && !args.includes("--write-manifest");
  const cfg = wantPropose ? loadConfig() : loadScriptConfig();
  const { chain } = openPolicyChain(cfg);
  const baseUrl = `http://${env.GUARD_HOST}:${env.GUARD_PORT}`;

  if (args.includes("--write-manifest")) {
    const m = guardManifest({ baseUrl, chainId: chain.chainId, contract: chain.address, pricePerCheck: env.GUARD_PRICE ?? null });
    writeFileSync("docs/guard-manifest.json", JSON.stringify(m, null, 2) + "\n");
    console.log(`docs/guard-manifest.json written (${chain.address} on chainId ${chain.chainId})`);
    return;
  }

  const clock = new SystemClock();
  let propose: ((text: string) => ReturnType<ReturnType<typeof makePolicyParser>>) | undefined;
  let atk: AtkClient | null = null;
  if (wantPropose && cfg.llmProvider !== "scripted") {
    try {
      const allow = readAllowlist("config/atk-allowlist.json").core.filter((n) => n === "market_get_instruments");
      atk = await AtkClient.start({ profile: cfg.atk.readProfile, modules: ["market"], readOnly: true, allow }, { spawner: stdioSpawner, mode: "paper" });
      const market = new AtkMarket(atk, clock);
      const parse = makePolicyParser({ llm: makeLlm(cfg, clock), clock, instrument: (id) => market.getInstrument(id) });
      propose = (text) => parse(text, { nowMs: clock.now() });
    } catch (e) {
      console.warn(`Text-to-Policy off: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const app = guardApp({
    chain,
    now: () => clock.now(),
    ...(propose ? { propose } : {}),
    baseUrl,
    loopbackOnly: isLoopbackHost(env.GUARD_HOST),
    pricePerCheck: env.GUARD_PRICE ?? null,
  });
  if (!isLoopbackHost(env.GUARD_HOST)) {
    console.warn(`UYARI: Guard ${env.GUARD_HOST} adresine açılıyor (loopback değil). Anahtar tutmaz, ama Text-to-Policy LLM kredisi harcar; GUARD_PROPOSE=0 düşünün.`);
  }
  const server = app.listen(env.GUARD_PORT, env.GUARD_HOST, () => {
    console.log(`VEKİL Guard on ${baseUrl} — contract ${chain.address} (chainId ${chain.chainId}), no keys held`);
    console.log(`manifest: ${baseUrl}/.well-known/vekil-guard.json · Text-to-Policy: ${propose ? "on" : "off"}${env.GUARD_PRICE ? ` · price ${env.GUARD_PRICE} USDC (simulated)` : ""}`);
  });
  const stop = (): void => {
    server.close();
    void atk?.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
