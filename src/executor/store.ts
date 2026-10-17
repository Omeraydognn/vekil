// Executor state persistence: $DATA_DIR/executor-state.json, atomic (tmp + fsync + rename). Kept inside src/executor
// so the isolated process depends on nothing from core.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StateStore } from "../shared/interfaces.js";
import { ExecutorStateSchema, type ExecutorState } from "../shared/schemas.js";

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
