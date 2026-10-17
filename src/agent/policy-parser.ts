// Text-to-Policy (SPEC §11, Appendix D): one LLM call with a forced propose_policy tool. The LLM only drafts;
// everything is validated in code (zod + §9.1 ranges, hard caps, min < max stop, live SPOT instruments, validUntil
// within 7 days and a whole second). Problems go into `errors`; the owner confirms; the contract enforces the caps.
import { z } from "zod";
import type { Clock, LlmClient, LlmRequest } from "../shared/interfaces.js";
import { D, HARD_MAX_DAILY_RISK, HARD_MAX_ORDER_QUOTE } from "../shared/money.js";
import { PolicySchema, defaultPolicy, type InstrumentSpec, type Policy, type PolicyProposal, type ToolDef } from "../shared/schemas.js";
import { isoIstanbul } from "../shared/time.js";

export const PROPOSE_POLICY = "propose_policy";
export const MAX_TEXT_CHARS = 1000;
export const MAX_VALID_DAYS = 7;

export const POLICY_PARSER_PROMPT = `You convert an account owner's Turkish description of trading rules into a structured policy for a
smart contract. You never invent permissions the owner didn't give.

Output (call propose_policy exactly once):
- policy fields: instIds, maxOrderQuote, dailyRiskBudgetQuote, maxTradesPerHour, maxTradesPerDay,
  minStopDistancePct, maxStopDistancePct (at most 2 decimals), maxHoldMin, feeBps, slippageBps,
  validUntilIso (whole seconds).
- mapping: for each field, the exact Turkish phrase it came from (or "varsayılan" if defaulted).
- assumptions: every default you filled in, in Turkish.
- questions: anything ambiguous or contradictory, in Turkish (e.g. "Günlük 100 TL kayıp mı, risk mi?").
- summaryTr: 2–3 plain Turkish sentences describing the policy.

Rules:
- Instruments are OKX TR spot pairs like "AVAX-TRY". Map coin names to "<COIN>-TRY".
- "günlük en fazla X TL kaybetmeyi göze alırım" → dailyRiskBudgetQuote = X.
- If something is not stated, use these defaults and list them as assumptions: maxTradesPerHour 1,
  maxTradesPerDay 4, minStop 0.3, maxStop 3, maxHoldMin 480, feeBps 20, slippageBps 30, validUntil
  today 23:59:59 Europe/Istanbul, instIds ["AVAX-TRY"], maxOrderQuote 200, dailyRiskBudgetQuote 100.
- Stop-loss is always required, and only long spot trading is possible: if the owner asks for
  anything else (leverage, short, no stop), do not encode it; add a question explaining it's not
  allowed.
- Never exceed 1000 TRY per order or 500 TRY daily risk; if asked, cap it and add a question.`;

const decString = { type: "string", pattern: "^\\d+(\\.\\d+)?$" };
export const PROPOSE_POLICY_DEF: ToolDef = {
  name: PROPOSE_POLICY,
  description: "Propose the structured policy for the owner's Turkish text (call exactly once).",
  input_schema: {
    type: "object",
    properties: {
      instIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
      maxOrderQuote: decString,
      dailyRiskBudgetQuote: decString,
      maxTradesPerHour: { type: "integer", minimum: 1, maximum: 60 },
      maxTradesPerDay: { type: "integer", minimum: 1, maximum: 100 },
      minStopDistancePct: { type: "string", pattern: "^\\d+(\\.\\d{1,2})?$" },
      maxStopDistancePct: { type: "string", pattern: "^\\d+(\\.\\d{1,2})?$" },
      maxHoldMin: { type: "integer", minimum: 15, maximum: 1440 },
      feeBps: { type: "integer", minimum: 0, maximum: 100 },
      slippageBps: { type: "integer", minimum: 0, maximum: 200 },
      validUntilIso: { type: "string", description: "ISO 8601 with offset, whole seconds, e.g. 2026-10-17T23:59:59+03:00" },
      mapping: {
        type: "array",
        items: { type: "object", properties: { phrase: { type: "string" }, field: { type: "string" }, value: { type: "string" } }, required: ["phrase", "field", "value"] },
      },
      assumptions: { type: "array", items: { type: "string" } },
      questions: { type: "array", items: { type: "string" } },
      summaryTr: { type: "string" },
    },
    required: [
      "instIds", "maxOrderQuote", "dailyRiskBudgetQuote", "maxTradesPerHour", "maxTradesPerDay", "minStopDistancePct",
      "maxStopDistancePct", "maxHoldMin", "feeBps", "slippageBps", "validUntilIso", "mapping", "assumptions", "questions", "summaryTr",
    ],
  },
};

