// Executor state persistence: $DATA_DIR/executor-state.json, atomic (tmp + fsync + rename). Kept inside src/executor
// so the isolated process depends on nothing from core.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { z } from "zod";
import { dirname, join } from "node:path";
import type { StateStore } from "../shared/interfaces.js";
import { ExecutorStateSchema, Hex32, OrderRequestSchema, type ExecutorState } from "../shared/schemas.js";
import type { PendingEntry } from "./executor.js";

export const executorStatePath = (dataDir: string): string => join(dataDir, "executor-state.json");

export class ExecutorStateStore implements StateStore<ExecutorState> {
  constructor(private readonly path: string) {}

  load(): ExecutorState | null {
    if (!existsSync(this.path)) return null;
    return ExecutorStateSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
  }

  save(s: ExecutorState): void {
    const data = ExecutorStateSchema.parse(s);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(data));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }
}

export class MemoryStateStore<T> implements StateStore<T> {
  private v: T | null = null;
  load(): T | null {
    return this.v === null ? null : structuredClone(this.v);
  }
  save(s: T): void {
    this.v = structuredClone(s);
  }
}

export const executorPendingPath = (dataDir: string): string => join(dataDir, "executor-pending.json");

/** Entries placed but not yet final ($DATA_DIR/executor-pending.json), validated on load. */
export class PendingEntryStore implements StateStore<PendingEntry[]> {
  constructor(private readonly path: string) {}
  load(): PendingEntry[] | null {
    if (!existsSync(this.path)) return null;
    return PendingSchema.parse(JSON.parse(readFileSync(this.path, "utf8"))) as PendingEntry[];
  }
  save(s: PendingEntry[]): void {
    const data = PendingSchema.parse(s);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, this.path);
  }
}
const PendingSchema = z.array(z.object({ orderHash: Hex32, req: OrderRequestSchema, approvalAt: z.number().int().nonnegative() }));
