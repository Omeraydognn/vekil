// VEKİL Guard service description: served at /.well-known/vekil-guard.json and written to docs/guard-manifest.json.

export interface ManifestOpts {
  baseUrl: string;
  chainId: number;
  contract: string;
  pricePerCheck: string | null;
}

const CHAIN_NAMES: Record<number, string> = { 31337: "anvil (local)", 43113: "Avalanche Fuji C-Chain", 43114: "Avalanche C-Chain" };
const EXPLORER: Record<number, string> = { 43113: "https://testnet.snowtrace.io/address/", 43114: "https://snowtrace.io/address/" };

export function guardManifest(o: ManifestOpts) {
  return {
    schema: "vekil-guard/1",
    name: "VEKİL Guard",
    version: "0.1.0",
    summary: {
      tr: "Ajanın emrini göndermeden önce sor: Avalanche'taki VekilPolicy kontratı bu emri onaylar mı, reddeder mi? Kontratın kural motoru eth_call ile simüle edilir; işlem gönderilmez, anahtar ya da para istenmez.",
      en: "Ask before your agent sends an order: would the VekilPolicy contract on Avalanche approve or reject it? The contract's rule engine is simulated with eth_call; no transaction, no keys, no funds.",
    },
    audience: ["trading agents (OKX Agent Trade Kit and others)", "agent platforms that need a pre-trade policy check", "auditors"],
    chain: { chainId: o.chainId, name: CHAIN_NAMES[o.chainId] ?? `chain ${o.chainId}`, contract: o.contract, explorer: EXPLORER[o.chainId] ? `${EXPLORER[o.chainId]}${o.contract}` : null },
    auth: { type: "none", note: "Guard holds no keys and changes no state." },
    pricing: o.pricePerCheck
      ? { model: "per-check", price: o.pricePerCheck, currency: "USDC", status: "simulated (HTTP 402 without an x-payment header; no real payment in the demo)" }
      : { model: "free (demo)", plan: "per-check fee or subscription; B2B policy-layer API for exchanges and agent platforms" },
    endpoints: [
      {
        method: "GET",
        path: "/v1/policy",
        description: "The owner's on-chain rules (incl. the Turkish source text), version, brake state and today's on-chain counters.",
      },
      {
        method: "POST",
        path: "/v1/check",
        description: "Simulate requestApproval for a spot long order. Returns APPROVE or REJECT with the contract's reason codes (Turkish labels), whether it is critical and would pause the contract, notional and worst-case risk.",
        input: { instId: "AVAX-TRY", px: "494.7", sz: "0.0909", stopPx: "488.8 (optional; missing = STOP_MISSING)", tpPx: "optional", timeStopMin: "optional (default: policy maxHoldMin)" },
        output: ["verdict", "reasons[{code,tr}]", "critical", "wouldPause", "notional", "worstCase", "policyVersion", "paused", "chain{chainId,contract,blockNumber,blockTimestamp,asAgent}", "simulated"],
      },
      {
        method: "GET",
        path: "/v1/audit/{clOrdId}",
        description: "Is this exchange order approved on-chain? v… = entry (orderHashByPrefix + approval), x… = exit (entryByExitPrefix), anything else = manual. With ?instId=&side=&px=&sz= it also checks the order matches what the chain approved.",
      },
      {
        method: "POST",
        path: "/v1/policy/propose",
        description: "Turkish rules → structured policy draft with mapping, assumptions and questions (Text-to-Policy). Never applied: only the owner can sign setPolicy.",
        input: { text: "Sadece AVAX işlem yap. İşlem başına en fazla 200 TL. Her işlemde zarar-kes olsun, en fazla %3." },
      },
      { method: "GET", path: "/.well-known/vekil-guard.json", description: "This manifest." },
    ],
    links: { baseUrl: o.baseUrl, source: "https://github.com/Omeraydognn/vekil", spec: "docs/SPEC.md", plan: "docs/GUARD_PLAN.md" },
    limits: [
      "A simulation reflects the chain at one block; a real request can differ if counters or the policy change before it is mined.",
      "Market sanity (spread, price collar, balance) is not part of the contract and not part of this check.",
    ],
  };
}
