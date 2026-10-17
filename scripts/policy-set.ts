// pnpm policy:set [--text "<Türkçe kurallar>"] [--<policyField> <value> …] [--reset] [--yes]
// Flags apply over the current on-chain policy (SPEC §11, §13.3). Validated with PolicySchema before sending.
import { confirmChainWrite, confirmTty, openPolicyChain, scriptArgs } from "../src/chain/deployment.js";
import { makeLlm } from "../src/agent/llm/factory.js";
import { makePolicyParser } from "../src/agent/policy-parser.js";
import { AtkClient, stdioSpawner } from "../src/atk/client.js";
import { readAllowlist } from "../src/atk/manifest.js";
import { AtkMarket } from "../src/market/atk-market.js";
import { loadConfig, type Config } from "../src/shared/config.js";
import { SystemClock } from "../src/shared/time.js";
import { PolicySchema, defaultPolicy, type Policy, type PolicyProposal } from "../src/shared/schemas.js";
import { endOfDayIstanbul } from "../src/shared/time.js";

/** --text: the Text-to-Policy parser (Anthropic) with the instrument check on the core read instance. */
async function parseText(cfg: Config, text: string, now: number): Promise<Omit<PolicyProposal, "id">> {
  const clock = new SystemClock();
  const allow = readAllowlist("config/atk-allowlist.json").core.filter((n) => n === "market_get_instruments");
  const atk = await AtkClient.start({ profile: cfg.atk.readProfile, modules: ["market"], readOnly: true, allow }, { spawner: stdioSpawner, mode: "paper" });
  try {
    const market = new AtkMarket(atk, clock);
    const llm = makeLlm(cfg, clock);
    return await makePolicyParser({ llm, clock, instrument: (id) => market.getInstrument(id) })(text, { nowMs: now });
  } finally {
    await atk.close();
  }
}

const DEC_FIELDS = ["maxOrderQuote", "dailyRiskBudgetQuote", "minStopDistancePct", "maxStopDistancePct"] as const;
const INT_FIELDS = ["maxTradesPerHour", "maxTradesPerDay", "maxHoldMin", "feeBps", "slippageBps"] as const;

export function applyFlags(base: Policy, args: string[]): Policy {
  const p: Policy = structuredClone(base);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--") || ["--reset", "--yes", "--text"].includes(a)) {
      if (a === "--text") i++;
      continue;
    }
    const field = a.slice(2);
    const v = args[i + 1];
    if (v === undefined) throw new Error(`${a} needs a value`);
    i++;
    if ((DEC_FIELDS as readonly string[]).includes(field)) (p as Record<string, unknown>)[field] = v;
    else if ((INT_FIELDS as readonly string[]).includes(field)) {
      if (!/^\d+$/.test(v)) throw new Error(`${a} must be an integer`);
      (p as Record<string, unknown>)[field] = Number(v);
    } else if (field === "instIds") p.instIds = v.split(",").map((s) => s.trim()).filter(Boolean);
    else if (field === "validUntil") {
      const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
      if (!Number.isSafeInteger(ms)) throw new Error("--validUntil: epoch ms or an ISO date");
      p.validUntil = Math.floor(ms / 1000) * 1000;
    } else if (field === "sourceText") p.sourceText = v;
    else throw new Error(`unknown flag ${a}`);
  }
  return p;
}

async function main(): Promise<void> {
  const args = scriptArgs();
  const textIdx = args.indexOf("--text");
  const text = textIdx >= 0 ? args[textIdx + 1] : undefined;
  const cfg = loadConfig({ env: { ...(text === undefined ? { LLM_PROVIDER: "scripted" } : {}), ...process.env } });
  const { chain } = openPolicyChain(cfg, { owner: true });
  const view = await chain.readView();
  const now = Date.now();

  let next: Policy;
  if (text !== undefined) {
    const proposal = await parseText(cfg, text, now);
    console.log(proposal.summaryTr);
    for (const m of proposal.mapping) console.log(`  "${m.phrase}" → ${m.field} = ${m.value}`);
    for (const a of proposal.assumptions) console.log(`  varsayım: ${a}`);
    for (const q of proposal.questions) console.log(`  soru: ${q}`);
    if (proposal.errors.length) throw new Error(`policy errors: ${proposal.errors.join("; ")}`);
    if (!(await confirmTty("Bu kuralları zincire yaz? [y/N]", "y"))) throw new Error("not confirmed (needs a TTY)");
    next = applyFlags(proposal.policy, args);
  } else {
    const base = args.includes("--reset") ? defaultPolicy(now) : view.policy;
    next = applyFlags(base, args);
    if (next.validUntil <= now) next.validUntil = endOfDayIstanbul(now) > now ? endOfDayIstanbul(now) : endOfDayIstanbul(now + 86_400_000);
  }
  const parsed = PolicySchema.safeParse(next);
  if (!parsed.success) throw new Error(`invalid policy: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  console.log(`current v${view.policyVersion}: ${JSON.stringify(view.policy)}`);
  console.log(`new policy:       ${JSON.stringify(parsed.data)}`);
  await confirmChainWrite(cfg, "setPolicy", args);
  const res = await chain.setPolicy(parsed.data);
  if (!res.ok) throw new Error(res.error);
  const after = await chain.readView();
  console.log(`policy v${after.policyVersion} set: ${chain.explorerTxUrl(res.txHash) ?? res.txHash}`);
}

if (process.argv[1]?.endsWith("policy-set.ts")) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
