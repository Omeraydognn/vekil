// Real contract on a throwaway anvil. Skipped when anvil isn't installed.
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccakUtf8 } from "../shared/hash.js";
import { merkleRoot } from "../shared/merkle.js";
import { entryClOrdId, exitClOrdId, hashPrefix30, orderHash } from "../shared/order-hash.js";
import { policyHash, sourceTextHash } from "../shared/policy-encode.js";
import { maskToReasons } from "../shared/reasons.js";
import type { Hex32, OrderRequest, Policy } from "../shared/schemas.js";
import {
  VECTOR_CHAIN_ID,
  VECTOR_ENTRY_HASHES,
  VECTOR_ORDER_HASH,
  VECTOR_POLICY,
  VECTOR_POLICY_2,
  VECTOR_PROOFS_5,
  VECTOR_R1_CHAIN_ID,
  VECTOR_R1_ORDER_HASH,
  VECTOR_R1_REQ,
  VECTOR_REQ,
} from "../shared/vectors.js";
import { startLocalChain, type LocalChain } from "./anvil.js";
import { ViemPolicyChain } from "./policy-chain.js";

const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;

/** Fails if any bigint is anywhere in the value. */
function assertNoBigint(x: unknown, path = "$"): void {
  if (typeof x === "bigint") throw new Error(`bigint at ${path}`);
  if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) assertNoBigint(v, `${path}.${k}`);
}

const withNonce = (r: OrderRequest, n: number): OrderRequest => ({ ...r, nonce: keccakUtf8(`nonce-${n}`) });

