// Merkle tree over ledger entry hashes (SPEC §9.7). Must match VekilPolicy.verifyEntry.
import { concat, keccak256 } from "viem";
import { lowerHex32, type Hex32 } from "./hash.js";

/** leaf = keccak256(entryHash) over the 32-byte value. */
export const merkleLeaf = (entryHash: string): Hex32 => keccak256(lowerHex32(entryHash));

/** parent(a, b) = keccak256(min(a, b) ‖ max(a, b)), compared as uint256. */
export function merkleParent(a: string, b: string): Hex32 {
  const x = lowerHex32(a);
  const y = lowerHex32(b);
  return BigInt(x) <= BigInt(y) ? keccak256(concat([x, y])) : keccak256(concat([y, x]));
}

/** All levels from leaves (level 0) to the root. Odd last nodes are carried up unchanged. */
function levels(entryHashes: readonly string[]): Hex32[][] {
  if (entryHashes.length === 0) throw new Error("merkle: no leaves");
  const out: Hex32[][] = [entryHashes.map(merkleLeaf)];
  for (;;) {
    const cur = out[out.length - 1]!;
    if (cur.length === 1) return out;
    const next: Hex32[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const r = cur[i + 1];
      next.push(r === undefined ? cur[i]! : merkleParent(cur[i]!, r));
    }
    out.push(next);
  }
}

export function merkleRoot(entryHashes: readonly string[]): Hex32 {
  const ls = levels(entryHashes);
  return ls[ls.length - 1]![0]!;
}

/** Sibling hashes bottom-up, skipping levels where the node was carried up. */
export function merkleProof(entryHashes: readonly string[], index: number): Hex32[] {
  if (!Number.isSafeInteger(index) || index < 0 || index >= entryHashes.length) {
    throw new Error(`merkle: index ${index} out of range`);
  }
  const ls = levels(entryHashes);
  const proof: Hex32[] = [];
  let i = index;
  for (let l = 0; l < ls.length - 1; l++) {
    const level = ls[l]!;
    const sib = i % 2 === 0 ? level[i + 1] : level[i - 1];
    if (sib !== undefined) proof.push(sib);
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyMerkleProof(entryHash: string, proof: readonly string[], root: string): boolean {
  let h = merkleLeaf(entryHash);
  for (const p of proof) h = merkleParent(h, p);
  return h === lowerHex32(root);
}
