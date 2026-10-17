// Live arming (SPEC §8.2). Only scripts/live.ts calls armLive(); the executor is armed by EXECUTOR_ARM_TOKEN.
import type { Mode } from "./schemas.js";

let coreArmed = false;

/** Called only by scripts/live.ts after the TTY + "CANLI" confirmation. */
export function armLive(): void {
  coreArmed = true;
}

export function isLiveArmed(opts: { mode: Mode; env?: NodeJS.ProcessEnv }): boolean {
  if (opts.mode !== "live" && opts.mode !== "demo") return false;
  const token = (opts.env ?? process.env).EXECUTOR_ARM_TOKEN;
  return coreArmed || (typeof token === "string" && token.length > 0);
}

export class NotArmedError extends Error {
  override name = "NotArmedError";
  constructor() {
    super("Canlı mod sadece `pnpm live` ile başlatılır");
  }
}

export function assertLiveArmed(opts: { mode: Mode; env?: NodeJS.ProcessEnv }): void {
  if (!isLiveArmed(opts)) throw new NotArmedError();
}

/** Tests only. */
export function __resetArmingForTests(): void {
  coreArmed = false;
}
