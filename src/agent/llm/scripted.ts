// Scripted LLM (SPEC §10.5): replays fixture turns as tool-use responses. No network, no API key.
// Fixture values may be relative and are resolved at call time:
//   { "pctOfAsk": "-1.2" }          → ask × (1 − 1.2/100), from resolver.indicators(instId)
//   { "pctOfStop": "0.5" }          → current stop × (1 + 0.5/100), from resolver.currentStopPx(instId)
//   { "validUntilInHours": 24 }     → now + 24 h as a whole second (ISO +03:00 for keys ending in "Iso", else ms)
//   { "suggested": "stopPx" }       → the current suggested level from get_indicators
//   { "r1Pair": true }              → the red-team <R1_PAIR> (decided by Track B; a parameter here)
// Price rounding: keys containing "stop" round DOWN to the tick; TPs, limits and everything else round UP.
import { z } from "zod";
import type { Clock, LlmClient, LlmRequest } from "../../shared/interfaces.js";
import { ceilToTick, D, floorToTick, toDecString } from "../../shared/money.js";
import { PDec, type LlmResponse } from "../../shared/schemas.js";
import { isoIstanbul } from "../../shared/time.js";
import { SUBMIT_DECISION } from "../tools.js";

export const ScriptBlockSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("tool_use"), id: z.string().optional(), name: z.string(), input: z.unknown() }),
]);
export const ScriptTurnSchema = z.object({ _step: z.string().optional(), content: z.array(ScriptBlockSchema) });
export const ScriptFileSchema = z.object({ _comment: z.string().optional(), turns: z.array(ScriptTurnSchema) });
export type ScriptBlock = z.infer<typeof ScriptBlockSchema>;
export type ScriptTurn = z.infer<typeof ScriptTurnSchema>;

const IndicatorsView = z.looseObject({
  ask: PDec,
  tickSz: PDec,
  suggested: z.record(z.string(), z.string()),
});

export interface ScriptResolver {
  clock: Clock;
  /** AgentDeps.indicators: needs ask, tickSz and suggested. */
  indicators?(instId: string): Promise<object>;
  /** The open position's current (approved) stop for instId, or null. */
  currentStopPx?(instId: string): Promise<string | null> | string | null;
  r1Pair?: string;
  /** Used when a tool input has no instId. */
  defaultInstId?: string;
}

export class ScriptError extends Error {
  override name = "ScriptError";
}

/** The safe default when the script runs out: HOLD. */
export function holdDecision(instId: string): Record<string, unknown> {
  return {
    action: "HOLD",
    instId,
    regime: "UNCLEAR",
    playbook: "STAND_ASIDE",
    evidence: ["Senaryo bitti: varsayılan karar"],
    scenarios: { bull: "-", bear: "-" },
    thesis: "Senaryo bitti; bekle.",
    invalidation: "-",
    confidence: 0,
    nextCheckInMin: 15,
  };
}

const isStopKey = (key: string): boolean => /stop/i.test(key);
const roundPx = (key: string, px: string, tickSz: string): string => (isStopKey(key) ? floorToTick(px, tickSz) : ceilToTick(px, tickSz));
const addPct = (x: string, pct: string): string => toDecString(D(x).mul(D(pct).div(100).add(1)));

type Rel = { pctOfAsk: string } | { pctOfStop: string } | { validUntilInHours: number } | { suggested: string } | { r1Pair: true };

function relKind(v: unknown): Rel | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1) return null;
  const k = keys[0];
  return k === "pctOfAsk" || k === "pctOfStop" || k === "validUntilInHours" || k === "suggested" || k === "r1Pair" ? (v as Rel) : null;
}

export class ScriptedLlm implements LlmClient {
  readonly model: string;
  private turns: ScriptTurn[];
  private n = 0;
  readonly requests: LlmRequest[] = [];

  constructor(turns: readonly ScriptTurn[], private readonly resolver: ScriptResolver, opts: { model?: string } = {}) {
    this.turns = turns.map((t) => ScriptTurnSchema.parse(t));
    this.model = opts.model ?? "scripted";
  }

  static fromFile(json: unknown, resolver: ScriptResolver, opts: { model?: string } = {}): ScriptedLlm {
    return new ScriptedLlm(ScriptFileSchema.parse(json).turns, resolver, opts);
  }

  remaining(): number {
    return this.turns.length;
  }

  async create(req: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    this.requests.push(req);
    const turn = this.turns.shift();
    const blocks: ScriptBlock[] = turn
      ? turn.content
      : req.tools.some((t) => t.name === SUBMIT_DECISION)
        ? [{ type: "tool_use", name: SUBMIT_DECISION, input: holdDecision(this.resolver.defaultInstId ?? "AVAX-TRY") }]
        : [{ type: "text", text: "" }];
    const content: LlmResponse["content"] = [];
    for (const b of blocks) {
      if (b.type === "text") content.push(b);
      else content.push({ type: "tool_use", id: b.id ?? `toolu_scripted_${++this.n}`, name: b.name, input: await this.resolveInput(b.input) });
    }
    return { content, stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", model: this.model };
  }

  private async resolveInput(input: unknown): Promise<unknown> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
    const obj = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // instId first: other relative values depend on it.
    const instIdRaw = obj.instId;
    const instIdRel = relKind(instIdRaw);
    if (instIdRel && "r1Pair" in instIdRel) {
      if (!this.resolver.r1Pair) throw new ScriptError("fixture uses r1Pair but no r1Pair was configured");
      out.instId = this.resolver.r1Pair;
    } else if (instIdRaw !== undefined) {
      out.instId = instIdRaw;
    }
    const instId = typeof out.instId === "string" ? out.instId : (this.resolver.defaultInstId ?? "AVAX-TRY");
    let ind: z.infer<typeof IndicatorsView> | null = null;
    const indicators = async (): Promise<z.infer<typeof IndicatorsView>> => {
      if (!this.resolver.indicators) throw new ScriptError("fixture needs indicators but none were provided");
      ind ??= IndicatorsView.parse(await this.resolver.indicators(instId));
      return ind;
    };
    for (const [key, v] of Object.entries(obj)) {
      if (key === "instId") continue;
      const rel = relKind(v);
      if (!rel) {
        out[key] = v;
      } else if ("pctOfAsk" in rel) {
        const i = await indicators();
        out[key] = roundPx(key, addPct(i.ask, rel.pctOfAsk), i.tickSz);
      } else if ("pctOfStop" in rel) {
        const i = await indicators();
        const stop = await this.resolver.currentStopPx?.(instId);
        if (!stop) throw new ScriptError(`fixture uses pctOfStop but ${instId} has no current stop`);
        out[key] = roundPx(key, addPct(stop, rel.pctOfStop), i.tickSz);
      } else if ("validUntilInHours" in rel) {
        const ms = Math.floor((this.resolver.clock.now() + rel.validUntilInHours * 3_600_000) / 1000) * 1000;
        out[key] = key.endsWith("Iso") ? isoIstanbul(ms) : ms;
      } else if ("suggested" in rel) {
        const level = (await indicators()).suggested[rel.suggested];
        if (level === undefined) throw new ScriptError(`no suggested level "${rel.suggested}"`);
        out[key] = level;
      } else {
        if (!this.resolver.r1Pair) throw new ScriptError("fixture uses r1Pair but no r1Pair was configured");
        out[key] = this.resolver.r1Pair;
      }
    }
    return out;
  }
}
