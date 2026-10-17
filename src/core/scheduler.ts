// Agent scheduling (SPEC §10.1): one cycle when due; HALTED/STARTUP_FAILED → SKIPPED without an LLM call.
import type { Clock, Scheduler } from "../shared/interfaces.js";
import type { CycleResult } from "../shared/schemas.js";
import { BusyError } from "./errors.js";
import type { Vekil } from "./vekil.js";

/** §10.1: [2, 30] min, [2, 10] with an open position, missing → 5, after an exit ≤ 5, after an LLM error 5. */
export function clampNextCheckIn(min: number | undefined, o: { positionOpen: boolean; afterExit: boolean; llmError: boolean }): number {
  if (o.llmError) return 5;
  let m = min ?? 5;
  m = Math.min(Math.max(m, 2), o.positionOpen ? 10 : 30);
  if (o.afterExit) m = Math.min(m, 5);
  return m;
}

export class CoreScheduler implements Scheduler {
  private stopFn: (() => void) | null = null;

  constructor(
    private readonly core: Vekil,
    private readonly clock: Clock,
    private readonly tickMs = 5000,
  ) {}

  async tick(): Promise<CycleResult | null> {
    const s = this.core.getState();
    if (s.status !== "RUNNING") return this.core.skipped("schedule", false);
    if (s.agent.cycleRunning || this.clock.now() < s.agent.nextCheckInAt) return null;
    try {
      return await this.core.runCycle({ trigger: "schedule" });
    } catch (e) {
      if (e instanceof BusyError) return null;
      throw e;
    }
  }

  start(): void {
    if (this.stopFn) return;
    this.stopFn = this.clock.every(this.tickMs, async () => {
      await this.tick().catch(() => undefined);
    });
  }

  stop(): void {
    this.stopFn?.();
    this.stopFn = null;
  }
}
