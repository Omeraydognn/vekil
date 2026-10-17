// The agent loop (SPEC §10.4). One AbortSignal covers the whole cycle; the result is a raw decision that core
// validates with zod. Budget: at most maxToolCalls tool calls including submit_decision.
import type { ContentBlockParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { makeEvent } from "../shared/events.js";
import { keccakUtf8 } from "../shared/hash.js";
import type { AgentDeps, Message, RunAgent } from "../shared/interfaces.js";
import type { LlmResponse, ToolTraceItem } from "../shared/schemas.js";
import { buildToolset, InstIdArgs, MAX_RESULT_CHARS, SUBMIT_DECISION, TOOL_TIMEOUT_MS, truncateResult, withTimeout, type Toolset } from "./tools.js";

export const NUDGE = "Call submit_decision now.";
export const BUDGET_EXHAUSTED = "tool budget exhausted";

export interface LoopOptions {
  /** LLM_MAX_TOOL_CALLS, including submit_decision. */
  maxToolCalls: number;
  toolTimeoutMs?: number;
  maxResultChars?: number;
  maxTokens?: number;
}

type ToolUse = Extract<LlmResponse["content"][number], { type: "tool_use" }>;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function argsJsonOf(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}) ?? "{}";
  } catch {
    return "{}";
  }
}

/** Assistant content as sent back to the API: empty text blocks are dropped (the API rejects them). */
function assistantContent(resp: LlmResponse): ContentBlockParam[] {
  const out: ContentBlockParam[] = [];
  for (const b of resp.content) {
    if (b.type === "text") {
      if (b.text.trim() !== "") out.push({ type: "text", text: b.text });
    } else {
      out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} });
    }
  }
  return out;
}

async function runLocalOrAtk(deps: AgentDeps, toolset: Toolset, u: ToolUse): Promise<string> {
  const r = toolset.resolve(u.name);
  if (r === null || r.kind === "submit") throw new Error(`unknown or not allowed tool: ${u.name}`);
  if (r.kind === "atk") return deps.atk.callTool(r.name, u.input ?? {});
  switch (r.name) {
    case "get_agent_state":
      return JSON.stringify(deps.agentState());
    case "get_indicators":
      return JSON.stringify(await deps.indicators(InstIdArgs.parse(u.input).instId));
    case "get_market_context":
      return JSON.stringify(await deps.marketContext(InstIdArgs.parse(u.input).instId));
  }
}

export function makeRunAgent(opts: LoopOptions): RunAgent {
  if (!Number.isInteger(opts.maxToolCalls) || opts.maxToolCalls < 1) throw new Error("maxToolCalls must be ≥ 1");
  const toolTimeoutMs = opts.toolTimeoutMs ?? TOOL_TIMEOUT_MS;
  const maxResultChars = opts.maxResultChars ?? MAX_RESULT_CHARS;
  const maxTokens = opts.maxTokens ?? 2000;

  return async (deps, system, cycleMessage, signal) => {
    const toolTrace: ToolTraceItem[] = [];
    let model = "unknown";
    let injected = false;

    const record = (name: string, argsJson: string, result: string, ms: number, ok: boolean, wasInjected: boolean): void => {
      const item: ToolTraceItem = { name, argsJson, argsHash: keccakUtf8(argsJson), resultHash: keccakUtf8(result), ms: Math.max(0, Math.round(ms)), ok };
      toolTrace.push(item);
      deps.bus.emit(
        makeEvent("tool_call", deps.clock.now(), {
          name,
          argsJson,
          ok,
          ms: item.ms,
          injected: wasInjected,
          naive: deps.profile === "naive",
          preview: result.slice(0, 300),
        }),
      );
    };

    const execute = async (toolset: Toolset, u: ToolUse): Promise<ToolResultBlockParam> => {
      const argsJson = argsJsonOf(u.input);
      const started = deps.clock.now();
      let content: string;
      let ok = true;
      try {
        content = truncateResult(await withTimeout(runLocalOrAtk(deps, toolset, u), toolTimeoutMs, signal), maxResultChars);
      } catch (e) {
        if (signal.aborted) throw e;
        ok = false;
        content = `ERROR: ${errMsg(e)}`;
      }
      // Red-team hook (§10.6): the injection text rides on the FIRST tool result of the cycle.
      let wasInjected = false;
      if (!injected && deps.injection) {
        content = `${content}\n\n${deps.injection}`;
        injected = wasInjected = true;
      }
      record(u.name, argsJson, content, deps.clock.now() - started, ok, wasInjected);
      return ok ? { type: "tool_result", tool_use_id: u.id, content } : { type: "tool_result", tool_use_id: u.id, content, is_error: true };
    };

    try {
      let atkTools: Awaited<ReturnType<AgentDeps["atk"]["listTools"]>> = [];
      try {
        atkTools = await deps.atk.listTools();
      } catch {
        atkTools = []; // the agent can still decide from the local tools; ATK calls are simply not offered
      }
      const toolset = buildToolset(atkTools, deps.allowlist);
      const messages: Message[] = [{ role: "user", content: cycleMessage }];
      let used = 0;

      for (;;) {
        if (signal.aborted) throw signal.reason ?? new Error("aborted");
        const remaining = opts.maxToolCalls - used;
        if (remaining <= 0) return { rawDecision: null, toolTrace, model, error: null };
        const toolChoice = remaining <= 1 ? ({ type: "tool", name: SUBMIT_DECISION } as const) : ({ type: "auto" } as const);
        const resp = await deps.llm.create({ system, tools: toolset.defs, messages, toolChoice, maxTokens }, signal);
        model = resp.model;

        const uses = resp.content.filter((b): b is ToolUse => b.type === "tool_use");
        const submit = uses.find((u) => u.name === SUBMIT_DECISION);
        if (submit) {
          const argsJson = argsJsonOf(submit.input);
          record(SUBMIT_DECISION, argsJson, argsJson, 0, true, false);
          return { rawDecision: submit.input ?? null, toolTrace, model, error: null };
        }

        if (uses.length > 0) {
          const allowed = Math.max(0, remaining - 1); // one call stays reserved for submit_decision
          const results: ToolResultBlockParam[] = [];
          let executed = 0;
          for (const [i, u] of uses.entries()) {
            if (i < allowed) {
              results.push(await execute(toolset, u));
              executed++;
            } else {
              record(u.name, argsJsonOf(u.input), BUDGET_EXHAUSTED, 0, false, false);
              results.push({ type: "tool_result", tool_use_id: u.id, content: BUDGET_EXHAUSTED, is_error: true });
            }
          }
          // Counting executed calls keeps the last slot for submit_decision; ≥ 1 guarantees the loop ends
          // even if a forced turn comes back with another tool.
          used += Math.max(1, executed);
          messages.push({ role: "assistant", content: assistantContent(resp) });
          messages.push({ role: "user", content: results });
        } else {
          const content = assistantContent(resp);
          if (content.length > 0) messages.push({ role: "assistant", content });
          messages.push({ role: "user", content: NUDGE });
          used += 1;
        }
      }
    } catch (e) {
      return { rawDecision: null, toolTrace, model, error: signal.aborted ? `aborted: ${errMsg(signal.reason ?? e)}` : errMsg(e) };
    }
  };
}
