// GET /.well-known/vekil-guard.json (rewritten here) — the service description for agent marketplaces (OKX.AI).
import { send, vekil } from "./_vekil.js";

export default function handler(req, res) {
  const base = `https://${req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost"}`;
  return send(res, 200, {
    schema: "vekil-guard/1",
    name: "VEKİL Guard",
    version: "0.1.0",
    summary: {
      tr: "Ajanın emrini göndermeden önce sor: Avalanche'taki VekilPolicy kontratı bu emri onaylar mı, reddeder mi? Kontratın kural motoru eth_call ile simüle edilir; işlem gönderilmez, anahtar ya da para istenmez.",
      en: "Ask before your agent sends an order: would the VekilPolicy contract on Avalanche approve or reject it? Simulated with eth_call; no transaction, no keys, no funds.",
    },
    chain: { chainId: vekil.options.chainId, name: "Avalanche Fuji C-Chain", contract: vekil.address, explorer: `${vekil.options.explorer}/address/${vekil.address}` },
    auth: { type: "none", note: "Guard holds no keys and changes no state." },
    pricing: { model: "free (demo)", plan: "per-check fee or subscription; B2B policy-layer API for exchanges and agent platforms" },
    endpoints: [
      { method: "GET", path: `${base}/api/policy`, description: "On-chain rules, version, brake state, today's counters." },
      { method: "POST", path: `${base}/api/check`, description: "Simulate requestApproval for a spot long order → APPROVE/REJECT with reason codes, critical, wouldPause.", input: { instId: "AVAX-TRY", px: "490", sz: "0.15", stopPx: "476", tpPx: "510" } },
      { method: "GET", path: `${base}/api/audit?clOrdId=v…`, description: "Is this exchange order approved on-chain?" },
    ],
    links: { site: base, source: "https://github.com/Omeraydognn/vekil" },
  });
}
