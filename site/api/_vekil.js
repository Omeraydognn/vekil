// Shared setup for the Guard API functions on Vercel. Keyless: env only picks the contract and RPC.
import * as viem from "viem";
import { DEFAULTS, makeVekil } from "../lib/vekil.js";

export const vekil = makeVekil(viem, {
  rpcUrl: process.env.FUJI_RPC_URL || DEFAULTS.rpcUrl,
  address: process.env.VEKIL_POLICY_ADDRESS || DEFAULTS.address,
});

/** JSON with bigint-safe serialization and CORS (read-only API; anyone may call it). */
export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error("gövde çok büyük");
  }
  return raw ? JSON.parse(raw) : {};
}

export const short = (e) => (e && typeof e === "object" && typeof e.shortMessage === "string" ? e.shortMessage : e instanceof Error ? e.message.split("\n")[0] : String(e)).slice(0, 300);
