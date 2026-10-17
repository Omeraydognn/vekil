// pnpm probe:policy — parses 3 sample Turkish texts with the Text-to-Policy parser and prints proposal, mapping,
// assumptions, questions and errors. No chain. LLM_PROVIDER=anthropic (default) or openrouter uses the real model and the core read
// instance for the instrument check; LLM_PROVIDER=scripted replays fixtures/policy-fixtures.json on the fake market.
import { readFileSync } from "node:fs";
import { AtkClient, stdioSpawner } from "../src/atk/client.js";
import { readAllowlist } from "../src/atk/manifest.js";
import { makeLlm } from "../src/agent/llm/factory.js";
import { ScriptedLlm } from "../src/agent/llm/scripted.js";
import { makePolicyParser } from "../src/agent/policy-parser.js";
import { AtkMarket } from "../src/market/atk-market.js";
import { FakeMarket } from "../src/market/fake-market.js";
import { loadConfig } from "../src/shared/config.js";
import type { LlmClient, MarketData } from "../src/shared/interfaces.js";
import { SystemClock } from "../src/shared/time.js";
import { z } from "zod";

async function main(): Promise<void> {
  const cfg = loadConfig({ env: { CHAIN: "fake", EXECUTION_MODE: "fake", ...process.env } });
  const clock = new SystemClock();
  const fixtures = z.object({ texts: z.array(z.string()) }).passthrough().parse(JSON.parse(readFileSync("fixtures/policy-fixtures.json", "utf8")));
  let llm: LlmClient;
  let market: MarketData;
  let close = async (): Promise<void> => undefined;
  if (cfg.llmProvider === "scripted") {
    console.log("(scripted parser: fixtures/policy-fixtures.json, fake market)");
    llm = ScriptedLlm.fromFile(JSON.parse(readFileSync("fixtures/policy-fixtures.json", "utf8")) as unknown, { clock });
    market = new FakeMarket(clock);
  } else {
    llm = makeLlm(cfg, clock);
    const allow = readAllowlist("config/atk-allowlist.json").core.filter((n) => n === "market_get_instruments");
    const atk = await AtkClient.start({ profile: cfg.atk.readProfile, modules: ["market"], readOnly: true, allow }, { spawner: stdioSpawner, mode: "paper" });
    close = () => atk.close();
    market = new AtkMarket(atk, clock);
  }
  let failed = 0;
  const parse = makePolicyParser({ llm, clock, instrument: (id) => market.getInstrument(id) });
  try {
    for (const [i, text] of fixtures.texts.entries()) {
      console.log(`\n=== ${i + 1}. "${text}"`);
      let p: Awaited<ReturnType<typeof parse>>;
      try {
        p = await parse(text, { nowMs: clock.now() });
      } catch (e) {
        failed++;
        console.log(`HATA: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      console.log(p.summaryTr);
      console.log(`policy: ${JSON.stringify({ ...p.policy, validUntil: new Date(p.policy.validUntil).toISOString() })}`);
      console.log("Senin cümlen → Kontrat alanı → Değer");
      for (const m of p.mapping) console.log(`  "${m.phrase}" → ${m.field} → ${m.value}`);
      for (const a of p.assumptions) console.log(`  Varsayım: ${a}`);
      for (const q of p.questions) console.log(`  Soru: ${q}`);
      for (const e of p.errors) console.log(`  HATA: ${e}`);
      console.log(p.errors.length ? "→ Onayla kapalı (hata var)" : p.questions.length ? "→ Onayla: soruları yanıtla veya varsayımları kabul et" : "→ Onaylanabilir");
    }
  } finally {
    await close();
  }
  if (failed) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
