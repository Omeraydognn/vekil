// Anthropic Messages API client (SPEC §10.5). Model from config (LLM_MODEL). Retry once after 2 s if the
// deadline allows. No temperature setting.
// Model notes (claude-api skill): Claude Sonnet 5.5 / Opus 5.5 / Fable 5.1 reject forced tool_choice with a 400,
// so a forced { type: "tool", name } is sent as tool_choice auto with ONLY that tool offered. Sonnet 5.5 rejects
// thinking "disabled"; "between_tools" is its lowest setting (no extended thinking). Thinking blocks are not
// replayed (LlmResponse carries text and tool_use only), so the history-editing check never applies.
import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import type { Clock, LlmClient, LlmRequest } from "../../shared/interfaces.js";
import type { LlmResponse } from "../../shared/schemas.js";

export const RETRY_DELAY_MS = 2_000;

export interface AnthropicLlmOptions {
  model: string;
  apiKey?: string;
  clock: Clock;
  /** For tests: an object with the same messages.create shape. */
  client?: Pick<Anthropic, "messages">;
}

/** Translate our LlmRequest into Messages API params for `model`. */
export function toParams(req: LlmRequest, model: string): MessageCreateParamsNonStreaming {
  const forced = req.toolChoice.type === "tool" ? req.toolChoice.name : null;
  const tools = (forced ? req.tools.filter((t) => t.name === forced) : req.tools).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }));
  const params: MessageCreateParamsNonStreaming = {
    model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: req.messages,
    tools,
    tool_choice: { type: "auto" },
  };
  if (model.startsWith("claude-sonnet-5-5")) params.thinking = { type: "between_tools" };
  return params;
}

export function fromMessage(msg: Anthropic.Message): LlmResponse {
  const content: LlmResponse["content"] = [];
  for (const b of msg.content) {
    if (b.type === "text") content.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
  }
  return { content, stopReason: msg.stop_reason ?? "unknown", model: msg.model };
}

export class AnthropicLlm implements LlmClient {
  private readonly client: Pick<Anthropic, "messages">;
  constructor(private readonly opts: AnthropicLlmOptions) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 0 });
  }

  async create(req: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    const params = toParams(req, this.opts.model);
    try {
      return fromMessage(await this.client.messages.create(params, { signal }));
    } catch (e) {
      if (signal.aborted) throw e;
      // 4xx other than 408/409/429 will not get better on retry.
      if (e instanceof Anthropic.APIError && e.status !== undefined && e.status < 500 && ![408, 409, 429].includes(e.status)) throw e;
      await this.opts.clock.sleep(RETRY_DELAY_MS);
      if (signal.aborted) throw e;
      return fromMessage(await this.client.messages.create(params, { signal }));
    }
  }
}