/** Loose: the LLM's draft. Anything wrong is reported in `errors`, never silently fixed (except the hard caps). */
const DraftSchema = z.object({
  instIds: z.array(z.string()).optional(),
  maxOrderQuote: z.union([z.string(), z.number()]).optional(),
  dailyRiskBudgetQuote: z.union([z.string(), z.number()]).optional(),
  maxTradesPerHour: z.number().optional(),
  maxTradesPerDay: z.number().optional(),
  minStopDistancePct: z.union([z.string(), z.number()]).optional(),
  maxStopDistancePct: z.union([z.string(), z.number()]).optional(),
  maxHoldMin: z.number().optional(),
  feeBps: z.number().optional(),
  slippageBps: z.number().optional(),
  validUntilIso: z.string().optional(),
  mapping: z.array(z.object({ phrase: z.string(), field: z.string(), value: z.union([z.string(), z.number()]) })).default([]),
  assumptions: z.array(z.string()).default([]),
  questions: z.array(z.string()).default([]),
  summaryTr: z.string().default(""),
});

export interface PolicyParserDeps {
  llm: LlmClient;
  clock: Clock;
  /** Spec read for each instId (live SPOT check); throws or returns null when unknown. */
  instrument: (instId: string) => Promise<InstrumentSpec | null>;
  timeoutMs?: number;
}

const str = (v: string | number | undefined): string | undefined => (v === undefined ? undefined : typeof v === "number" ? String(v) : v.trim().replace(",", "."));
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/** Validation in code (§11 step 3). Returns the policy plus errors and any extra questions (caps). */
/**
 * Questions the owner must see whatever the model wrote (Appendix D rules, enforced in code): requests we can't encode
 * (leverage, short, no stop) and amounts above the hard caps in the owner's own text.
 */
export function guardQuestions(text: string): string[] {
  const t = text.toLocaleLowerCase("tr-TR");
  const q: string[] = [];
  if (/kaldıraç|kaldirac|leverage|marjin|margin|vadeli|futures/.test(t)) q.push("Kaldıraç, marjin ve vadeli işlem desteklenmiyor; yalnızca kaldıraçsız spot alım kodlandı. Uygun mu?");
  if (/açığa sat|aciga sat|short|düşüşe oyna|düşüş yönlü/.test(t)) q.push("Açığa satış (short) desteklenmiyor; yalnızca alım (long) yapılabilir. Uygun mu?");
  if (/zarar[- ]?kes(siz| koyma| olmasın| istemiyorum)|stop(suz| koyma| olmasın)|stop[- ]?loss(suz| koyma| olmasın)/.test(t)) {
    q.push("Her alımda zarar-kes zorunludur; 'zarar-kes koyma' isteği kodlanmadı. Uygun mu?");
  }
  const amounts = [...t.matchAll(/(\d[\d.]*(?:,\d+)?)\s*(?:tl|try|₺)/g)].map((m) => Number(m[1]!.replace(/\./g, "").replace(",", ".")));
  if (amounts.some((a) => Number.isFinite(a) && a > Number(HARD_MAX_ORDER_QUOTE))) {
    q.push(`Metindeki tutar üst sınırı aşıyor: işlem başına en fazla ${HARD_MAX_ORDER_QUOTE} TL, günlük risk en fazla ${HARD_MAX_DAILY_RISK} TL olabilir; aşan değer sınıra çekildi. Uygun mu?`);
  }
  return q;
}

