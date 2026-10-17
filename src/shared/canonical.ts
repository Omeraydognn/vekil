// Canonical JSON (SPEC §9.7): sorted keys, no whitespace, JSON.stringify escaping,
// safe integers / strings / booleans / null / arrays / objects only.

export class CanonicalError extends Error {
  override name = "CanonicalError";
}

function enc(x: unknown, path: string, seen: Set<object> = new Set()): string | undefined {
  if (x === null) return "null";
  switch (typeof x) {
    case "string":
      return JSON.stringify(x);
    case "boolean":
      return x ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(x)) throw new CanonicalError(`${path}: only safe integers are allowed, got ${x}`);
      return Object.is(x, -0) ? "0" : String(x);
    case "undefined":
      return undefined;
    case "bigint":
      throw new CanonicalError(`${path}: bigint is not allowed`);
    case "function":
    case "symbol":
      throw new CanonicalError(`${path}: ${typeof x} is not allowed`);
    case "object": {
      if (seen.has(x)) throw new CanonicalError(`${path}: cyclic structure`);
      seen.add(x);
      try {
        return encObject(x, path, seen);
      } finally {
        seen.delete(x);
      }
    }
  }
  throw new CanonicalError(`${path}: unsupported value`);
}

function encObject(x: object, path: string, seen: Set<object>): string {
  if (Array.isArray(x)) {
    // Array.from visits holes too, so sparse arrays become null like JSON.stringify.
    return `[${Array.from(x as unknown[], (v, i) => enc(v, `${path}[${i}]`, seen) ?? "null").join(",")}]`;
  }
  const proto = Object.getPrototypeOf(x) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalError(`${path}: only plain objects are allowed`);
  }
  const rec = x as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(rec).sort()) {
    const v = enc(rec[k], `${path}.${k}`, seen);
    if (v !== undefined) parts.push(`${JSON.stringify(k)}:${v}`);
  }
  return `{${parts.join(",")}}`;
}

export function canonical(x: unknown): string {
  const s = enc(x, "$");
  if (s === undefined) throw new CanonicalError("$: undefined is not allowed at the top level");
  return s;
}

/** Recursively sorts object keys (no value checks). Used by the manifest hash, where floats are allowed. */
export function sortKeysDeep(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeysDeep);
  if (x !== null && typeof x === "object") {
    const rec = x as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(rec).sort()) out[k] = sortKeysDeep(rec[k]);
    return out;
  }
  return x;
}
