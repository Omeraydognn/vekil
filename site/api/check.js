// POST /api/check — VEKİL Guard: would the VekilPolicy contract approve this order right now? (eth_call, no tx)
import { readJson, send, short, vekil } from "./_vekil.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "POST kullanın" });
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return send(res, 400, { error: short(e) });
  }
  try {
    return send(res, 200, await vekil.check(body));
  } catch (e) {
    const msg = short(e);
    return send(res, /en fazla 8|gerekli|bilinmeyen|desteklenir|tam sayı|çok büyük/.test(msg) ? 400 : 502, { error: msg });
  }
}
