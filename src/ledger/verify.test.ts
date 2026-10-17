import { describe, expect, it } from "vitest";
import { FakePolicyChain } from "../chain/fake-policy-chain.js";
import { keccakUtf8 } from "../shared/hash.js";
import { merkleRoot } from "../shared/merkle.js";
import { entryClOrdId, exitClOrdId } from "../shared/order-hash.js";
import { policyHash, sourceTextHash } from "../shared/policy-encode.js";
import type { ChainRequestResult, Hex32, OrderRequest } from "../shared/schemas.js";
import { SimClock } from "../shared/time.js";
import { FileLedger } from "./ledger.js";
import { NOT_ANCHORED_TR, verifyLedger } from "./verify.js";

const T0 = Date.UTC(2026, 9, 17, 9, 0, 0);

function req(n: number, over: Partial<OrderRequest> = {}): OrderRequest {
  return {
    instId: "AVAX-TRY", side: "buy", px: "494.7", sz: "0.4", stopPx: "488.8", tpPx: "506.6", timeStopMin: 240,
    decisionHash: keccakUtf8(`d-${n}`), nonce: keccakUtf8(`n-${n}`), ...over,
  };
}

async function scenario() {
  const clock = new SimClock(T0);
  const chain = new FakePolicyChain({ clock });
  const ledger = new FileLedger(null, clock);
  const opts = { cycleId: null, test: false };
  const view = await chain.readView();
  ledger.append("POLICY", {
    version: view.policyVersion, policyHash: policyHash(view.policy), policy: view.policy,
    sourceTextHash: sourceTextHash(view.policy.sourceText), txHash: null, source: "deploy",
  }, opts);

  // Approved + executed + filled + exited.
  const r1 = req(1);
  const a = await chain.requestApproval(r1, { timeoutMs: 1000 });
  if (!a.ok) throw new Error("approve failed");
  const pushReq = (r: OrderRequest, res: ChainRequestResult) => {
    if (!res.ok) throw new Error("x");
    return ledger.append("CHAIN_REQUEST", {
      order: r, orderHash: res.orderHash, txHash: res.txHash, status: res.status, reasonsMask: res.reasonsMask, reasons: [],
      critical: res.critical, policyVersion: res.policyVersion, worstCase: res.worstCase, error: null,
    }, opts);
  };
  const reqEntry = pushReq(r1, a);
  ledger.append("EXECUTE", { orderHash: a.orderHash, clOrdId: entryClOrdId(a.orderHash), result: "FILLED", refusal: null }, opts);
  ledger.append("FILL", {
    orderHash: a.orderHash, clOrdId: entryClOrdId(a.orderHash), ordId: "1", state: "filled", accFillSz: "0.4", avgPx: "494.7",
    fee: "-0.0004", feeCcy: "AVAX", cTime: T0 + 2000, dust: false,
  }, opts);
  const xId = exitClOrdId(a.orderHash, keccakUtf8("exit-nonce"));
  ledger.append("EXIT", {
    entryOrderHash: a.orderHash, exitClOrdId: xId, exitPrefix: xId.slice(1), reason: "STOP_HIT", soldSz: "0.3996",
    avgPx: "488", proceedsQuote: "194.6", pnlQuote: "-3.1", cTime: T0 + 60_000,
  }, opts);
  const rec = await chain.recordExit(a.orderHash, xId.slice(1), 2, "-3.1");
  if (!rec.ok) throw new Error("recordExit failed");
  ledger.append("EXIT_RECORDED", { entryOrderHash: a.orderHash, txHash: rec.txHash, blockNumber: rec.blockNumber }, opts);

  // Rejected (non-critical scripted).
  chain.scriptNext({ reasons: ["ORDER_TOO_LARGE"], critical: false });
  const r2 = req(2, { sz: "1" });
  const b = await chain.requestApproval(r2, { timeoutMs: 1000 });
  pushReq(r2, b);
  return { clock, chain, ledger, reqEntry, approvedHash: a.orderHash as Hex32 };
}

async function anchorAll(chain: FakePolicyChain, ledger: FileLedger) {
  const from = (await chain.lastAnchoredSeq()) + 1;
  const to = ledger.head().seq;
  const hashes = ledger.readAll().filter((e) => e.seq >= from && e.seq <= to).map((e) => e.hash);
  const res = await chain.anchor(merkleRoot(hashes), from, to);
  if (!res.ok) throw new Error(res.error);
}

