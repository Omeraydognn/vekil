// GET /api/audit?clOrdId=v… — is this exchange order approved on-chain?
import { send, short, vekil } from "./_vekil.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const id = new URL(req.url, "http://x").searchParams.get("clOrdId") ?? "";
  if (id.length < 1 || id.length > 64) return send(res, 400, { error: "clOrdId gerekli (1–64 karakter)" });
  try {
    return send(res, 200, await vekil.audit(id));
  } catch (e) {
    return send(res, 502, { error: short(e) });
  }
}
