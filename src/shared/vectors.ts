// FROZEN VECTORS (M0). Computed independently with Foundry `cast abi-encode` + `cast keccak`,
// not with our TypeScript. TS tests and forge tests assert the same constants.
// Never change a value to make a test pass: a mismatch means the encoding is wrong.
import type { OrderRequestInput } from "./order-hash.js";

const H = (byte: string): string => `0x${byte.repeat(32)}`;

// ---- order hash (SPEC §9.2) ----
export const VECTOR_CHAIN_ID = 43113;
export const VECTOR_POLICY = "0x5fbdb2315678afecb367f032d93f642f64180aa3"; // anvil's first deploy address
export const VECTOR_REQ: OrderRequestInput = {
  instId: "AVAX-TRY",
  side: "buy",
  px: "494.7", // 49470000000
  sz: "0.40428", // 40428000
  stopPx: "488.8", // 48880000000
  tpPx: "506.6", // 50660000000
  timeStopMin: 240,
  decisionHash: H("11"),
  nonce: H("22"),
};
export const VECTOR_INST_ID_HASH = "0x961cc17d242bfaa4355d8d832dd3060b5cb7d2f87d294da145475200eaf1c4c4";
export const VECTOR_ORDER_HASH = "0x97c45554ff62e3d9cf7674f5c240d5cff5b476ef600e23ab8ff49be00677bb94";
export const VECTOR_ENTRY_CLORDID = "v97c45554ff62e3d9cf7674f5c240d5";
export const VECTOR_EXIT_NONCE = H("33");
export const VECTOR_EXIT_HASH = "0xfe31d00e8119c79124cb6837bfa3b65278922646e6c5d480b5495f07987d8c61";
export const VECTOR_EXIT_CLORDID = "xfe31d00e8119c79124cb6837bfa3b6";

// R1-sized request (≈10,000 TL of DOGE-TRY at 7.007, no stop) on anvil's chainId 31337.
// These are the overflow-test values from SPEC §23.4: px = 700700000, sz = 142714428000.
export const VECTOR_R1_CHAIN_ID = 31337;
export const VECTOR_R1_REQ: OrderRequestInput = {
  instId: "DOGE-TRY",
  side: "buy",
  px: "7.007",
  sz: "1427.14428",
  stopPx: "0",
  tpPx: "0",
  timeStopMin: 480,
  decisionHash: H("11"),
  nonce: H("22"),
};
export const VECTOR_R1_ORDER_HASH = "0x19d72f425c30a6c3408fc8c3fedb1e7e1f8cac944c8b2af8d9235ad69d740f73";

// ---- Merkle (SPEC §9.7): entryHash_i = keccak256(utf8("vekil-entry-" + i)), i = 1..5 ----
export const VECTOR_ENTRY_HASHES = [
  "0x176d1307aa23436458551d6d25e6a085b3390d8e8c69dae3cba7df5ecd41f914",
  "0x9cd94e4897626dafc7556380ba8a8f4560ef04fbf8a3b48ca9212120c240051d",
  "0xdd74f3adda9f0b46ae99bdc9d647c83722cec7d734c420c2422a863e3c200464",
  "0xc4a1373405839be48793bf3e2cbfe02aaeceb1f29581d9a555bbe7fee14e54af",
  "0x55acb599db31a7337c1326d2141198b946e907606abaf476d7b28df6b3118659",
] as const;
export const VECTOR_LEAVES = [
  "0x2317e718883e0819ef8b538b0816289e105bac61dc281ce036a9b198a2e76fce",
  "0x8456f9e01e2dcb877839ffd5e7cac6ab1034af36753eaf3406ec4dbd19fdab6c",
  "0xf8440c5d96ec78f833a5482690f855e2fffc421ed1d5aa9162a00cbcc06327d0",
  "0x2f3a433dafe17389e5e85d9e8e74c485e4d4358ef60c5d8550f9edecf902bfd3",
  "0xac29abeed4528883723f53f7b1f92ecb7ec3838a15876814a3868c4d50ab4ace",
] as const;
export const VECTOR_NODE_12 = "0x38b88284f69760e30f0828460c1c592e03db47936d7d5739f9bd10e650ac56ad";
export const VECTOR_NODE_34 = "0x53edd7a3a200a8c8a2c2eaf6262419000e5996fad7689e83db49153fe134d0d7";
export const VECTOR_NODE_1234 = "0x9876ad988a81c0fcc945dcb238144bed853fecc04ed9e898048d61281fe250d0";
export const VECTOR_ROOT_1 = VECTOR_LEAVES[0];
export const VECTOR_ROOT_2 = VECTOR_NODE_12;
export const VECTOR_ROOT_3 = "0x40f1b93b7e7ea934f750f20d7fa7acdcf3a5149eda297d39bcddaadf69c0aee4";
export const VECTOR_ROOT_5 = "0xb0888dd4f889eef82ed87a9974da223c4d4f236634e97762d418e02c6d740f63";
/** Proofs for the 5-leaf tree, by index (leaf 5 is carried up twice, so its proof has one item). */
export const VECTOR_PROOFS_5 = [
  [VECTOR_LEAVES[1], VECTOR_NODE_34, VECTOR_LEAVES[4]],
  [VECTOR_LEAVES[0], VECTOR_NODE_34, VECTOR_LEAVES[4]],
  [VECTOR_LEAVES[3], VECTOR_NODE_12, VECTOR_LEAVES[4]],
  [VECTOR_LEAVES[2], VECTOR_NODE_12, VECTOR_LEAVES[4]],
  [VECTOR_NODE_1234],
] as const;

// ---- policy hash (SPEC §13.1, U2): keccak256(abi.encode(Policy, bytes32[] instIdHashes, sourceTextHash)) ----
export const VECTOR_VALID_UNTIL_MS = 1_792_270_799_000; // 2026-10-17 23:59:59 Europe/Istanbul
export const VECTOR_POLICY_DEFAULT = {
  instIds: ["AVAX-TRY"],
  maxOrderQuote: "200",
  dailyRiskBudgetQuote: "100",
  maxTradesPerHour: 1,
  maxTradesPerDay: 4,
  minStopDistancePct: "0.3",
  maxStopDistancePct: "3",
  maxHoldMin: 480,
  feeBps: 20,
  slippageBps: 30,
  validUntil: VECTOR_VALID_UNTIL_MS,
  sourceText: "",
};
export const VECTOR_POLICY_DEFAULT_HASH = "0xd81ec4bd2adba3c63cb39c8e3a637bed2a57a8c377089df672b9736604a1127c";
export const VECTOR_POLICY_2 = {
  instIds: ["AVAX-TRY", "BTC-TRY"],
  maxOrderQuote: "50",
  dailyRiskBudgetQuote: "25",
  maxTradesPerHour: 3,
  maxTradesPerDay: 10,
  minStopDistancePct: "0.5",
  maxStopDistancePct: "2.5",
  maxHoldMin: 240,
  feeBps: 15,
  slippageBps: 25,
  validUntil: VECTOR_VALID_UNTIL_MS,
  sourceText: "Sadece AVAX ve BTC işlem yap. İşlem başına en fazla 50 TL.",
};
export const VECTOR_POLICY_2_SOURCE_TEXT_HASH = "0x0f759e8de8aa0dc0b516e8d7e683d300a2d9334637c20e650040b48e1e0d2fec";
export const VECTOR_POLICY_2_HASH = "0x715037022924ddc2bcb237f8673a13ae1c7a2482b529c2df2ae952f83d8856ab";
