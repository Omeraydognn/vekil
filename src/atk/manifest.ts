// ATK manifest lock (SC4), allowlist file and write-tool detection (SC3).
import { readFileSync } from "node:fs";
import { z } from "zod";
import { manifestHash } from "../shared/hash.js";
import { Hex32, type McpTool } from "../shared/schemas.js";

/** SPEC §18 SC3: a tool name that looks like a write. */
export const WRITE_TOOL_RE = /(^|[_.-])(place|cancel|amend|transfer|withdraw|set)([_.-]|$)/i;
export function isWriteToolName(name: string): boolean {
  return WRITE_TOOL_RE.test(name);
}

export const ManifestLockSchema = z.object({
  atkVersion: z.string(),
  modules: z.array(z.string()),
  readOnly: z.literal(true),
  manifestHash: Hex32,
  tools: z.array(z.string()),
});
export type ManifestLock = z.infer<typeof ManifestLockSchema>;

export function buildLock(atkVersion: string, modules: string[], tools: McpTool[]): ManifestLock {
  return {
    atkVersion,
    modules: [...modules],
    readOnly: true,
    manifestHash: manifestHash(tools),
    tools: tools.map((t) => t.name).sort(),
  };
}

export function readLock(path: string): ManifestLock {
  return ManifestLockSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Compares a live tool list with the lock. Returns human-readable differences; empty = match. */
export function compareLock(lock: ManifestLock, atkVersion: string | null, modules: string[], tools: McpTool[]): string[] {
  const diffs: string[] = [];
  if (atkVersion !== lock.atkVersion) diffs.push(`version ${atkVersion ?? "?"} ≠ lock ${lock.atkVersion}`);
  if (modules.join(",") !== lock.modules.join(",")) diffs.push(`modules ${modules.join(",")} ≠ lock ${lock.modules.join(",")}`);
  const names = new Set(tools.map((t) => t.name));
  const locked = new Set(lock.tools);
  for (const n of names) if (!locked.has(n)) diffs.push(`new tool ${n}`);
  for (const n of locked) if (!names.has(n)) diffs.push(`missing tool ${n}`);
  const h = manifestHash(tools);
  if (h !== lock.manifestHash) diffs.push(`manifestHash ${h} ≠ lock ${lock.manifestHash}`);
  return diffs;
}

export const AllowlistSchema = z.object({
  llm: z.array(z.string()),
  core: z.array(z.string()),
  executorTrade: z.array(z.string()),
});
export type Allowlist = z.infer<typeof AllowlistSchema>;

/** The LLM and core lists must never contain a write tool. */
export function validateAllowlist(a: Allowlist): string[] {
  const errs: string[] = [];
  for (const n of [...a.llm, ...a.core]) if (isWriteToolName(n)) errs.push(`write tool in a read allowlist: ${n}`);
  for (const n of a.executorTrade) if (/transfer|withdraw|leverage|batch|amend|algo/i.test(n)) errs.push(`forbidden tool in executorTrade: ${n}`);
  return errs;
}

export function readAllowlist(path: string): Allowlist {
  const a = AllowlistSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const errs = validateAllowlist(a);
  if (errs.length > 0) throw new Error(errs.join("; "));
  return a;
}
