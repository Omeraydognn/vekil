// Order hash and order IDs (SPEC §9.2). Must match VekilPolicy.hashOrderFor exactly.
import { encodeAbiParameters, keccak256 } from "viem";
import { keccakUtf8, lowerHex32, type Hex32 } from "./hash.js";
import { toScaled } from "./money.js";

export interface OrderRequestInput {
  instId: string;
  side: "buy";
  px: string;
  sz: string;
  stopPx: string;
  tpPx: string;
  timeStopMin: number;
  decisionHash: string;
  nonce: string;
}

export interface ChainOrder {
  instId: Hex32;
  side: number;
  px: bigint;
  sz: bigint;
  stopPx: bigint;
  tpPx: bigint;
  timeStopMin: number;
  decisionHash: Hex32;
  nonce: Hex32;
}

export const ORDER_TUPLE = {
  type: "tuple",
  components: [
    { name: "instId", type: "bytes32" },
    { name: "side", type: "uint8" },
    { name: "px", type: "uint64" },
    { name: "sz", type: "uint64" },
    { name: "stopPx", type: "uint64" },
    { name: "tpPx", type: "uint64" },
    { name: "timeStopMin", type: "uint32" },
    { name: "decisionHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const CLORDID_RE = /^[vx][0-9a-f]{30}$/;
export const ENTRY_CLORDID_RE = /^v[0-9a-f]{30}$/;
export const EXIT_CLORDID_RE = /^x[0-9a-f]{30}$/;
const UINT32_MAX = 0xffff_ffff;

/** bytes32 instrument key = keccak256(utf8(instId)). */
export const instIdHash = (instId: string): Hex32 => keccakUtf8(instId);

export function toChainOrder(req: OrderRequestInput): ChainOrder {
  if (req.side !== "buy") throw new Error(`unsupported side: ${String(req.side)}`);
  if (!Number.isSafeInteger(req.timeStopMin) || req.timeStopMin < 0 || req.timeStopMin > UINT32_MAX) {
    throw new Error(`timeStopMin out of uint32 range: ${req.timeStopMin}`);
  }
  return {
    instId: instIdHash(req.instId),
    side: 1,
    px: toScaled(req.px),
    sz: toScaled(req.sz),
    stopPx: toScaled(req.stopPx),
    tpPx: toScaled(req.tpPx),
    timeStopMin: req.timeStopMin,
    decisionHash: lowerHex32(req.decisionHash),
    nonce: lowerHex32(req.nonce),
  };
}

/** orderHash = keccak256(abi.encode(uint256 chainId, address policy, OrderRequest)). */
export function orderHash(chainId: number, policy: string, req: OrderRequestInput): Hex32 {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`bad chainId: ${chainId}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(policy)) throw new Error(`bad policy address: ${policy}`);
  const enc = encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, ORDER_TUPLE],
    [BigInt(chainId), policy as `0x${string}`, toChainOrder(req)],
  );
  return keccak256(enc);
}

/** First 15 bytes of a 32-byte hash as 30 lowercase hex chars (the contract's bytes15 key). */
export function hashPrefix30(hash: string): string {
  return lowerHex32(hash).slice(2, 32);
}

/** Entry clOrdId = "v" + hex(orderHash[0..15)). */
export const entryClOrdId = (orderHashHex: string): string => `v${hashPrefix30(orderHashHex)}`;

/** keccak256(abi.encode(bytes32 entryOrderHash, bytes32 exitNonce)); exitNonce is 32 random bytes (U1). */
export function exitHash(entryOrderHash: string, exitNonce: string): Hex32 {
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [lowerHex32(entryOrderHash), lowerHex32(exitNonce)]),
  );
}

/** Exit clOrdId = "x" + hex(exitHash[0..15)). */
export const exitClOrdId = (entryOrderHash: string, exitNonce: string): string =>
  `x${hashPrefix30(exitHash(entryOrderHash, exitNonce))}`;

/** "v…"/"x…" clOrdId → its 30-hex prefix. */
export function clOrdIdPrefix(clOrdId: string): string {
  if (!CLORDID_RE.test(clOrdId)) throw new Error(`not a VEKİL clOrdId: ${clOrdId}`);
  return clOrdId.slice(1);
}
