// VEKİL Guard against the real contract on a throwaway anvil. Skipped when anvil isn't installed.
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { request, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLocalChain, type LocalChain } from "../chain/anvil.js";
import { keccakUtf8 } from "../shared/hash.js";
import { entryClOrdId, orderHash } from "../shared/order-hash.js";
import type { OrderRequest } from "../shared/schemas.js";
import { auditClOrdId, checkOrder, worstCaseQuote, type GuardDeps } from "./guard.js";
import { guardApp } from "./server.js";

const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;

const VALID = { instId: "AVAX-TRY", px: "494.7", sz: "0.4042", stopPx: "488.8", tpPx: "506.6", timeStopMin: 240 };
const R1 = { instId: "DOGE-TRY", px: "7.007", sz: "1427.14428" };

describe("worstCaseQuote (SPEC §13.1)", () => {
  const req = (stopPx: string): OrderRequest => ({
    instId: "AVAX-TRY", side: "buy", px: "100", sz: "2", stopPx, tpPx: "0", timeStopMin: 60,
    decisionHash: keccakUtf8("d"), nonce: keccakUtf8("n"),
  });
  it("stop distance × size + fees and slippage on the notional", () => {
    // (100 − 99) × 2 + 200 × (2×20 + 30) / 10000 = 2 + 1.4
    expect(worstCaseQuote(req("99"), 20, 30)).toBe("3.4");
  });
  it("null without a valid stop", () => {
    expect(worstCaseQuote(req("0"), 20, 30)).toBeNull();
    expect(worstCaseQuote(req("100"), 20, 30)).toBeNull();
  });
});