describe("verifyLedger", () => {
  it("passes V1–V6 and proves an anchored entry on-chain", async () => {
    const { chain, ledger, reqEntry } = await scenario();
    await anchorAll(chain, ledger);
    const r = await verifyLedger({ entries: ledger.readAll(), chain, proveSeq: reqEntry.seq });
    expect(r.failures).toEqual([]);
    expect(r.checks.map((c) => [c.id, c.ok])).toEqual([["V1", true], ["V2", true], ["V3", true], ["V4", true], ["V5", true], ["V6", true]]);
    expect(r.ok).toBe(true);
    expect(r.proof?.onChainVerified).toBe(true);
    expect(r.proof?.anchorIndex).toBe(0);
  });

  it("an unanchored seq is reported as 'henüz zincire yazılmadı'", async () => {
    const { chain, ledger, reqEntry } = await scenario();
    const r = await verifyLedger({ entries: ledger.readAll(), chain, proveSeq: reqEntry.seq });
    expect(r.proof).toBeUndefined();
    expect(r.failures).toContainEqual({ seq: reqEntry.seq, check: "PROOF", message: NOT_ANCHORED_TR });
  });

  it("tamper demo: the first failure is at the tampered seq (V1 and V2)", async () => {
    const { chain, ledger, reqEntry } = await scenario();
    await anchorAll(chain, ledger);
    const r = await verifyLedger({ entries: ledger.readAll(), chain, tamperSeq: reqEntry.seq });
    expect(r.ok).toBe(false);
    expect(r.failures[0]?.seq).toBe(reqEntry.seq);
    expect(r.checks.find((c) => c.id === "V1")?.ok).toBe(false);
    expect(r.checks.find((c) => c.id === "V2")?.ok).toBe(false);
    // The real ledger is untouched.
    expect((await verifyLedger({ entries: ledger.readAll(), chain })).ok).toBe(true);
  });

  it("V1 catches a broken link and a seq gap", async () => {
    const { chain, ledger } = await scenario();
    const all = ledger.readAll();
    const gap = all.filter((e) => e.seq !== 3);
    const r = await verifyLedger({ entries: gap, chain });
    expect(r.checks.find((c) => c.id === "V1")?.ok).toBe(false);
  });

  it("V3 fails for an EXECUTE without an earlier approval or with a wrong clOrdId", async () => {
    const clock = new SimClock(T0);
    const chain = new FakePolicyChain({ clock });
    const ledger = new FileLedger(null, clock);
    const h = keccakUtf8("unapproved");
    ledger.append("EXECUTE", { orderHash: h, clOrdId: entryClOrdId(h), result: "FILLED", refusal: null }, { cycleId: null, test: false });
    const r = await verifyLedger({ entries: ledger.readAll(), chain });
    expect(r.checks.find((c) => c.id === "V3")?.ok).toBe(false);
    expect(r.failures[0]).toMatchObject({ seq: 1, check: "V3" });
  });

  it("V4 fails when the chain does not hold the recorded rejection", async () => {
    const clock = new SimClock(T0);
    const chain = new FakePolicyChain({ clock });
    const ledger = new FileLedger(null, clock);
    const r2 = req(9);
    ledger.append("CHAIN_REQUEST", {
      order: r2, orderHash: keccakUtf8("nowhere"), txHash: null, status: "REJECTED", reasonsMask: 32, reasons: ["ORDER_TOO_LARGE"],
      critical: false, policyVersion: 1, worstCase: null, error: null,
    }, { cycleId: null, test: false });
    const r = await verifyLedger({ entries: ledger.readAll(), chain });
    expect(r.checks.find((c) => c.id === "V4")?.ok).toBe(false);
  });

  it("V5: an exit without EXIT_RECORDED is pending (ok), one claimed recorded but missing fails", async () => {
    const clock = new SimClock(T0);
    const chain = new FakePolicyChain({ clock });
    const ledger = new FileLedger(null, clock);
    const h = keccakUtf8("entry");
    const xId = exitClOrdId(h, keccakUtf8("n"));
    const exit = {
      entryOrderHash: h, exitClOrdId: xId, exitPrefix: xId.slice(1), reason: "TP_HIT", soldSz: "1",
      avgPx: "1", proceedsQuote: "1", pnlQuote: "0", cTime: T0,
    };
    ledger.append("EXIT", exit, { cycleId: null, test: false });
    let r = await verifyLedger({ entries: ledger.readAll(), chain });
    expect(r.checks.find((c) => c.id === "V5")).toMatchObject({ ok: true, details: "1 çıkış, 1 bekliyor" });
    ledger.append("EXIT_RECORDED", { entryOrderHash: h, txHash: "0xabc", blockNumber: 1 }, { cycleId: null, test: false });
    r = await verifyLedger({ entries: ledger.readAll(), chain });
    expect(r.checks.find((c) => c.id === "V5")?.ok).toBe(false);
  });

  it("V6 fails when the on-chain policy changed after the last POLICY entry", async () => {
    const { chain, ledger, clock } = await scenario();
    const p = (await chain.readView()).policy;
    await chain.setPolicy({ ...p, maxOrderQuote: "50", validUntil: Math.floor((clock.now() + 3_600_000) / 1000) * 1000 });
    const r = await verifyLedger({ entries: ledger.readAll(), chain });
    expect(r.checks.find((c) => c.id === "V6")?.ok).toBe(false);
  });

  it("V2 fails when an on-chain root does not match", async () => {
    const { chain, ledger } = await scenario();
    await chain.anchor(keccakUtf8("bogus"), 1, ledger.head().seq);
    const r = await verifyLedger({ entries: ledger.readAll(), chain });
    expect(r.checks.find((c) => c.id === "V2")?.ok).toBe(false);
  });
});
