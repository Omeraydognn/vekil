// Hash-chained append-only ledger (SPEC §9.6, §16.1). One canonical JSON line per entry, synchronous
// append; the head is rebuilt from the file on startup.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonical } from "../shared/canonical.js";
import { hashCanonical, ZERO_HASH } from "../shared/hash.js";
import type { Clock, Ledger } from "../shared/interfaces.js";
import { LEDGER_PAYLOAD_SCHEMAS, LedgerEntrySchema, type Hex32, type LedgerEntry, type LedgerKind } from "../shared/schemas.js";

/** hash = keccak256(utf8(canonical({ seq, ts, kind, cycleId, test, payload, prevHash }))). */
export function entryHash(e: Omit<LedgerEntry, "hash">): Hex32 {
  return hashCanonical({ seq: e.seq, ts: e.ts, kind: e.kind, cycleId: e.cycleId, test: e.test, payload: e.payload, prevHash: e.prevHash });
}

export class FileLedger implements Ledger {
  private readonly entries: LedgerEntry[] = [];

  /** path null → in-memory (tests). */
  constructor(
    private readonly path: string | null,
    private readonly clock: Clock,
  ) {
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.trim()) this.entries.push(LedgerEntrySchema.parse(JSON.parse(line)));
      }
    }
  }

  append(kind: LedgerKind, payload: object, opts: { cycleId: string | null; test: boolean }): LedgerEntry {
    const parsed = LEDGER_PAYLOAD_SCHEMAS[kind].safeParse(payload);
    if (!parsed.success) {
      throw new Error(`ledger ${kind}: invalid payload: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const h = this.head();
    const base = {
      seq: h.seq + 1,
      ts: this.clock.now(),
      kind,
      cycleId: opts.cycleId,
      test: opts.test,
      payload: payload as Record<string, unknown>,
      prevHash: h.hash,
    };
    const e: LedgerEntry = { ...base, hash: entryHash(base) };
    const line = canonical(e); // throws on floats/bigints before anything is written
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, line + "\n");
    }
    this.entries.push(e);
    return structuredClone(e);
  }

  head(): { seq: number; hash: Hex32 } {
    const last = this.entries.at(-1);
    return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: ZERO_HASH };
  }

  readAll(): LedgerEntry[] {
    return structuredClone(this.entries);
  }
}
