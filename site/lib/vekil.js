// VEKİL public, keyless client: shared by the browser page and the Vercel Guard API.
// It only READS the VekilPolicy contract and simulates requestApproval with eth_call (no key, no tx, no state change).
// Mirrors src/guard/guard.ts and src/shared/{money,reasons}.ts; the main app's tests cover the same rules.
import { vekilPolicyAbi } from "./abi.js";

export const DEFAULTS = {
  chainId: 43113,
  rpcUrl: "https://avalanche-fuji-c-chain-rpc.publicnode.com",
  // dev VekilPolicy on Fuji (README "Deployments and evidence"); override with VEKIL_POLICY_ADDRESS on Vercel.
  address: "0x75c9b0155b0b026f869351ab3450723c44e57999",
  explorer: "https://testnet.snowtrace.io",
  erc8004Registry: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
};

export const POLICY_REASONS = [
  "PAUSED", "POLICY_EXPIRED", "INSTRUMENT_NOT_ALLOWED", "SIDE_NOT_ALLOWED", "ZERO_VALUE", "ORDER_TOO_LARGE", "STOP_MISSING",
  "STOP_INVALID", "STOP_TOO_TIGHT", "STOP_TOO_WIDE", "TP_INVALID", "TIME_STOP_INVALID", "HOURLY_LIMIT", "DAILY_LIMIT", "RISK_BUDGET_EXCEEDED",
];
export const REASON_TR = {
  PAUSED: "Kontrat freni aktif", POLICY_EXPIRED: "Kuralların süresi dolmuş", INSTRUMENT_NOT_ALLOWED: "Bu çift izinli değil",
  SIDE_NOT_ALLOWED: "Bu yönde işlem izinli değil", ZERO_VALUE: "Fiyat veya miktar sıfır", ORDER_TOO_LARGE: "İşlem tutarı limiti aşıyor",
  STOP_MISSING: "Zarar-kes yok", STOP_INVALID: "Zarar-kes seviyesi geçersiz", STOP_TOO_TIGHT: "Zarar-kes çok yakın", STOP_TOO_WIDE: "Zarar-kes çok uzak",
  TP_INVALID: "Kâr-al seviyesi geçersiz", TIME_STOP_INVALID: "Süre sınırı geçersiz", HOURLY_LIMIT: "Saatlik işlem sınırı doldu",
  DAILY_LIMIT: "Günlük işlem sınırı doldu", RISK_BUDGET_EXCEEDED: "Günlük risk bütçesi aşılır",
};
export const CRITICAL_MASK = (1 << 2) | (1 << 3) | (1 << 6);

const SCALE = 100000000n;
const UINT64_MAX = (1n << 64n) - 1n;
const DEC8 = /^\d+(\.\d{1,8})?$/;

