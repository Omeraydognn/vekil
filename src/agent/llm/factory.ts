// The real LLM for this config: anthropic (or an Anthropic-compatible gateway via LLM_BASE_URL) or openrouter (or any
// OpenAI-compatible gateway via LLM_BASE_URL). Scripted runs build their own ScriptedLlm.
import type { Config } from "../../shared/config.js";
import type { Clock, LlmClient } from "../../shared/interfaces.js";
import { AnthropicLlm } from "./anthropic.js";
import { OpenRouterLlm } from "./openrouter.js";

export function makeLlm(cfg: Config, clock: Clock): LlmClient {
  if (cfg.llmProvider === "openrouter") {
    if (!cfg.llm.apiKey) throw new Error("OPENROUTER_API_KEY is required");
    return new OpenRouterLlm({ model: cfg.llm.model, apiKey: cfg.llm.apiKey, clock, ...(cfg.llm.baseUrl ? { baseUrl: cfg.llm.baseUrl } : {}) });
  }
  if (cfg.llmProvider === "scripted") throw new Error("makeLlm: the scripted LLM is built from a fixture");
  return new AnthropicLlm({ model: cfg.llm.model, apiKey: cfg.llm.apiKey ?? undefined, clock, ...(cfg.llm.baseUrl ? { baseURL: cfg.llm.baseUrl } : {}) });
}
