// Policy ↔ on-chain encoding and policyHash (SPEC §9.1, §13.1; decision U2).
// policyHash = keccak256(abi.encode(Policy p, bytes32[] instIdHashes, bytes32 sourceTextHash)).
import { encodeAbiParameters, keccak256 } from "viem";
import { keccakUtf8, type Hex32 } from "./hash.js";
import { bpsToPct2, fromScaled, pct2ToBps, toScaled } from "./money.js";
import { instIdHash } from "./order-hash.js";
import type { Policy } from "./schemas.js";

export interface ChainPolicy {
  maxOrderQuote: bigint;
  dailyRiskBudget: bigint;
  maxTradesPerHour: number;
  maxTradesPerDay: number;
  minStopBps: number;
  maxStopBps: number;
  maxHoldMin: number;
  feeBps: number;
  slippageBps: number;
  validUntil: bigint;
}

export const POLICY_TUPLE = {
  type: "tuple",
  components: [
    { name: "maxOrderQuote", type: "uint64" },
    { name: "dailyRiskBudget", type: "uint64" },
    { name: "maxTradesPerHour", type: "uint16" },
    { name: "maxTradesPerDay", type: "uint16" },
    { name: "minStopBps", type: "uint16" },
    { name: "maxStopBps", type: "uint16" },
    { name: "maxHoldMin", type: "uint16" },
    { name: "feeBps", type: "uint16" },
    { name: "slippageBps", type: "uint16" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

const UINT16_MAX = 0xffff;
function u16(name: string, n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > UINT16_MAX) throw new Error(`${name} out of uint16 range: ${n}`);
  return n;
}

export function toChainPolicy(p: Policy): ChainPolicy {
  if (p.validUntil % 1000 !== 0) throw new Error("validUntil must be a whole second");
  return {
    maxOrderQuote: toScaled(p.maxOrderQuote),
    dailyRiskBudget: toScaled(p.dailyRiskBudgetQuote),
    maxTradesPerHour: u16("maxTradesPerHour", p.maxTradesPerHour),
    maxTradesPerDay: u16("maxTradesPerDay", p.maxTradesPerDay),
    minStopBps: u16("minStopBps", pct2ToBps(p.minStopDistancePct)),
    maxStopBps: u16("maxStopBps", pct2ToBps(p.maxStopDistancePct)),
    maxHoldMin: u16("maxHoldMin", p.maxHoldMin),
    feeBps: u16("feeBps", p.feeBps),
    slippageBps: u16("slippageBps", p.slippageBps),
    validUntil: BigInt(p.validUntil / 1000),
  };
}

/** Rebuild the TS Policy from the contract struct, its instId strings and the source text. */
export function fromChainPolicy(c: ChainPolicy, instIds: string[], sourceText: string): Policy {
  return {
    instIds: [...instIds],
    maxOrderQuote: fromScaled(c.maxOrderQuote),
    dailyRiskBudgetQuote: fromScaled(c.dailyRiskBudget),
    maxTradesPerHour: c.maxTradesPerHour,
    maxTradesPerDay: c.maxTradesPerDay,
    minStopDistancePct: bpsToPct2(c.minStopBps),
    maxStopDistancePct: bpsToPct2(c.maxStopBps),
    maxHoldMin: c.maxHoldMin,
    feeBps: c.feeBps,
    slippageBps: c.slippageBps,
    validUntil: safeMs(c.validUntil),
    sourceText,
  };
}

function safeMs(sec: bigint): number {
  const ms = sec * 1000n;
  if (ms > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`validUntil out of safe range: ${sec}`);
  return Number(ms);
}

export const sourceTextHash = (text: string): Hex32 => keccakUtf8(text);

export function policyHash(p: Policy): Hex32 {
  return keccak256(
    encodeAbiParameters(
      [POLICY_TUPLE, { type: "bytes32[]" }, { type: "bytes32" }],
      [toChainPolicy(p), p.instIds.map(instIdHash), sourceTextHash(p.sourceText)],
    ),
  );
}
