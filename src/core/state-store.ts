// Atomic JSON state files (tmp + fsync + rename) and the data-dir binding check (SC13).
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";
import type { StateStore } from "../shared/interfaces.js";
import { AgentStateSchema, type AgentState, type Mode } from "../shared/schemas.js";
import { dayKey } from "../shared/time.js";

export class StateFileError extends Error {
  override name = "StateFileError";
}

export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export class JsonStateStore<T> implements StateStore<T> {
  constructor(
    private readonly path: string,
    private readonly schema: z.ZodType<T>,
  ) {}

  load(): T | null {
    if (!existsSync(this.path)) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (e) {
      throw new StateFileError(`${this.path}: unreadable JSON (${(e as Error).message})`);
    }
    const r = this.schema.safeParse(raw);
    if (!r.success) throw new StateFileError(`${this.path}: invalid (${r.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")})`);
    return r.data;
  }

  save(s: T): void {
    const r = this.schema.safeParse(s);
    if (!r.success) throw new StateFileError(`refusing to save invalid state: ${r.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
    writeFileAtomic(this.path, JSON.stringify(r.data, null, 2) + "\n");
  }
}

export const agentStateStore = (path: string): JsonStateStore<AgentState> => new JsonStateStore(path, AgentStateSchema);

export function initialAgentState(opts: { mode: Mode; chainId: number; policy: string | null; nowMs: number }): AgentState {
  return {
    mode: opts.mode,
    chainId: opts.chainId,
    policy: opts.policy,
    status: "RUNNING",
    haltReason: null,
    haltedAt: null,
    lastExecutorEventN: 0,
    lastLossExitAt: null,
    realizedPnlTodayQuote: "0",
    dayKey: dayKey(opts.nowMs),
    lastDecisions: [],
    lastLesson: null,
    pendingOwnerNote: null,
    nextCheckInAt: opts.nowMs,
  };
}

/** SC13: a data dir belongs to one (mode, chainId, policy address). Returns null when OK, else the mismatch. */
export function dataDirMismatch(s: AgentState, run: { mode: Mode; chainId: number; policy: string | null }): string | null {
  const diffs: string[] = [];
  if (s.mode !== run.mode) diffs.push(`mode ${s.mode} ≠ ${run.mode}`);
  if (s.chainId !== run.chainId) diffs.push(`chainId ${s.chainId} ≠ ${run.chainId}`);
  if (s.policy !== null && run.policy !== null && s.policy !== run.policy) diffs.push(`policy ${s.policy} ≠ ${run.policy}`);
  return diffs.length ? diffs.join(", ") : null;
}
