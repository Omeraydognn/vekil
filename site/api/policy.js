// GET /api/policy — the owner's on-chain rules, version, brake, today's counters (plus the Turkish source text).
import { send, short, vekil } from "./_vekil.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  try {
    const p = await vekil.policy();
    const src = await vekil.sourceText(p.policyVersion).catch(() => null);
    return send(res, 200, { ...p, sourceText: src?.text ?? null, policySetTx: src ? vekil.txUrl(src.txHash) : null });
  } catch (e) {
    return send(res, 502, { error: short(e) });
  }
}
