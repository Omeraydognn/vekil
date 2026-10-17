import { describe, expect, it } from "vitest";
import type { LlmRequest } from "../../shared/interfaces.js";
import { SimClock } from "../../shared/time.js";
import { OpenRouterLlm, toOpenAiMessages } from "./openrouter.js";

const tool = { name: "submit_decision", description: "d", input_schema: { type: "object", properties: {} } };
const other = { name: "get_indicators", description: "i", input_schema: { type: "object", properties: {} } };

function fakeFetch(responses: { status: number; body: unknown }[], seen: Record<string, unknown>[]): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body)));
    const r = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const ok = (msg: Record<string, unknown>) => ({ status: 200, body: { model: "x/y:free", choices: [{ finish_reason: "stop", message: msg }] } });

describe("OpenRouterLlm", () => {
  it("translates Anthropic tool_use/tool_result history to OpenAI messages", () => {
    const m = toOpenAiMessages("SYS", [
      { role: "user", content: "cycle" },
      { role: "assistant", content: [{ type: "text", text: "bakıyorum" }, { type: "tool_use", id: "t1", name: "get_indicators", input: { instId: "AVAX-TRY" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{\"ask\":\"494\"}" }] },
    ]);
    expect(m).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "cycle" },
      { role: "assistant", content: "bakıyorum", tool_calls: [{ id: "t1", type: "function", function: { name: "get_indicators", arguments: "{\"instId\":\"AVAX-TRY\"}" } }] },
      { role: "tool", tool_call_id: "t1", content: "{\"ask\":\"494\"}" },
    ]);
  });

  it("returns tool calls as tool_use blocks; a forced tool is offered alone with tool_choice required", async () => {
    const seen: Record<string, unknown>[] = [];
    const llm = new OpenRouterLlm({
      model: "x/y:free", apiKey: "k", clock: new SimClock(0, { autoAdvance: true }),
      fetchImpl: fakeFetch([ok({ content: null, tool_calls: [{ id: "c1", function: { name: "submit_decision", arguments: "{\"action\":\"HOLD\"}" } }] })], seen),
    });
    const req: LlmRequest = { system: "S", tools: [other, tool], messages: [{ role: "user", content: "go" }], toolChoice: { type: "tool", name: "submit_decision" }, maxTokens: 100 };
    const r = await llm.create(req, new AbortController().signal);
    expect(r.content).toEqual([{ type: "tool_use", id: "c1", name: "submit_decision", input: { action: "HOLD" } }]);
    expect(seen[0]).toMatchObject({ model: "x/y:free", tool_choice: "required" });
    expect((seen[0]!.tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual(["submit_decision"]);
  });

  it("falls back to tool_choice auto on a 400, retries once on 429, and keeps bad JSON args as a raw string", async () => {
    const seen: Record<string, unknown>[] = [];
    const llm = new OpenRouterLlm({
      model: "x/y:free", apiKey: "k", clock: new SimClock(0, { autoAdvance: true }),
      fetchImpl: fakeFetch([
        { status: 400, body: { error: { message: "tool_choice required unsupported" } } },
        { status: 429, body: { error: { message: "rate limited" } } },
        { status: 400, body: { error: { message: "again" } } },
        ok({ content: "", tool_calls: [{ function: { name: "submit_decision", arguments: "{bad" } }] }),
      ], seen),
    });
    const req: LlmRequest = { system: "S", tools: [tool], messages: [{ role: "user", content: "go" }], toolChoice: { type: "tool", name: "submit_decision" }, maxTokens: 100 };
    const r = await llm.create(req, new AbortController().signal);
    expect(seen.map((b) => b.tool_choice)).toEqual(["required", "auto", "required", "auto"]);
    expect(r.content[0]).toMatchObject({ type: "tool_use", name: "submit_decision", input: "{bad" });
  });

  it("uses LLM_BASE_URL for an OpenAI-compatible gateway", async () => {
    const urls: string[] = [];
    const f = (async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as typeof fetch;
    const llm = new OpenRouterLlm({ model: "m", apiKey: "k", baseUrl: "https://gw.example/v1/", clock: new SimClock(0), fetchImpl: f });
    await llm.create({ system: "S", tools: [], messages: [{ role: "user", content: "x" }], toolChoice: { type: "auto" }, maxTokens: 10 }, new AbortController().signal);
    expect(urls).toEqual(["https://gw.example/v1/chat/completions"]);
  });

  it("a comma-separated LLM_MODEL becomes OpenRouter's fallback list", async () => {
    const seen: Record<string, unknown>[] = [];
    const llm = new OpenRouterLlm({ model: "a/x:free, b/y:free", apiKey: "k", clock: new SimClock(0), fetchImpl: fakeFetch([ok({ content: "ok" })], seen) });
    await llm.create({ system: "S", tools: [], messages: [{ role: "user", content: "x" }], toolChoice: { type: "auto" }, maxTokens: 10 }, new AbortController().signal);
    expect(seen[0]).toMatchObject({ model: "a/x:free", models: ["a/x:free", "b/y:free"] });
  });

  it("an empty or keep-alive-padded 200 is retried, then parsed", async () => {
    const seen: Record<string, unknown>[] = [];
    let n = 0;
    const f = (async (_u: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      n++;
      const body = n === 1 ? "" : `: OPENROUTER PROCESSING\n\n${JSON.stringify({ choices: [{ message: { content: "tamam" } }] })}`;
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const llm = new OpenRouterLlm({ model: "a/x:free", apiKey: "k", clock: new SimClock(0, { autoAdvance: true }), fetchImpl: f });
    const r = await llm.create({ system: "S", tools: [], messages: [{ role: "user", content: "x" }], toolChoice: { type: "auto" }, maxTokens: 10 }, new AbortController().signal);
    expect(r.content).toEqual([{ type: "text", text: "tamam" }]);
    expect(seen).toHaveLength(2);
  });

  it("does not retry a 401", async () => {
    const seen: Record<string, unknown>[] = [];
    const llm = new OpenRouterLlm({ model: "x/y", apiKey: "bad", clock: new SimClock(0, { autoAdvance: true }), fetchImpl: fakeFetch([{ status: 401, body: { error: { message: "No auth" } } }], seen) });
    await expect(llm.create({ system: "S", tools: [], messages: [{ role: "user", content: "x" }], toolChoice: { type: "auto" }, maxTokens: 10 }, new AbortController().signal)).rejects.toThrow(/No auth/);
    expect(seen).toHaveLength(1);
  });
});
