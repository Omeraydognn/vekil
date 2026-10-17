// The agent's tool surface (SPEC §10.3): local tools, allowlisted read-only ATK tools and submit_decision.
import { z } from "zod";
import { ACTIONS, PLAYBOOKS, REGIMES, type McpTool, type ToolDef } from "../shared/schemas.js";

export const SUBMIT_DECISION = "submit_decision";
export const LOCAL_TOOLS = ["get_agent_state", "get_indicators", "get_market_context"] as const;
export type LocalToolName = (typeof LOCAL_TOOLS)[number];

export const TOOL_TIMEOUT_MS = 10_000;
export const MAX_RESULT_CHARS = 6_000;
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const DEC_PATTERN = "^\\d+(\\.\\d+)?$";

const instIdInput = {
  type: "object",
  properties: { instId: { type: "string", description: 'Instrument, e.g. "AVAX-TRY".' } },
  required: ["instId"],
  additionalProperties: false,
};

export const LOCAL_TOOL_DEFS: Record<LocalToolName, ToolDef> = {
  get_agent_state: {
    name: "get_agent_state",
    description:
      "Your current state: open positions (approved stop/TP/time stop), today's PnL, on-chain counters (trades this hour/day, risk used vs budget), cooldown, and the on-chain policy summary and version.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  get_indicators: {
    name: "get_indicators",
    description:
      'Multi-timeframe indicators from confirmed candles: trend EMA20/EMA50 and state, entry-timeframe EMA20, RSI14, ATR14 and ATR%, the 24h range, the last 8 candles, and "suggested" entry/stop/TP levels that fit the on-chain policy.',
    input_schema: instIdInput,
  },
  get_market_context: {
    name: "get_market_context",
    description:
      "Market context: BTC-TRY trend and 24h change, top-20 order-book imbalance (bid/ask volume), trade flow over the last 200 trades (buy/sell volume), and 24h volume vs its average.",
    input_schema: instIdInput,
  },
};

const decStr = (description: string) => ({ type: "string", pattern: DEC_PATTERN, description });

/** The flat §9.3 schema. Zod in core is the real validator; this guides the model. */
export const SUBMIT_DECISION_DEF: ToolDef = {
  name: SUBMIT_DECISION,
  description:
    "Submit your one decision for this cycle (terminal). BUY needs quoteAmount and should carry stopPx/tpPx from the suggested levels. ADJUST_STOP needs newStopPx and/or newTpPx. Text fields are Turkish.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...ACTIONS] },
      instId: { type: "string", description: 'e.g. "AVAX-TRY"' },
      regime: { type: "string", enum: [...REGIMES] },
      playbook: { type: "string", enum: [...PLAYBOOKS] },
      evidence: { type: "array", items: { type: "string", maxLength: 140 }, minItems: 1, maxItems: 6, description: "Turkish; each cites a tool result" },
      scenarios: {
        type: "object",
        properties: { bull: { type: "string", maxLength: 200 }, bear: { type: "string", maxLength: 200 } },
        required: ["bull", "bear"],
      },
      thesis: { type: "string", minLength: 1, maxLength: 400 },
      invalidation: { type: "string", minLength: 1, maxLength: 300 },
      confidence: { type: "integer", minimum: 0, maximum: 100 },
      nextCheckInMin: { type: "integer", minimum: 0, maximum: 1440 },
      lesson: { type: "string", maxLength: 300 },
      quoteAmount: decStr("BUY: TRY to spend"),
      limitPx: decStr("BUY: optional limit price"),
      stopPx: decStr("BUY: stop-loss price"),
      tpPx: decStr("BUY: take-profit price"),
      timeStopMin: { type: "integer", minimum: 0, description: "BUY: time stop in minutes" },
      newStopPx: decStr("ADJUST_STOP: new (tighter) stop"),
      newTpPx: decStr("ADJUST_STOP: new take-profit"),
    },
    required: ["action", "instId", "regime", "playbook", "evidence", "scenarios", "thesis", "invalidation", "confidence", "nextCheckInMin"],
  },
};

export const InstIdArgs = z.object({ instId: z.string().min(1).max(32) });

/** Make an MCP tool name fit ^[a-zA-Z0-9_-]{1,64}$. */
export function sanitizeToolName(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return s.length > 0 ? s : "tool";
}

export type ResolvedTool =
  | { kind: "submit" }
  | { kind: "local"; name: LocalToolName }
  | { kind: "atk"; name: string /* the original MCP name */ };

export interface Toolset {
  defs: ToolDef[];
  /** null → unknown or not allowlisted. */
  resolve(name: string): ResolvedTool | null;
}

/**
 * Local tools + allowlisted ATK tools (schemas passed through unchanged) + submit_decision.
 * ATK names are sanitized and de-duplicated; a tool that is not in the allowlist is never listed or resolved.
 */
export function buildToolset(atkTools: readonly McpTool[], allowlist: readonly string[]): Toolset {
  const allowed = new Set(allowlist);
  const map = new Map<string, ResolvedTool>();
  map.set(SUBMIT_DECISION, { kind: "submit" });
  for (const n of LOCAL_TOOLS) map.set(n, { kind: "local", name: n });
  const defs: ToolDef[] = [...LOCAL_TOOLS.map((n) => LOCAL_TOOL_DEFS[n])];
  const sorted = [...atkTools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const t of sorted) {
    if (!allowed.has(t.name)) continue;
    let name = TOOL_NAME_RE.test(t.name) ? t.name : sanitizeToolName(t.name);
    for (let i = 2; map.has(name); i++) name = `${sanitizeToolName(t.name).slice(0, 60)}_${i}`;
    map.set(name, { kind: "atk", name: t.name });
    defs.push({ name, description: t.description ?? "", input_schema: t.inputSchema });
  }
  defs.push(SUBMIT_DECISION_DEF);
  return { defs, resolve: (n) => map.get(n) ?? null };
}

/** Results are cut to at most `max` characters in total, with the cut marked. */
export function truncateResult(s: string, max = MAX_RESULT_CHARS): string {
  if (s.length <= max) return s;
  const marker = (n: number): string => `\n…[TRUNCATED: ${n} more chars]`;
  let keep = max - marker(s.length).length;
  // The marker shrinks when the count loses digits: settle on the longest cut that fits.
  while (keep + 1 + marker(s.length - keep - 1).length <= max) keep++;
  return s.slice(0, keep) + marker(s.length - keep);
}

export class ToolTimeoutError extends Error {
  override name = "ToolTimeoutError";
}

/** Rejects after `ms` or when `signal` aborts, whichever comes first. */
export function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      reject(new ToolTimeoutError(`tool call timed out after ${ms} ms`));
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(t);
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
