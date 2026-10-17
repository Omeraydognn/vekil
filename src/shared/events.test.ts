import { describe, expect, it } from "vitest";
import { InMemoryEventBus, makeEvent, SSE_EVENT_TYPES, type VekilEvent } from "./events.js";

describe("event bus", () => {
  it("delivers, isolates throwing subscribers and unsubscribes", () => {
    const bus = new InMemoryEventBus();
    const seen: VekilEvent[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    const off = bus.subscribe((e) => seen.push(e));
    const e = makeEvent("kill", 5, { ok: true }, { cycleId: "c1", test: false });
    bus.emit(e);
    off();
    bus.emit(e);
    expect(seen).toEqual([{ type: "kill", ts: 5, cycleId: "c1", test: false, data: { ok: true } }]);
  });
  it("omits empty cycleId", () => {
    expect(makeEvent("state", 1, {}, { cycleId: null })).toEqual({ type: "state", ts: 1, data: {} });
  });
  it("lists the §19 event types", () => {
    expect(SSE_EVENT_TYPES).toHaveLength(21);
    expect(SSE_EVENT_TYPES).toContain("exit_recorded");
  });
});
