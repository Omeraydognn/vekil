// Parsing of okx-trade-mcp tool results (ATK_NOTES §2). Every response is validated with zod (.passthrough-style
// loose objects); OKX numbers arrive as strings. Never coerce "" to 0: empty means missing.
import { z } from "zod";

/** Successful tool envelope: `{ tool, ok: true, data: { endpoint, requestTime, data }, capabilities, timestamp }`. */
const SuccessEnvelope = z.looseObject({
  tool: z.string(),
  ok: z.literal(true),
  data: z.looseObject({ data: z.unknown() }),
  capabilities: z.unknown().optional(),
});
/** Error envelope (isError): `{ tool, error: true, type, code?, message, suggestion?, capabilities }`. */
const ErrorEnvelope = z.looseObject({
  error: z.literal(true),
  type: z.string().optional(),
  code: z.string().optional(),
  message: z.string(),
});

export const CapabilitiesSchema = z.looseObject({
  readOnly: z.boolean(),
  hasAuth: z.boolean(),
  demo: z.boolean(),
  moduleAvailability: z.record(z.string(), z.looseObject({ status: z.string(), reasonCode: z.string().optional() })),
});
export type AtkCapabilities = z.infer<typeof CapabilitiesSchema>;

export class AtkToolError extends Error {
  override name = "AtkToolError";
  constructor(
    readonly tool: string,
    readonly code: string | null,
    message: string,
  ) {
    super(`${tool}: ${code ?? "ERROR"} ${message}`);
  }
}

/** Minimal shape of an MCP CallToolResult that we rely on. */
export interface RawToolResult {
  isError?: boolean;
  content?: unknown;
}

export function resultText(r: RawToolResult): string {
  const content = Array.isArray(r.content) ? r.content : [];
  const texts = content
    .filter((c): c is { type: "text"; text: string } => typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text" && typeof (c as { text?: unknown }).text === "string")
    .map((c) => c.text);
  return texts.join("");
}

function parseJson(tool: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AtkToolError(tool, "BAD_JSON", "tool result is not JSON");
  }
}

/** Returns the inner OKX `data` (usually an array). Throws AtkToolError on isError or a malformed envelope. */
export function unwrap(tool: string, text: string, isError = false): unknown {
  const json = parseJson(tool, text);
  if (isError) {
    const e = ErrorEnvelope.safeParse(json);
    throw new AtkToolError(tool, e.success ? (e.data.code ?? e.data.type ?? null) : null, e.success ? e.data.message : "tool error");
  }
  const ok = SuccessEnvelope.safeParse(json);
  if (!ok.success) {
    const e = ErrorEnvelope.safeParse(json);
    if (e.success) throw new AtkToolError(tool, e.data.code ?? e.data.type ?? null, e.data.message);
    throw new AtkToolError(tool, "BAD_ENVELOPE", "unexpected tool result shape");
  }
  return ok.data.data.data;
}

/** `system_get_capabilities` returns `{ ..., data: { server, capabilities } }`. */
export function parseCapabilities(text: string): { version: string | null; capabilities: AtkCapabilities } {
  const json = parseJson("system_get_capabilities", text);
  const env = z
    .looseObject({
      ok: z.literal(true),
      data: z.looseObject({ server: z.looseObject({ version: z.string() }).optional(), capabilities: CapabilitiesSchema }),
    })
    .safeParse(json);
  if (!env.success) throw new AtkToolError("system_get_capabilities", "BAD_ENVELOPE", "unexpected capabilities shape");
  return { version: env.data.data.server?.version ?? null, capabilities: env.data.data.capabilities };
}

// ---------------------------------------------------------------- OKX rows (strings)
const Num = z.string().regex(/^-?\d+(\.\d+)?$/);
const Pos = Num.refine((s) => !s.startsWith("-") && /[1-9]/.test(s), "must be > 0");
const NonNeg = Num.refine((s) => !s.startsWith("-"), "must be >= 0");
const Int = z.string().regex(/^\d+$/);

export const OkxTickerRow = z.looseObject({ instId: z.string(), last: Pos, bidPx: Pos, askPx: Pos, bidSz: NonNeg, askSz: NonNeg, ts: Int });
export const OkxInstrumentRow = z.looseObject({
  instId: z.string(),
  baseCcy: z.string(),
  quoteCcy: z.string(),
  tickSz: Pos,
  lotSz: Pos,
  minSz: Pos,
  state: z.string(),
});
const Level = z.tuple([Pos, NonNeg]).rest(z.string());
export const OkxBookRow = z.looseObject({ bids: z.array(Level), asks: z.array(Level), ts: Int });
/** [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm] */
export const OkxCandleRow = z.tuple([Int, Pos, Pos, Pos, Pos, NonNeg]).rest(z.string());
export const OkxTradeRow = z.looseObject({ px: Pos, sz: NonNeg, side: z.enum(["buy", "sell"]), ts: Int });
export const OkxOrderRow = z.looseObject({
  ordId: z.string(),
  clOrdId: z.string(),
  instId: z.string(),
  side: z.enum(["buy", "sell"]),
  px: z.string(),
  sz: Pos,
  state: z.string(),
  accFillSz: NonNeg,
  avgPx: z.string(),
  fee: z.string(),
  feeCcy: z.string(),
  cTime: Int,
});
/** spot_place_order / spot_cancel_order per-order ack; sCode "0" = accepted. */
export const OkxAckRow = z.looseObject({ ordId: z.string().optional(), clOrdId: z.string().optional(), sCode: z.string(), sMsg: z.string().optional() });

/** Parses `data` as an array of rows with the given schema; throws AtkToolError on any mismatch. */
export function rows<T extends z.ZodType>(tool: string, data: unknown, schema: T): z.infer<T>[] {
  const r = z.array(schema).safeParse(data);
  if (!r.success) throw new AtkToolError(tool, "BAD_DATA", r.error.issues[0]?.message ?? "invalid rows");
  return r.data;
}
