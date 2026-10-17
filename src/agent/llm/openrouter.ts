// OpenRouter client (OpenAI-compatible chat completions over fetch; no extra dependency). The loop speaks Anthropic
// message shapes (tool_use / tool_result blocks), so requests and responses are translated here. Retry once after 2 s
// if the deadline allows. LLM_MODEL may list several models separated by commas (OpenRouter fallback). A forced tool is sent as tool_choice "required" with only that tool offered; if the provider
// rejects that, it is retried with "auto" (the loop and the parser handle a missing call).
import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";
import type { Clock, LlmClient, LlmRequest } from "../../shared/interfaces.js";
import type { LlmResponse } from "../../shared/schemas.js";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const RETRY_DELAY_MS = 2_000;

type OaMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

const ResponseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(z.object({ id: z.string().optional(), function: z.object({ name: z.string(), arguments: z.string().nullable().optional() }) }))
            .nullable()
            .optional(),
        }),
      }),
    )
    .min(1),
});

/** The JSON body, ignoring keep-alive comment lines (": OPENROUTER PROCESSING") and blank padding; null if none. */
export function parseBody(text: string): unknown | null {
  const cleaned = text
    .split("\n")
    .filter((l) => !l.startsWith(":"))
    .join("\n")
    .trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

export class OpenRouterError extends Error {
  override name = "OpenRouterError";
  // `message` never contains the key: only the provider's error text and the HTTP status.
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function textOf(content: string | ContentBlockParam[] | unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: { type?: string; text?: string }) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Anthropic-shaped history → OpenAI chat messages. */
export function toOpenAiMessages(system: string, messages: MessageParam[]): OaMessage[] {
  const out: OaMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
      const text = textOf(blocks);
      const calls = blocks
        .filter((b): b is Extract<ContentBlockParam, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    if (typeof m.content === "string") {
      out.push({ role: "user", content: m.content });
      continue;
    }
    const texts: string[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const body = typeof b.content === "string" ? b.content : textOf(b.content);
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${body}` : body });
      } else if (b.type === "text") texts.push(b.text);
    }
    if (texts.length) out.push({ role: "user", content: texts.join("\n") });
  }
  return out;
}

export function toBody(req: LlmRequest, model: string, forcedMode: "required" | "auto"): Record<string, unknown> {
  const forced = req.toolChoice.type === "tool" ? req.toolChoice.name : null;
  const tools = (forced ? req.tools.filter((t) => t.name === forced) : req.tools).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
  // "a/x:free,b/y:free" → OpenRouter tries them in order (its `models` fallback list).
  const models = model.split(",").map((m) => m.trim()).filter(Boolean);
  return {
    model: models[0] ?? model,
    ...(models.length > 1 ? { models } : {}),
    max_tokens: req.maxTokens,
    messages: toOpenAiMessages(req.system, req.messages),
    ...(tools.length ? { tools, tool_choice: forced ? forcedMode : "auto" } : {}),
  };
}

let callSeq = 0;
export function fromResponse(json: unknown, fallbackModel: string): LlmResponse {
  const r = ResponseSchema.parse(json);
  const choice = r.choices[0]!;
  const content: LlmResponse["content"] = [];
  if (choice.message.content && choice.message.content.trim()) content.push({ type: "text", text: choice.message.content });
  for (const c of choice.message.tool_calls ?? []) {
    let input: unknown = {};
    const raw = c.function.arguments ?? "";
    if (raw.trim()) {
      try {
        input = JSON.parse(raw);
      } catch {
        input = raw; // core's zod rejects it → INVALID_DECISION (never guessed)
      }
    }
    content.push({ type: "tool_use", id: c.id || `call_or_${++callSeq}`, name: c.function.name, input });
  }
  return { content, stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : (choice.finish_reason ?? "stop"), model: r.model ?? fallbackModel };
}

export interface OpenRouterOptions {
  model: string;
  apiKey: string;
  clock: Clock;
  /** An OpenAI-compatible base URL (LLM_BASE_URL, e.g. https://host/v1); default OpenRouter. */
  baseUrl?: string;
  /** For tests. */
  fetchImpl?: typeof fetch;
}

export class OpenRouterLlm implements LlmClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: OpenRouterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async post(body: Record<string, unknown>, signal: AbortSignal): Promise<LlmResponse> {
    const url = this.opts.baseUrl ? `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions` : OPENROUTER_URL;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json", "x-title": "VEKIL" },
      body: JSON.stringify(body),
      signal,
    });
    const json = parseBody(await res.text().catch(() => ""));
    if (!res.ok) {
      const msg = (json as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
      throw new OpenRouterError(res.status, `openrouter: ${msg}`);
    }
    if (json === null) throw new OpenRouterError(502, "openrouter: empty or non-JSON response");
    const err = (json as { error?: { message?: string } } | null)?.error;
    if (err) throw new OpenRouterError(502, `openrouter: ${err.message ?? "error"}`);
    try {
      return fromResponse(json, this.opts.model);
    } catch {
      throw new OpenRouterError(502, "openrouter: unexpected response shape");
    }
  }

  async create(req: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    const attempt = async (): Promise<LlmResponse> => {
      try {
        return await this.post(toBody(req, this.opts.model, "required"), signal);
      } catch (e) {
        // Some providers reject tool_choice "required": retry the same request with "auto".
        if (e instanceof OpenRouterError && e.status === 400 && req.toolChoice.type === "tool") return this.post(toBody(req, this.opts.model, "auto"), signal);
        throw e;
      }
    };
    try {
      return await attempt();
    } catch (e) {
      if (signal.aborted) throw e;
      if (e instanceof OpenRouterError && e.status < 500 && ![408, 409, 429].includes(e.status)) throw e;
      await this.opts.clock.sleep(RETRY_DELAY_MS);
      if (signal.aborted) throw e;
      return attempt();
    }
  }
}
