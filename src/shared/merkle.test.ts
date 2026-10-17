import { describe, expect, it } from "vitest";
import { keccakUtf8 } from "./hash.js";
import { merkleLeaf, merkleProof, merkleRoot, verifyMerkleProof } from "./merkle.js";
import {
  VECTOR_ENTRY_HASHES, VECTOR_LEAVES, VECTOR_LEAVES as L, VECTOR_NODE_12, VECTOR_PROOFS_5, VECTOR_ROOT_1, VECTOR_ROOT_2,
  VECTOR_ROOT_3, VECTOR_ROOT_5,
} from "./vectors.js";

const E = [...VECTOR_ENTRY_HASHES];

describe("Merkle (frozen)", () => {
  it("entry hashes and leaves", () => {
    E.forEach((h, i) => {
      expect(keccakUtf8(`vekil-entry-${i + 1}`)).toBe(h);
      expect(merkleLeaf(h)).toBe(VECTOR_LEAVES[i]);
    });
  });
  it("roots for 1, 2, 3 and 5 leaves", () => {
    expect(merkleRoot(E.slice(0, 1))).toBe(VECTOR_ROOT_1);
    expect(merkleRoot(E.slice(0, 2))).toBe(VECTOR_ROOT_2);
    expect(merkleRoot(E.slice(0, 3))).toBe(VECTOR_ROOT_3);
    expect(merkleRoot(E)).toBe(VECTOR_ROOT_5);
  });
  it("proofs for every index of the 5-leaf tree", () => {
    E.forEach((h, i) => {
      const p = merkleProof(E, i);
      expect(p).toEqual(VECTOR_PROOFS_5[i]);
      expect(verifyMerkleProof(h, p, VECTOR_ROOT_5)).toBe(true);
    });
  });
  it("3-leaf proofs, including the carried-up leaf", () => {
    const e3 = E.slice(0, 3);
    expect(merkleProof(e3, 2)).toEqual([VECTOR_NODE_12]);
    expect(merkleProof(e3, 0)).toEqual([L[1], L[2]]);
    e3.forEach((h, i) => expect(verifyMerkleProof(h, merkleProof(e3, i), VECTOR_ROOT_3)).toBe(true));
  });
  it("one leaf: empty proof, root = leaf", () => {
    expect(merkleProof(E.slice(0, 1), 0)).toEqual([]);
    expect(verifyMerkleProof(E[0]!, [], VECTOR_ROOT_1)).toBe(true);
  });
});

describe("Merkle failures", () => {
  it("tampered entry or proof fails", () => {
    const p = merkleProof(E, 2);
    expect(verifyMerkleProof(E[3]!, p, VECTOR_ROOT_5)).toBe(false);
    expect(verifyMerkleProof(E[2]!, [p[0]!, p[2]!, p[1]!], VECTOR_ROOT_5)).toBe(false);
    expect(verifyMerkleProof(E[2]!, p.slice(0, 2), VECTOR_ROOT_5)).toBe(false);
  });
  it("empty tree and bad index throw", () => {
    expect(() => merkleRoot([])).toThrow();
    expect(() => merkleProof(E, 5)).toThrow();
    expect(() => merkleProof(E, -1)).toThrow();
  });
  it("roots differ for every size up to 9 (no accidental collisions)", () => {
    const many = Array.from({ length: 9 }, (_, i) => keccakUtf8(`x${i}`));
    const roots = new Set(many.map((_, n) => merkleRoot(many.slice(0, n + 1))));
    expect(roots.size).toBe(9);
    for (let n = 1; n <= 9; n++) {
      const s = many.slice(0, n);
      s.forEach((h, i) => expect(verifyMerkleProof(h, merkleProof(s, i), merkleRoot(s))).toBe(true));
    }
  });
});