describe.skipIf(!hasAnvil)("VEKİL Guard on anvil", () => {
  let lc: LocalChain;
  let deps: GuardDeps;

  beforeAll(async () => {
    lc = await startLocalChain();
    deps = { chain: lc.chain, now: () => Date.now() };
  }, 30_000);
  afterAll(async () => {
    await lc?.stop();
  });

  it("approves a valid order without changing the chain", async () => {
    const before = await lc.chain.latestBlockTimestamp();
    const r = await checkOrder(deps, { ...VALID, side: "buy" });
    expect(r.verdict).toBe("APPROVE");
    expect(r.reasons).toEqual([]);
    expect(r.critical).toBe(false);
    expect(r.notional).toBe("199.95774");
    expect(r.worstCase).not.toBeNull();
    expect(r.chain.asAgent).toBe(lc.deployment.agent);
    expect(r.simulated).toBe(true);
    // Nothing was written: no approval stored, no counter moved, no new block.
    expect((await lc.chain.approval(orderHash(lc.chain.chainId, lc.chain.address, r.request))).status).toBe(0);
    expect((await lc.chain.counters()).tradesInHour).toBe(0);
    expect(await lc.chain.latestBlockTimestamp()).toBe(before);
  });

  it("defaults timeStopMin to the policy's max hold", async () => {
    const r = await checkOrder(deps, { instId: "AVAX-TRY", side: "buy", px: "494.7", sz: "0.4042", stopPx: "488.8" });
    expect(r.request.timeStopMin).toBe(lc.policy.maxHoldMin);
    expect(r.verdict).toBe("APPROVE");
  });

  it("rejects R1 with the three critical reasons and says it would pause", async () => {
    const r = await checkOrder(deps, { ...R1, side: "buy" });
    expect(r.verdict).toBe("REJECT");
    expect(r.reasons.map((x) => x.code)).toEqual(["INSTRUMENT_NOT_ALLOWED", "ORDER_TOO_LARGE", "STOP_MISSING"]);
    expect(r.reasons[2]?.tr).toBe("Zarar-kes yok");
    expect(r.critical).toBe(true);
    expect(r.wouldPause).toBe(true);
    expect((await lc.chain.readView()).paused).toBe(false);
  });

  it("a too-wide stop is a non-critical rejection", async () => {
    const r = await checkOrder(deps, { ...VALID, side: "buy", stopPx: "470" });
    expect(r.reasons.map((x) => x.code)).toEqual(["STOP_TOO_WIDE"]);
    expect(r.critical).toBe(false);
    expect(r.wouldPause).toBe(false);
  });

  it("audits a real approved entry by clOrdId", async () => {
    const req: OrderRequest = { ...VALID, side: "buy", decisionHash: keccakUtf8("d1"), nonce: keccakUtf8("guard-audit-1") };
    const res = await lc.chain.requestApproval(req, { timeoutMs: 10_000 });
    if (!res.ok) throw new Error(res.error);
    expect(res.status).toBe("APPROVED");
    const id = entryClOrdId(res.orderHash);
    // Guard's worst case equals what the contract stored for this approval.
    expect(worstCaseQuote(req, lc.policy.feeBps, lc.policy.slippageBps)).toBe((await lc.chain.approval(res.orderHash)).worstCase);

    const bare = await auditClOrdId(deps, id, {});
    expect(bare.kind).toBe("ENTRY");
    expect(bare.onChain.orderHash).toBe(res.orderHash);
    expect(bare.onChain.approvalStatus).toBe(1);
    expect(bare.onChain.approved?.sz).toBe("0.4042");
    expect(bare.match).toBeNull();

    const ok = await auditClOrdId(deps, id, { instId: "AVAX-TRY", side: "buy", px: "494.7", sz: "0.4042" });
    expect(ok.match?.status).toBe("OK");
    const bad = await auditClOrdId(deps, id, { instId: "AVAX-TRY", side: "buy", px: "494.7", sz: "1" });
    expect(bad.match?.status).toBe("VIOLATION");
  });

  it("unknown v-order and manual ids", async () => {
    const unknown = await auditClOrdId(deps, `v${"ab".repeat(15)}`, { instId: "AVAX-TRY", side: "buy", px: "1", sz: "1" });
    expect(unknown.onChain.orderHash).toBeNull();
    expect(unknown.match?.status).toBe("VIOLATION");
    expect((await auditClOrdId(deps, "my-manual-order", {})).kind).toBe("MANUAL");
    await expect(auditClOrdId(deps, `v${"ab".repeat(15)}`, { px: "1", sz: "1" })).rejects.toThrow(/birlikte/);
  });

  describe("HTTP", () => {
    let server: Server;
    let base = "";
    const start = (extra: Partial<Parameters<typeof guardApp>[0]> = {}): Promise<void> =>
      new Promise((resolve) => {
        server = guardApp({ ...deps, baseUrl: "http://127.0.0.1", loopbackOnly: true, ...extra }).listen(0, "127.0.0.1", () => {
          base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
          resolve();
        });
      });
    const stop = (): Promise<void> => new Promise((r) => server.close(() => r()));
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

    it("serves the manifest, policy, check, audit and errors", async () => {
      await start();
      try {
        const m = (await (await fetch(`${base}/.well-known/vekil-guard.json`)).json()) as { name: string; chain: { contract: string } };
        expect(m.name).toBe("VEKİL Guard");
        expect(m.chain.contract).toBe(lc.chain.address);

        const p = (await (await fetch(`${base}/v1/policy`)).json()) as { policyVersion: number; policy: { instIds: string[] } };
        expect(p.policy.instIds).toEqual(["AVAX-TRY"]);

        // The audit test above used this hour's single approval: the live counter now says no.
        const okRes = await post("/v1/check", VALID);
        expect(okRes.status).toBe(200);
        const hourly = (await okRes.json()) as { verdict: string; reasons: { code: string }[] };
        expect(hourly.verdict).toBe("REJECT");
        expect(hourly.reasons.map((x) => x.code)).toEqual(["HOURLY_LIMIT"]);

        const r1 = (await (await post("/v1/check", R1)).json()) as { verdict: string; wouldPause: boolean };
        expect(r1).toMatchObject({ verdict: "REJECT", wouldPause: true });

        expect((await post("/v1/check", { ...VALID, px: "1.123456789" })).status).toBe(400);
        expect((await post("/v1/check", { ...VALID, side: "sell" })).status).toBe(400);
        expect((await post("/v1/check", { ...VALID, extra: 1 })).status).toBe(400);
        expect((await fetch(`${base}/v1/audit/manual-1`)).status).toBe(200);
        expect((await post("/v1/policy/propose", { text: "Sadece AVAX" })).status).toBe(503);
        expect((await fetch(`${base}/nope`)).status).toBe(404);
        // fetch can't set Host; a raw request can (DNS-rebinding hardening on loopback).
        const status = await new Promise<number>((resolve, reject) => {
          const u = new URL(`${base}/v1/policy`);
          request({ host: u.hostname, port: u.port, path: u.pathname, headers: { host: "evil.example" } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          }).on("error", reject).end();
        });
        expect(status).toBe(403);
      } finally {
        await stop();
      }
    });

    it("simulated per-check price answers 402 without x-payment", async () => {
      await start({ pricePerCheck: "0.01" });
      try {
        expect((await post("/v1/check", VALID)).status).toBe(402);
        expect((await post("/v1/check", VALID, { "x-payment": "demo" })).status).toBe(200);
        expect((await post("/v1/check", { ...VALID, sz: "0.0001" }, { "x-payment": "demo" })).status).toBe(200);
      } finally {
        await stop();
      }
    });

    it("propose returns a draft that is never applied", async () => {
      await start({
        propose: async () => ({ policy: lc.policy, summaryTr: "özet", mapping: [], assumptions: [], questions: [], errors: [] }),
      });
      try {
        const body = (await (await post("/v1/policy/propose", { text: "Sadece AVAX işlem yap." })).json()) as { applied: boolean; summaryTr: string };
        expect(body).toMatchObject({ applied: false, summaryTr: "özet" });
      } finally {
        await stop();
      }
    });

    it("rate-limits one client", async () => {
      await start({ ratePerMin: 2 });
      try {
        expect((await fetch(`${base}/.well-known/vekil-guard.json`)).status).toBe(200);
        expect((await fetch(`${base}/.well-known/vekil-guard.json`)).status).toBe(200);
        expect((await fetch(`${base}/.well-known/vekil-guard.json`)).status).toBe(429);
      } finally {
        await stop();
      }
    });
  });
});

describe("worstCaseQuote matches the contract's integer rounding", () => {
  it("floors each step like VekilPolicy", () => {
    const req: OrderRequest = {
      instId: "AVAX-TRY", side: "buy", px: "494.7", sz: "0.0909", stopPx: "488.8", tpPx: "0", timeStopMin: 60,
      decisionHash: keccakUtf8("d"), nonce: keccakUtf8("n"),
    };
    // (494.7 − 488.8) × 0.0909 = 0.53631; fees 44.96823 × 70 / 10000 = 0.314777610 → 0.31477761 (floored)
    expect(worstCaseQuote(req, 20, 30)).toBe("0.85108761");
  });
});