/** A plain Turkish summary built from the validated policy (used when the model leaves summaryTr empty). */
export function summaryFromPolicy(p: Policy): string {
  const until = isoIstanbul(p.validUntil).slice(0, 16).replace("T", " ");
  return (
    `Yalnızca ${p.instIds.join(", ")} spot alım. İşlem başına en fazla ${p.maxOrderQuote} TL, günlük risk bütçesi ${p.dailyRiskBudgetQuote} TL. ` +
    `Saatte en fazla ${p.maxTradesPerHour}, günde en fazla ${p.maxTradesPerDay} işlem; her alımda zarar-kes %${p.minStopDistancePct}–%${p.maxStopDistancePct}, ` +
    `pozisyon en fazla ${p.maxHoldMin} dakika. Kurallar ${until}'e kadar geçerli.`
  );
}

export async function validateDraft(
  draft: z.infer<typeof DraftSchema>,
  text: string,
  nowMs: number,
  instrument: PolicyParserDeps["instrument"],
): Promise<{ policy: Policy; errors: string[]; questions: string[] }> {
  const def = defaultPolicy(nowMs);
  const errors: string[] = [];
  const questions: string[] = [];
  const policy: Policy = {
    instIds: (draft.instIds ?? def.instIds).map((s) => s.trim().toUpperCase()),
    maxOrderQuote: str(draft.maxOrderQuote) ?? def.maxOrderQuote,
    dailyRiskBudgetQuote: str(draft.dailyRiskBudgetQuote) ?? def.dailyRiskBudgetQuote,
    maxTradesPerHour: draft.maxTradesPerHour ?? def.maxTradesPerHour,
    maxTradesPerDay: draft.maxTradesPerDay ?? def.maxTradesPerDay,
    minStopDistancePct: str(draft.minStopDistancePct) ?? def.minStopDistancePct,
    maxStopDistancePct: str(draft.maxStopDistancePct) ?? def.maxStopDistancePct,
    maxHoldMin: draft.maxHoldMin ?? def.maxHoldMin,
    feeBps: draft.feeBps ?? def.feeBps,
    slippageBps: draft.slippageBps ?? def.slippageBps,
    validUntil: def.validUntil,
    sourceText: text,
  };
  // Hard caps: cap and ask (Appendix D), never exceed.
  try {
    if (D(policy.maxOrderQuote).gt(HARD_MAX_ORDER_QUOTE)) {
      policy.maxOrderQuote = HARD_MAX_ORDER_QUOTE;
      questions.push(`İşlem başına en fazla ${HARD_MAX_ORDER_QUOTE} TL olabilir; ${HARD_MAX_ORDER_QUOTE} TL'ye düşürüldü.`);
    }
    if (D(policy.dailyRiskBudgetQuote).gt(HARD_MAX_DAILY_RISK)) {
      policy.dailyRiskBudgetQuote = HARD_MAX_DAILY_RISK;
      questions.push(`Günlük risk bütçesi en fazla ${HARD_MAX_DAILY_RISK} TL olabilir; ${HARD_MAX_DAILY_RISK} TL'ye düşürüldü.`);
    }
  } catch {
    // non-numeric values are reported by the schema below
  }
  // validUntil: ISO → ms, whole second, in the future, within 7 days.
  if (draft.validUntilIso !== undefined) {
    const ms = Date.parse(draft.validUntilIso);
    if (!Number.isFinite(ms)) errors.push(`Geçerlilik tarihi okunamadı: ${draft.validUntilIso}`);
    else if (ms % 1000 !== 0) errors.push("Geçerlilik tarihi tam saniye olmalı.");
    else if (ms <= nowMs) errors.push("Geçerlilik tarihi geçmişte.");
    else if (ms > nowMs + MAX_VALID_DAYS * 86_400_000) errors.push(`Geçerlilik en fazla ${MAX_VALID_DAYS} gün olabilir.`);
    else policy.validUntil = ms;
  }
  // zod and the §9.1 ranges (incl. min < max stop, perDay ≥ perHour, Pct2, ≤ 8 decimals).
  const parsed = PolicySchema.safeParse(policy);
  if (!parsed.success) for (const i of parsed.error.issues) errors.push(`${i.path.join(".") || "policy"}: ${i.message}`);
  // Live SPOT instruments (spec read).
  for (const instId of policy.instIds) {
    let spec: InstrumentSpec | null = null;
    try {
      spec = await instrument(instId);
    } catch {
      spec = null;
    }
    if (!spec) errors.push(`${instId}: OKX TR'de bulunamadı.`);
    else if (spec.state !== "live") errors.push(`${instId}: şu an işleme kapalı (${spec.state}).`);
  }
  return { policy, errors, questions };
}

