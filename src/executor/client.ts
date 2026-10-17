// ExecutorApi clients (SPEC §9.9): HTTP (paper/live, separate process) and in-process (fake). Same semantics:
// every response is validated with zod and returned as a fresh copy.
import { z } from "zod";
import type { ExecutorApi } from "../shared/interfaces.js";
import type { ExitReason } from "../shared/reasons.js";
import {
  AccountSnapshotSchema,
  ExecResultSchema,
  ExecutorEventSchema,
  ExecutorHealthSchema,
  OrderStateSchema,
  type AccountSnapshot,
  type ExecResult,
  type ExecutorEvent,
  type ExecutorHealth,
  type Hex32,
  type OrderRequest,
  type OrderState,
  type PDec,
} from "../shared/schemas.js";
import type { Executor } from "./executor.js";

export class ExecutorHttpError extends Error {
  override name = "ExecutorHttpError";
}

export class HttpExecutorClient implements ExecutorApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 30_000,
  ) {}

  private async call<T extends z.ZodType>(method: "GET" | "POST", path: string, schema: T, body?: unknown): Promise<z.infer<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "x-executor-token": this.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new ExecutorHttpError(`${method} ${path}: ${res.status} ${(json as { error?: string } | null)?.error ?? ""}`);
    return schema.parse(json);
  }

  health(): Promise<ExecutorHealth> {
    return this.call("GET", "/health", ExecutorHealthSchema);
  }
  account(instId: string): Promise<AccountSnapshot> {
    return this.call("GET", `/account?instId=${encodeURIComponent(instId)}`, AccountSnapshotSchema);
  }
  orders(instIds: string[], sinceMs: number): Promise<OrderState[]> {
    return this.call("GET", `/orders?instIds=${encodeURIComponent(instIds.join(","))}&since=${sinceMs}`, z.array(OrderStateSchema));
  }
  execute(req: OrderRequest, orderHash: Hex32): Promise<ExecResult> {
    return this.call("POST", "/execute", ExecResultSchema, { req, orderHash });
  }
  adjust(entryOrderHash: Hex32, newStopPx?: PDec, newTpPx?: PDec): Promise<ExecResult> {
    return this.call("POST", "/adjust", ExecResultSchema, { entryOrderHash, ...(newStopPx ? { newStopPx } : {}), ...(newTpPx ? { newTpPx } : {}) });
  }
  exit(entryOrderHash: Hex32, reason: ExitReason): Promise<ExecResult> {
    return this.call("POST", "/exit", ExecResultSchema, { entryOrderHash, reason });
  }
  async halt(): Promise<void> {
    await this.call("POST", "/halt", z.object({ ok: z.literal(true) }));
  }
  async cancelAll(by: "kill" | "api"): Promise<string[]> {
    return (await this.call("POST", "/cancel-all", z.object({ cancelled: z.array(z.string()) }), { by })).cancelled;
  }
  events(sinceN: number): Promise<ExecutorEvent[]> {
    return this.call("GET", `/events?since=${sinceN}`, z.array(ExecutorEventSchema));
  }
}

/** Fake mode: the same executor.ts in-process, with responses validated like the HTTP client. */
export class InProcessExecutor implements ExecutorApi {
  constructor(readonly executor: Executor) {}
  async health(): Promise<ExecutorHealth> {
    return ExecutorHealthSchema.parse(await this.executor.health());
  }
  async account(instId: string): Promise<AccountSnapshot> {
    return AccountSnapshotSchema.parse(await this.executor.account(instId));
  }
  async orders(instIds: string[], sinceMs: number): Promise<OrderState[]> {
    return z.array(OrderStateSchema).parse(await this.executor.orders(instIds, sinceMs));
  }
  async execute(req: OrderRequest, orderHash: Hex32): Promise<ExecResult> {
    return ExecResultSchema.parse(await this.executor.execute(structuredClone(req), orderHash));
  }
  async adjust(entryOrderHash: Hex32, newStopPx?: PDec, newTpPx?: PDec): Promise<ExecResult> {
    return ExecResultSchema.parse(await this.executor.adjust(entryOrderHash, newStopPx, newTpPx));
  }
  async exit(entryOrderHash: Hex32, reason: ExitReason): Promise<ExecResult> {
    return ExecResultSchema.parse(await this.executor.exit(entryOrderHash, reason));
  }
  halt(): Promise<void> {
    return this.executor.halt();
  }
  cancelAll(by: "kill" | "api"): Promise<string[]> {
    return this.executor.cancelAll(by);
  }
  async events(sinceN: number): Promise<ExecutorEvent[]> {
    return z.array(ExecutorEventSchema).parse(await this.executor.events(sinceN));
  }
}