/** Exact ×1e8 (same rule as src/shared/money.ts toScaled). */
export function toScaled(s) {
  if (typeof s !== "string" || !DEC8.test(s)) throw new Error(`"${s}": en fazla 8 ondalıklı, negatif olmayan bir sayı olmalı (nokta ile)`);
  const [i, f = ""] = s.split(".");
  const v = BigInt(i) * SCALE + BigInt(f.padEnd(8, "0") || "0");
  if (v > UINT64_MAX) throw new Error(`"${s}" çok büyük`);
  return v;
}
export function fromScaled(v) {
  const n = BigInt(v);
  const i = n / SCALE;
  const f = (n % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return f ? `${i}.${f}` : `${i}`;
}
export function maskToReasons(mask) {
  // Unknown bits (e.g. a newer contract) must never read as APPROVE: fail closed like src/shared/reasons.ts.
  if (!Number.isInteger(mask) || mask < 0 || (mask & ~0x7fff) !== 0) throw new Error(`bilinmeyen ret kodu: ${mask}`);
  return POLICY_REASONS.filter((_, i) => (mask & (1 << i)) !== 0);
}
export const withTr = (codes) => codes.map((code) => ({ code, tr: REASON_TR[code] ?? code }));

const hex32 = (h) => /^0x[0-9a-fA-F]{64}$/.test(h);
const rand32 = () => {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
};

/** Validates a check request body (instId, px, sz, stopPx?, tpPx?, timeStopMin?). Throws a Turkish message. */
export function parseCheck(body) {
  if (!body || typeof body !== "object") throw new Error("JSON gövde gerekli");
  const allowed = new Set(["instId", "side", "px", "sz", "stopPx", "tpPx", "timeStopMin"]);
  for (const k of Object.keys(body)) if (!allowed.has(k)) throw new Error(`bilinmeyen alan: ${k}`);
  if (body.side !== undefined && body.side !== "buy") throw new Error("sadece alım (buy) desteklenir: VEKİL long-only");
  if (typeof body.instId !== "string" || body.instId.length < 1 || body.instId.length > 32) throw new Error("instId gerekli (örn. AVAX-TRY)");
  const t = body.timeStopMin;
  if (t !== undefined && !(Number.isInteger(t) && t >= 0 && t <= 0xffffffff)) throw new Error("timeStopMin 0..4294967295 tam sayı olmalı");
  return {
    instId: body.instId,
    px: toScaled(body.px), sz: toScaled(body.sz),
    stopPx: toScaled(body.stopPx ?? "0"), tpPx: toScaled(body.tpPx ?? "0"),
    timeStopMin: t,
  };
}

/** @param viem the viem module (browser: esm.sh build; server: npm package) */
export function makeVekil(viem, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const address = o.address.toLowerCase();
  const chain = viem.defineChain({ id: o.chainId, name: `chain-${o.chainId}`, nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 }, rpcUrls: { default: { http: [o.rpcUrl] } } });
  const pub = viem.createPublicClient({ chain, transport: viem.http(o.rpcUrl, { retryCount: 1 }) });
  const read = (functionName, args = [], blockNumber) =>
    pub.readContract({ address, abi: vekilPolicyAbi, functionName, args, ...(blockNumber === undefined ? {} : { blockNumber }) });
  const txUrl = (h) => `${o.explorer}/tx/${h}`;

  async function policy() {
    const block = await pub.getBlock({ blockTag: "latest" });
    const bn = block.number;
    const [[p, instIds, version, paused, srcHash], agent, owner, agentId, counters, lastAnchoredSeq] = await Promise.all([
      read("getPolicy", [], bn), read("agent", [], bn), read("owner", [], bn), read("agentId", [], bn), read("counters", [], bn), read("lastAnchoredSeq", [], bn),
    ]);
    return {
      contract: address, chainId: o.chainId, explorer: `${o.explorer}/address/${address}`,
      policyVersion: Number(version), paused, sourceTextHash: srcHash,
      policy: {
        instIds: [...instIds],
        maxOrderQuote: fromScaled(p.maxOrderQuote), dailyRiskBudgetQuote: fromScaled(p.dailyRiskBudget),
        maxTradesPerHour: p.maxTradesPerHour, maxTradesPerDay: p.maxTradesPerDay,
        minStopDistancePct: String(p.minStopBps / 100), maxStopDistancePct: String(p.maxStopBps / 100),
        maxHoldMin: p.maxHoldMin, feeBps: p.feeBps, slippageBps: p.slippageBps, validUntil: Number(p.validUntil) * 1000,
      },
      agent: agent.toLowerCase(), owner: owner.toLowerCase(), erc8004AgentId: Number(agentId),
      counters: { tradesInHour: counters[2], tradesInDay: counters[3], riskUsedToday: fromScaled(counters[4]) },
      lastAnchoredSeq: Number(lastAnchoredSeq),
      blockNumber: Number(bn), blockTimestamp: Number(block.timestamp),
    };
  }

  /** The source text lives only in the PolicySet event; the page shows it if the RPC returns the log. */
  const sourceCache = new Map();
  async function sourceText(version) {
    if (sourceCache.has(version)) return sourceCache.get(version);
    const found = await findSourceText(version);
    if (found) sourceCache.set(version, found);
    return found;
  }
  async function findSourceText(version) {
    const ev = viem.parseAbiItem("event PolicySet(uint64 indexed version, bytes32 policyHash, bytes32 sourceTextHash, string sourceText, string[] instIds, (uint64,uint64,uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint64) p)");
    const latest = await pub.getBlockNumber();
    for (let to = latest, i = 0; i < 20; i++) {
      const from = to > 2000n ? to - 2000n : 0n;
      const logs = await pub.getLogs({ address, event: ev, args: { version: BigInt(version) }, fromBlock: from, toBlock: to });
      if (logs.length) return { text: logs[logs.length - 1].args.sourceText, txHash: logs[logs.length - 1].transactionHash };
      if (from === 0n) break;
      to = from - 1n;
    }
    return null;
  }

  /** Simulate requestApproval (eth_call from the agent address). */
  async function check(body) {
    const req = parseCheck(body);
    const view = await policy();
    const order = {
      instId: viem.keccak256(viem.stringToBytes(req.instId)), side: 1,
      px: req.px, sz: req.sz, stopPx: req.stopPx, tpPx: req.tpPx,
      timeStopMin: req.timeStopMin ?? view.policy.maxHoldMin,
      decisionHash: viem.keccak256(viem.stringToBytes("vekil-guard:simulated-check")), nonce: rand32(),
    };
    const block = BigInt(view.blockNumber);
    const { result } = await pub.simulateContract({ address, abi: vekilPolicyAbi, functionName: "requestApproval", args: [order], account: view.agent, blockNumber: block });
    const mask = Number(result[1]);
    const reasons = maskToReasons(mask);
    const notional = (req.px * req.sz) / SCALE;
    const max = toScaled(view.policy.maxOrderQuote);
    const critical = reasons.length > 0 && ((mask & CRITICAL_MASK) !== 0 || notional > 2n * max);
    let worstCase = null;
    if (req.stopPx > 0n && req.stopPx < req.px) {
      worstCase = fromScaled(((req.px - req.stopPx) * req.sz) / SCALE + (notional * BigInt(2 * view.policy.feeBps + view.policy.slippageBps)) / 10000n);
    }
    return {
      verdict: reasons.length === 0 ? "APPROVE" : "REJECT",
      reasons: withTr(reasons), critical,
      wouldPause: critical && (mask & 1) === 0,
      notional: fromScaled(notional), worstCase,
      policyVersion: view.policyVersion, paused: view.paused,
      chain: { chainId: o.chainId, contract: address, blockNumber: view.blockNumber, asAgent: view.agent },
      simulated: true,
      note: "eth_call simülasyonu: işlem gönderilmedi, zincir durumu değişmedi.",
    };
  }

  /** Is this exchange order approved on-chain? v… = entry, x… = exit, else manual. */
  async function audit(clOrdId) {
    if (typeof clOrdId !== "string" || !/^[vx][0-9a-f]{30}$/.test(clOrdId)) return { clOrdId, kind: "MANUAL", detail: "VEKİL emri değil (manuel)" };
    const prefix = `0x${clOrdId.slice(1)}`;
    const zero = `0x${"0".repeat(64)}`;
    if (clOrdId[0] === "v") {
      const h = await read("orderHashByPrefix", [prefix]);
      if (h === zero) return { clOrdId, kind: "ENTRY", approved: false, detail: "Zincirde bu emir için onay yok" };
      const a = await read("approvals", [h]);
      return { clOrdId, kind: "ENTRY", approved: Number(a[0]) === 1, orderHash: h, approvedAt: Number(a[2]), worstCase: fromScaled(a[5]), detail: Number(a[0]) === 1 ? "Zincirde onaylı" : `onay durumu ${a[0]}` };
    }
    const entry = await read("entryByExitPrefix", [prefix]);
    if (entry === zero) return { clOrdId, kind: "EXIT", recorded: false, detail: "Çıkış zincirde kayıtlı değil" };
    return { clOrdId, kind: "EXIT", recorded: true, entryOrderHash: entry, detail: "Çıkış zincirde kayıtlı" };
  }

  /** On-chain Merkle inclusion proof (VekilPolicy.verifyEntry). */
  async function verifyProof(anchorIndex, entryHash, proof) {
    if (!hex32(entryHash) || !Array.isArray(proof) || !proof.every(hex32)) throw new Error("geçersiz kanıt");
    return read("verifyEntry", [BigInt(anchorIndex), entryHash, proof]);
  }

  return { policy, sourceText, check, audit, verifyProof, txUrl, address, options: o };
}