export const RETRY_NUDGE = `Call the ${"propose_policy"} tool now, exactly once, with every field. Do not answer in plain text.`;

/** The first JSON object in a text answer (models that answer in text instead of calling the tool). */
export function jsonFromText(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * The model's draft: the propose_policy call; if the model answered in text, one retry with a clear instruction;
 * then a JSON object in the text. Everything is validated in code afterwards, whichever way it arrived.
 */
async function draftInput(deps: PolicyParserDeps, req: LlmRequest, signal: AbortSignal): Promise<unknown> {
  const toolInput = (r: Awaited<ReturnType<LlmClient["create"]>>): unknown | undefined =>
    r.content.find((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use" && b.name === PROPOSE_POLICY)?.input;
  const textOf = (r: Awaited<ReturnType<LlmClient["create"]>>): string =>
    r.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  const first = await deps.llm.create(req, signal);
  const a = toolInput(first);
  if (a !== undefined) return a;
  const firstText = textOf(first);
  const retry = await deps.llm.create(
    {
      ...req,
      messages: [
        ...req.messages,
        ...(firstText.trim() ? [{ role: "assistant" as const, content: firstText }] : []),
        { role: "user" as const, content: RETRY_NUDGE },
      ],
    },
    signal,
  );
  const b = toolInput(retry);
  if (b !== undefined) return b;
  const fromText = jsonFromText(textOf(retry)) ?? jsonFromText(firstText);
  if (fromText !== null) return fromText;
  throw new Error("the model did not call propose_policy");
}

export function makePolicyParser(deps: PolicyParserDeps): (text: string, ctx: { nowMs: number }) => Promise<Omit<PolicyProposal, "id">> {
  return async (textIn, { nowMs }) => {
    const text = textIn.trim();
    if (text.length === 0 || text.length > MAX_TEXT_CHARS) throw new Error(`text must be 1–${MAX_TEXT_CHARS} characters`);
    const user = `Today is ${isoIstanbul(nowMs)} (Europe/Istanbul). The owner wrote:\n"""\n${text}\n"""`;
    const req: LlmRequest = {
      system: POLICY_PARSER_PROMPT,
      tools: [PROPOSE_POLICY_DEF],
      messages: [{ role: "user", content: user }],
      toolChoice: { type: "tool", name: PROPOSE_POLICY },
      maxTokens: 2000,
    };
    const signal = AbortSignal.timeout(deps.timeoutMs ?? 90_000);
    const input = await draftInput(deps, req, signal);
    const draft = DraftSchema.safeParse(input);
    if (!draft.success) throw new Error(`propose_policy input invalid: ${draft.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    const v = await validateDraft(draft.data, text, nowMs, deps.instrument);
    return {
      policy: v.policy,
      summaryTr: clip(draft.data.summaryTr.trim() || summaryFromPolicy(v.policy), 600),
      mapping: draft.data.mapping.slice(0, 20).map((m) => ({ phrase: clip(m.phrase, 200), field: clip(m.field, 40), value: clip(String(m.value), 80) })),
      assumptions: draft.data.assumptions.slice(0, 15).map((a) => clip(a, 300)),
      questions: [...new Set([...draft.data.questions.slice(0, 10).map((q) => clip(q, 300)), ...v.questions, ...guardQuestions(text)])],
      errors: v.errors,
    };
  };
}