describe.skipIf(!hasAnvil)("ViemPolicyChain on anvil", () => {
  let lc: LocalChain;
  let approvedHash = "" as Hex32;

  beforeAll(async () => {
    lc = await startLocalChain();
  }, 30_000);
  afterAll(async () => {
    await lc?.stop();
  });

  it("hashOrderFor equals the frozen TS vectors", async () => {
    expect(await lc.chain.hashOrderFor(VECTOR_CHAIN_ID, VECTOR_POLICY, VECTOR_REQ)).toBe(VECTOR_ORDER_HASH);
    expect(await lc.chain.hashOrderFor(VECTOR_R1_CHAIN_ID, VECTOR_POLICY, VECTOR_R1_REQ)).toBe(VECTOR_R1_ORDER_HASH);
  });

  it("readView returns the default policy with a matching policyHash", async () => {
    const v = await lc.chain.readView();
    assertNoBigint(v);
    expect(v.policy).toEqual(lc.policy);
    expect(v.policyVersion).toBe(1);
    expect(v.paused).toBe(false);
    expect(v.policyHash).toBe(policyHash(lc.policy));
    expect(v.sourceTextHash).toBe(sourceTextHash(""));
    expect(v.agent).toBe(lc.deployment.agent);
    expect(v.owner).toBe(lc.deployment.owner);
    expect(v.blockTimestamp).toBeGreaterThan(0);
  });

  it("approves a valid order and exposes it by prefix and log", async () => {
    const req = withNonce(VECTOR_REQ, 1);
    const r = await lc.chain.requestApproval(req, { timeoutMs: 10_000 });
    assertNoBigint(r);
    expect(r).toMatchObject({ ok: true, status: "APPROVED", reasonsMask: 0, critical: false, policyVersion: 1, worstCase: "3.78523321" });
    if (!r.ok) throw new Error("unreachable");
    expect(r.orderHash).toBe(orderHash(31337, lc.deployment.address, req));
    approvedHash = r.orderHash;
    const a = await lc.chain.approval(r.orderHash);
    expect(a.status).toBe(1);
    expect(a.expiresAt - a.at).toBe(120);
    expect(await lc.chain.orderHashByPrefix(entryClOrdId(r.orderHash).slice(1))).toBe(r.orderHash);
    expect(await lc.chain.orderHashByPrefix("0".repeat(30))).toBeNull();
    expect(await lc.chain.approvedRequest(r.orderHash)).toEqual(req);
    const c = await lc.chain.counters();
    assertNoBigint(c);
    expect(c).toMatchObject({ tradesInHour: 1, tradesInDay: 1, riskUsedToday: "3.78523321" });
  });

  it("refuses the same request twice without sending", async () => {
    const r = await lc.chain.requestApproval(withNonce(VECTOR_REQ, 1), { timeoutMs: 10_000 });
    expect(r.ok).toBe(false);
  });

  it("records a non-critical rejection (hourly limit)", async () => {
    const r = await lc.chain.requestApproval(withNonce(VECTOR_REQ, 2), { timeoutMs: 10_000 });
    expect(r).toMatchObject({ ok: true, status: "REJECTED", critical: false, worstCase: "0" });
    if (!r.ok) throw new Error("unreachable");
    expect(maskToReasons(r.reasonsMask)).toEqual(["HOURLY_LIMIT"]);
    expect(await lc.chain.approvedRequest(r.orderHash)).toBeNull();
    expect((await lc.chain.readView()).paused).toBe(false);
  });

  it("R1 is rejected with three reasons, critical, and pauses the contract", async () => {
    const r = await lc.chain.requestApproval(withNonce(VECTOR_R1_REQ, 3), { timeoutMs: 10_000 });
    expect(r).toMatchObject({ ok: true, status: "REJECTED", critical: true });
    if (!r.ok) throw new Error("unreachable");
    // the hourly slot is already used by the approval above
    expect(maskToReasons(r.reasonsMask)).toEqual(["INSTRUMENT_NOT_ALLOWED", "ORDER_TOO_LARGE", "STOP_MISSING", "HOURLY_LIMIT"]);
    expect((await lc.chain.readView()).paused).toBe(true);
  });

  it("records an exit while paused", async () => {
    const xPrefix = exitClOrdId(approvedHash, keccakUtf8("exit-nonce")).slice(1);
    const res = await lc.chain.recordExit(approvedHash, xPrefix, 2, "-1.234567899");
    expect(res.ok).toBe(true);
    expect(await lc.chain.exitRecordedAt(approvedHash)).toBeGreaterThan(0);
    expect(await lc.chain.entryByExitPrefix(xPrefix)).toBe(approvedHash);
    const again = await lc.chain.recordExit(approvedHash, xPrefix, 2, "0");
    expect(again.ok).toBe(false);
    expect(await lc.chain.exitRecordedAt(keccakUtf8("unknown"))).toBe(0);
    expect(hashPrefix30(approvedHash)).toHaveLength(30);
  });

  it("anchors the 5-leaf vector and verifies every proof on-chain", async () => {
    const root = merkleRoot(VECTOR_ENTRY_HASHES);
    const res = await lc.chain.anchor(root, 1, 5);
    expect(res.ok).toBe(true);
    expect(await lc.chain.lastAnchoredSeq()).toBe(5);
    const anchors = await lc.chain.readAnchors();
    assertNoBigint(anchors);
    expect(anchors).toEqual([expect.objectContaining({ index: 0, root, fromSeq: 1, toSeq: 5 })]);
    for (let i = 0; i < 5; i++) {
      expect(await lc.chain.verifyEntry(0, VECTOR_ENTRY_HASHES[i]!, [...VECTOR_PROOFS_5[i]!])).toBe(true);
    }
    expect(await lc.chain.verifyEntry(0, VECTOR_ENTRY_HASHES[0]!, [...VECTOR_PROOFS_5[1]!])).toBe(false);
    expect((await lc.chain.anchor(root, 7, 8)).ok).toBe(false);
  });

  it("setPolicy round-trips a Turkish source text through the PolicySet log", async () => {
    const p: Policy = { ...VECTOR_POLICY_2, validUntil: (Math.floor(Date.now() / 1000) + 86_400) * 1000 };
    const res = await lc.chain.setPolicy(p);
    expect(res.ok).toBe(true);
    // A fresh client has no cache: the text must come from the log.
    const fresh = new ViemPolicyChain({
      rpcUrl: lc.anvil.rpcUrl,
      chainId: 31337,
      address: lc.deployment.address,
      fromBlock: lc.deployment.deployBlock,
      pollingIntervalMs: 50,
    });
    const v = await fresh.readView();
    expect(v.policy).toEqual(p);
    expect(v.policyVersion).toBe(2);
    expect(v.policyHash).toBe(policyHash(p));
    expect(v.paused).toBe(true); // setPolicy does not unpause
    expect((await fresh.pause()).ok).toBe(false); // no owner key
  });

  it("owner pause/unpause/setAgentId and encodeOwnerCall", async () => {
    expect((await lc.chain.unpause()).ok).toBe(true);
    expect((await lc.chain.readView()).paused).toBe(false);
    expect((await lc.chain.setAgentId(42)).ok).toBe(true);
    expect((await lc.chain.readView()).agentId).toBe(42);
    const call = lc.chain.encodeOwnerCall("pause");
    expect(call).toEqual({ to: lc.deployment.address, data: "0x8456cb59", chainId: 31337 });
    expect(lc.chain.explorerTxUrl("0xabc")).toBeNull();
  });

  it("rejects an invalid policy before sending", async () => {
    const res = await lc.chain.setPolicy({ ...lc.policy, maxOrderQuote: "1001" });
    expect(res.ok).toBe(false);
  });
});
