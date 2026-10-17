// Chain-write queue (SPEC §15.1, §16.2): one agent-key transaction in flight, approvals first,
// then exit records, then anchors. Owner transactions (pause, setPolicy) never go through it.
export type ChainJobKind = "approval" | "exit" | "anchor";
const PRIORITY: Record<ChainJobKind, number> = { approval: 0, exit: 1, anchor: 2 };

interface Job {
  kind: ChainJobKind;
  seq: number;
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class ChainWriteQueue {
  private jobs: Job[] = [];
  private seq = 0;
  private busy = false;
  /** Kinds in the order they started (tests). */
  readonly started: ChainJobKind[] = [];

  get pending(): number {
    return this.jobs.length;
  }
  get inFlight(): boolean {
    return this.busy;
  }
  has(kind: ChainJobKind): boolean {
    return this.jobs.some((j) => j.kind === kind);
  }

  push<T>(kind: ChainJobKind, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({ kind, seq: this.seq++, run, resolve: resolve as (v: unknown) => void, reject });
      queueMicrotask(() => void this.pump());
    });
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.jobs.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.seq - b.seq);
    const job = this.jobs.shift();
    if (!job) return;
    this.busy = true;
    this.started.push(job.kind);
    try {
      job.resolve(await job.run());
    } catch (e) {
      job.reject(e);
    } finally {
      this.busy = false;
      void this.pump();
    }
  }
}
