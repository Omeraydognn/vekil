import { afterEach, describe, expect, it } from "vitest";
import { __resetArmingForTests, armLive, assertLiveArmed, isLiveArmed, NotArmedError } from "./arming.js";

afterEach(() => __resetArmingForTests());

describe("arming", () => {
  it("fake and paper are never armed", () => {
    armLive();
    expect(isLiveArmed({ mode: "paper", env: { EXECUTOR_ARM_TOKEN: "t" } })).toBe(false);
    expect(isLiveArmed({ mode: "fake", env: {} })).toBe(false);
  });
  it("live needs armLive() or the executor token", () => {
    expect(isLiveArmed({ mode: "live", env: {} })).toBe(false);
    expect(isLiveArmed({ mode: "live", env: { EXECUTOR_ARM_TOKEN: "" } })).toBe(false);
    expect(isLiveArmed({ mode: "demo", env: { EXECUTOR_ARM_TOKEN: "abc" } })).toBe(true);
    armLive();
    expect(isLiveArmed({ mode: "live", env: {} })).toBe(true);
  });
  it("assertLiveArmed throws the Turkish message", () => {
    expect(() => assertLiveArmed({ mode: "live", env: {} })).toThrow(NotArmedError);
    expect(() => assertLiveArmed({ mode: "live", env: {} })).toThrow(/pnpm live/);
  });
});
