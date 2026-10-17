import { describe, expect, it } from "vitest";
import type { LlmRequest } from "../../shared/interfaces.js";
import { SimClock } from "../../shared/time.js";
import { LOCAL_TOOL_DEFS, SUBMIT_DECISION, SUBMIT_DECISION_DEF } from "../tools.js";
import { AnthropicLlm, toParams } from "./anthropic.js";

const req = (forced: boolean): LlmRequest => ({
  system: "S",
  tools: [LOCAL_TOOL_DEFS.get_indicators, SUBMIT_DECISION_DEF],
  messages: [{ role: "user", content: "C" }],
  toolChoice: forced ? { type: "tool", name: SUBMIT_DECISION } : { type: "auto" },
  maxTokens: 2000,
});

describe("anthropic client (no network)", () => {
  it("forced tool → auto with only that tool; Sonnet 5.5 gets between_tools thinking", () => {
    const p = toParams(req(true), "claude-sonnet-5-5");
    expect(p.tool_choice).toEqual({ type: "auto" });
    expect(p.tools?.map((t) => ("name" in t ? t.name : ""))).toEqual([SUBMIT_DECISION]);
    expect(p.thinking).toEqual({ type: "between_tools" });
    expect(toParams(req(false), "claude-opus-5-5").thinking).toBeUndefined();
    expect(toParams(req(false), "claude-opus-5-5").tools).toHaveLength(2);
  });

  it("retries once after a 5xx-like failure", async () => {
    let calls = 0;
    const client = {
      messages: {
        create: async () => {
          if (++calls === 1) throw new Error("socket hang up");
          return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", model: "claude-sonnet-5-5" };
        },
      },
    } as unknown as ConstructorParameters<typeof AnthropicLlm>[0]["client"];
    const llm = new AnthropicLlm({ model: "claude-sonnet-5-5", clock: new SimClock(0, { autoAdvance: true }), client });
    const r = await llm.create(req(false), new AbortController().signal);
    expect(calls).toBe(2);
    expect(r).toEqual({ content: [{ type: "text", text: "ok" }], stopReason: "end_turn", model: "claude-sonnet-5-5" });
  });
});
