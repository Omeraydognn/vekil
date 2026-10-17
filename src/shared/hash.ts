// keccak256 helpers (SPEC §9.7).
import { keccak256, stringToBytes } from "viem";
import { canonical, sortKeysDeep } from "./canonical.js";

export type Hex32 = `0x${string}`;
export const ZERO_HASH = `0x${"0".repeat(64)}` as Hex32;
const HEX32_RE = /^0x[0-9a-f]{64}$/;

export function lowerHex32(x: string): Hex32 {
  const l = x.toLowerCase();
  if (!HEX32_RE.test(l)) throw new Error(`not a 32-byte hex: ${x}`);
  return l as Hex32;
}

export function keccakUtf8(s: string): Hex32 {
  return keccak256(stringToBytes(s));
}

export function hashCanonical(x: unknown): Hex32 {
  return keccakUtf8(canonical(x));
}

export interface ManifestTool {
  name: string;
  description?: string;
  inputSchema: object;
}

/** SPEC §9.7: plain JSON.stringify (tool schemas may contain floats) over sorted keys, tools sorted by name. */
export function manifestHash(tools: readonly ManifestTool[]): Hex32 {
  const items = tools
    .map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return keccakUtf8(JSON.stringify(sortKeysDeep(items)));
}
