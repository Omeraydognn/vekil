import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ZERO_HASH } from "../shared/hash.js";
import { SimClock } from "../shared/time.js";
import { FileLedger, entryHash } from "./ledger.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "vekil-ledger-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("FileLedger", () => {
  it("chains hashes, starts at seq 1 with a zero prevHash, and reloads the head from disk", () => {
    const path = join(tmp(), "ledger.jsonl");
    const clock = new SimClock(1_760_000_000_000);
    const l = new FileLedger(path, clock);
    expect(l.head()).toEqual({ seq: 0, hash: ZERO_HASH });
    const a = l.append("OWNER_NOTE", { text: "Merhaba İşlem" }, { cycleId: null, test: false });
    clock.advance(1500);
    const b = l.append("ALERT", { code: "X", tr: "uyarı", details: "" }, { cycleId: "c1", test: true });
    expect(a.seq).toBe(1);
    expect(a.prevHash).toBe(ZERO_HASH);
    expect(b.prevHash).toBe(a.hash);
    const { hash, ...rest } = b;
    expect(entryHash(rest)).toBe(hash);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);

    const reloaded = new FileLedger(path, clock);
    expect(reloaded.head()).toEqual({ seq: 2, hash: b.hash });
    expect(reloaded.readAll()).toEqual([a, b]);
  });

  it("rejects invalid payloads and floats without writing anything", () => {
    const path = join(tmp(), "ledger.jsonl");
    const l = new FileLedger(path, new SimClock(0));
    expect(() => l.append("OWNER_NOTE", { nope: 1 }, { cycleId: null, test: false })).toThrow(/invalid payload/);
    expect(() => l.append("PAUSE_SEEN", { by: "core", blockTimestamp: 1.5 }, { cycleId: null, test: false })).toThrow();
    expect(l.head().seq).toBe(0);
  });

  it("readAll returns copies", () => {
    const l = new FileLedger(null, new SimClock(0));
    l.append("OWNER_NOTE", { text: "a" }, { cycleId: null, test: false });
    const all = l.readAll();
    (all[0]!.payload as { text: string }).text = "b";
    expect((l.readAll()[0]!.payload as { text: string }).text).toBe("a");
  });
});
