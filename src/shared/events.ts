// SSE event types (SPEC §19) and an in-memory event bus.
import type { EventBus } from "./interfaces.js";

export const SSE_EVENT_TYPES = [
  "state",
  "cycle_start",
  "tool_call",
  "decision",
  "preflight",
  "chain_request",
  "execute",
  "fill",
  "exit",
  "exit_recorded",
  "adjust",
  "cancel",
  "pause_seen",
  "policy",
  "kill",
  "anchor",
  "verify",
  "audit",
  "alert",
  "redteam",
  "ask",
] as const;
export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

export interface VekilEvent {
  type: SseEventType;
  ts: number;
  cycleId?: string;
  test?: boolean;
  data: Record<string, unknown>;
}

export function makeEvent(
  type: SseEventType,
  ts: number,
  data: Record<string, unknown>,
  opts: { cycleId?: string | null; test?: boolean } = {},
): VekilEvent {
  const e: VekilEvent = { type, ts, data };
  if (opts.cycleId) e.cycleId = opts.cycleId;
  if (opts.test !== undefined) e.test = opts.test;
  return e;
}

/** Synchronous fan-out. A throwing subscriber never breaks emit() or other subscribers. */
export class InMemoryEventBus implements EventBus {
  private subs = new Set<(e: VekilEvent) => void>();

  emit(e: VekilEvent): void {
    for (const fn of [...this.subs]) {
      try {
        fn(e);
      } catch {
        // subscribers must not affect the pipeline
      }
    }
  }

  subscribe(fn: (e: VekilEvent) => void): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }
}
