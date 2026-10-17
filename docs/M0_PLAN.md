# M0 plan (Prompt 0 answer): written before 10:00, no code

Status: **approved by the human on 17 Oct 2026, 08:10.** All suggested defaults U1–U11 are accepted, and `policy-encode.ts` is part of M0. Code starts at 10:00. Copy these decisions into the PROGRESS.md decisions log at the M0 commit.

---

## 1. VEKİL in 5 bullets

- An autonomous AI agent that trades AVAX-TRY spot, long only and with a small budget, on the owner's OKX TR account through OKX Agent Trade Kit (ATK). The LLM can only **read**: it gets allowlisted read-only ATK tools plus local tools, and its reasoning (regime, playbook, evidence, scenarios, thesis, invalidation, lesson) is shown.
- The owner writes the rules in **Turkish**. An LLM drafts a structured policy, code validates it, the owner confirms it, and it is written to the **VekilPolicy** contract on Avalanche (Fuji). The Turkish source text is in the `PolicySet` event.
- Every entry needs an **on-chain approval**. `requestApproval` judges each order. Rejections are recorded and never reverted. Critical violations (foreign instrument, wrong side, missing stop, more than 2× the size limit) **pause the contract automatically**.
- A separate **executor** process is the only holder of the trade key. It recomputes the order hash, trades only what the chain approved (clOrdId derived from the hash), sells only its own inventory, runs stop/TP/time-stop exits and a pause watcher, and its exits never wait for the chain.
- **Everything is verifiable.** There is a hash-chained ledger, Merkle roots anchored on-chain, and `verifyEntry` inclusion proofs. An independent auditor matches every exchange order to an on-chain approval. A kill switch and the owner exits ("Pozisyonu kapat", "Durdur ve kapat") work in every status.

## 2. The 11 safety invariants, in my own words

1. The LLM never gets an ATK instance that can write. It sees the read-only instance, filtered by the allowlist, plus our local tools.
2. Only `src/executor/` holds the trade key. It sends an entry only for a hash it recomputed itself, and only if that hash is APPROVED on-chain, unexpired, under the same policy version, with the contract not paused. It only sells what it bought. The single exception is the cancel-only client in `scripts/kill.ts`.
3. The contract is the judge. Local preflight checks market sanity only, and it must send every suspected policy violation to the chain, never block it as the final word.
4. Preflight is a pure function: no I/O, no clock, no randomness, Decimal only.
5. Entries fail closed on any error, timeout, stale data or failed check. Exits are never blocked by the chain, a halt or a pause.
6. I never place live orders. I work only in fake/paper with fake/local/fuji. Demo/live start only through `pnpm live`, run by a human.
7. I never read, print, log or commit secrets (`.env`, `~/.okx/`, keys). Settings are overridden on the command line, and `.env` is never edited.
8. There are no withdraw or transfer tools or permissions, and no derivatives, leverage or shorting.
9. Development uses fake/local (anvil), and real runs default to Fuji. Mainnet happens only when the human asks, through human-only scripts.
10. Core and the executor bind only to 127.0.0.1.
11. I never touch `../vekil-live`. I use dev keys, ports 8788/8790 and a per-mode `DATA_DIR`. Tests and smoke always use a temp dir.

## 3. Contradictions and unclear points (not resolved; each has a suggested default)

| # | Where | Issue | Suggested default (needs your OK) |
|---|---|---|---|
| U1 | §9.2 | The exit clOrdId is `keccak256(abi.encode(entryOrderHash, exitNonce))`, but the **type of `exitNonce`** is not specified. | `bytes32`, 32 random bytes. Put the helper in `order-hash.ts` with a frozen vector. |
| U2 | §13.1 vs §9.6 / §16.3 V6 | `policyHash = keccak256(abi.encode(p, instIdHashes, sourceTextHash))` must match a TS value (the POLICY payload, V6), but **no shared encoder or frozen vector** is listed, and `src/shared` is frozen after M0. | Add `src/shared/policy-encode.ts` in M0 (`toChainPolicy`, `policyHash`) with a frozen vector that forge asserts. Otherwise Track C takes `policyHash` from the chain and V6 compares chain to chain. |
| U3 | §13.1 vs §13.2 | `readView().policy` is the TS `Policy`, which includes `sourceText`, but the contract stores only `sourceTextHash`. The text exists only in the `PolicySet` event. | `readView` fills `sourceText` from `policy-cache.json` or the latest `PolicySet` log and checks it against `sourceTextHash`. Track C decides; it doesn't affect M0. |
| U4 | §9.1 vs §13.1 | TS ranges are stricter than the contract: the instId regex vs "1–20 bytes", `maxTradesPerHour ≤ 60`, `maxTradesPerDay ≤ 100`. A policy set via `cast` could fail zod parsing in `readView`. | Keep TS strict for owner input (`PolicySchema`). `readView` parses with a looser `ChainPolicySchema` (contract ranges only). |
| U5 | §6 / CLAUDE "no bigint leaves src/chain" vs §9.2 | `toScaled()` and `orderHash` in `src/shared` need bigints for ABI encoding. | `toScaled*` return `bigint`; that is allowed inside shared helpers. Public outputs are hex strings or Dec. `canonical()` throws on bigint, so nothing leaks into ledger or JSON. |
| U6 | §9.9 vs §23.3 | Smoke calls `executor.monitorTick()`, `executor.pauseWatchTick()`, `FakeExchange.injectRestingOrder()` and `scheduler.tick()`. Only `Scheduler.tick` is in the frozen interfaces. | The in-process `Executor` class (Track B) exposes the ticks; it is not part of `ExecutorApi`. No shared change. |
| U7 | §9.9 `Ledger.append` | No timestamp source is given. | The ledger constructor takes a `Clock` (Track C). No interface change. |
| U8 | §5 vs §11 / §17 | §5 says core holds the read key and the agent chain key, but `applyPolicy` and kill step 3 sign with `OWNER_PRIVATE_KEY` in core. | Accepted as the demo convenience that S1 replaces. Say so in the honest limits. |
| U9 | §9.10 | `Message = Anthropic MessageParam` makes `src/shared` depend on SDK types. | `import type` from `@anthropic-ai/sdk` in `interfaces.ts` (type-only, no runtime import). |
| U10 | §9.2 / §9.4 | `OrderRequest.side` is the literal `"buy"`, so `SIDE_NOT_ALLOWED` can't be produced from TS. | Fine. It is tested only in forge. |
| U11 | §6 | `@okx_ai/okx-trade-mcp` must be pinned to the **global** version, but it is **not installed** on this Mac and `~/.okx` doesn't exist. npm latest is **1.4.8** (beta 1.4.9-beta.2). | You install `npm i -g @okx_ai/okx-trade-mcp@1.4.8` before 10:00, and M0 pins `1.4.8`. |

## 4. M0 scope

M0 covers: the scaffold, `src/shared/**`, the frozen vectors, the `config/atk-allowlist.json` skeleton, and an `anvil --version` check.
M0 does **not** cover: ATK discovery (Track B), contracts (Track C), or any `scripts/*.ts` files. `package.json` lists every §7 script, but the files are created by their owning track; this avoids merge conflicts.

### 4.1 Files

| File | Content |
|---|---|
| `package.json` | `"type": "module"`, `private`, `engines.node >= 20`, `packageManager: pnpm@10.28.2`. Every §7 script exactly. Runtime deps, pinned with `pnpm add -E`: zod, decimal.js, viem, @modelcontextprotocol/sdk, @anthropic-ai/sdk, express, dotenv, @okx_ai/okx-trade-mcp@1.4.8. Dev deps: typescript, tsx, vitest, fast-check, @types/node, @types/express. Versions are whatever is current at 10:00, pinned exactly. |
| `tsconfig.json` | strict, `noUncheckedIndexedAccess`, `module`/`moduleResolution: NodeNext`, target ES2022, `noEmit`, `verbatimModuleSyntax`, `include: ["src", "scripts"]` |
| `vitest.config.ts` | `include: ["src/**/*.test.ts", "scripts/**/*.test.ts"]`, node env |
| `config/atk-allowlist.json` | `{ "llm": [], "core": [], "executorTrade": [] }` (Track B fills it) |
| `src/shared/*.ts` + `*.test.ts` | below |
| `PROGRESS.md` | M0 row, evidence, decisions log (U1–U11 answers) |

### 4.2 `src/shared` modules and exports

**`money.ts`** (decimal.js, string I/O)
- `D(x)`, `SCALE = 1e8`, `UINT64_MAX`, `INT64_MIN/MAX`
- `toScaled(dec): bigint`: exact ×1e8. Throws on more than 8 dp, negative values or values above uint64.
- `toScaledSigned(sdec): bigint`: rounds toward zero to 8 dp, int64 range.
- `fromScaled(bigint | string): Dec`, `fromScaledSigned(...): SDec`
- `pct2ToBps(pct2): number` (exact, else throws), `bpsToPct2(bps): Pct2`
- `ceilToTick`, `floorToTick`, `floorToLot`, `round8Down`
- comparisons `decGt/decGte/decLt/decMin`, `mulDec`, `divDec` (all string in, string out)
- `HARD_MAX_ORDER_QUOTE = "1000"`, `HARD_MAX_DAILY_RISK = "500"` and their scaled `bigint` forms

**`canonical.ts`**: `canonical(x): string` (sorted keys, recursive, no whitespace; throws `CanonicalError` on floats, NaN, ±Infinity, unsafe integers, bigint, functions and symbols; omits `undefined` keys); `sortKeysDeep(x)`.

**`hash.ts`**: `keccakUtf8(s): Hex32`, `hashCanonical(x): Hex32`, `manifestHash(tools: McpTool[]): Hex32` (§9.7: plain `JSON.stringify` of sorted keys, tools sorted by name), `lowerHex32(x)`.

**`order-hash.ts`**
- `instIdHash(instId): Hex32` = keccak256(utf8)
- `toChainOrder(req)`: the struct with scaled bigints and `side: 1`
- `orderHash(chainId, policy, req): Hex32` (viem `encodeAbiParameters`, uint256, address, tuple in §9.2 order)
- `entryClOrdId(orderHash)` = `"v" + hash[2..32]`; `exitClOrdId(entryOrderHash, exitNonce)` (U1); `clOrdIdPrefix(clOrdId): string` (30 hex); `CLORDID_RE = /^[vx][0-9a-f]{30}$/`

**`merkle.ts`**: `merkleLeaf(entryHash)`, `merkleParent(a, b)` (sorted as uint256), `merkleRoot(entryHashes)` (odd last node carried up; one leaf means root = leaf; empty input throws), `merkleProof(entryHashes, index): Hex32[]`, `verifyMerkleProof(entryHash, proof, root): boolean`.

**`policy-encode.ts`** (only if U2 is approved): `toChainPolicy(policy)` (scaled amounts, bps, seconds), `policyHash(policy): Hex32`, `sourceTextHash(text)`.

**`reasons.ts`**
- `POLICY_REASONS` (an ordered array; the index is the bit), `CRITICAL_MASK`, `reasonsToMask`, `maskToReasons`, `isCritical(mask, notionalScaled?, maxOrderQuoteScaled?)`
- `LOCAL_REASONS`, `PIPELINE_CODES`, `EXECUTOR_REFUSALS`, `EXIT_REASONS` + `exitReasonCode()` / `exitReasonFromCode()` (1..6)
- `REASON_TR` (every code from Appendix B), `withTr(codes): { code, tr }[]`, `EXIT_REASON_TR`

**`schemas.ts`** (zod, mapped to §9)

| SPEC | Schemas |
|---|---|
| §9 primitives | `Dec`, `PDec`, `SDec`, `Pct2`, `Ms`, `Hex32`, `Address`, `InstId` |
| §9.1 | `PolicySchema` (ranges, min < max stop, max stop ≤ 20, perDay ≥ perHour, whole-second `validUntil`, 1..8 unique instIds, ≤ 8 dp, hard caps, `sourceText` ≤ 1000); `ChainPolicySchema` (U4); `DEFAULT_POLICY(nowMs)` |
| §9.2 | `OrderRequestSchema` |
| §9.3 | `AgentDecisionSchema` (discriminated on `action`, strips unknown fields; ADJUST needs at least one of `newStopPx`/`newTpPx`; regime/playbook enums; evidence 1..6 × ≤ 140; length limits) |
| §9.4 | `PolicyReasonSchema`, `LocalReasonSchema`, `PipelineCodeSchema`, `ExecutorRefusalSchema`, `ExitReasonSchema` (built from `reasons.ts`) |
| §9.5 | `PositionSchema`, `ExecutorEventSchema` (discriminated on `type`, one data schema per type), `ExecutorStateSchema`, `AgentStateSchema` |
| §9.6 | `LedgerKindSchema`, `LedgerEntrySchema`, `LEDGER_PAYLOAD_SCHEMAS` (one per kind) |
| §9.8 | `CycleResult`, `RedTeamResult`, `KillReport`, `VerifyReport`, `ProofReport`, `AuditReport`, `StartupReport`, `PolicyProposal`, `ExecResult`, `ChainRequestResult`, `TxResult` |
| §9.10 | `InstrumentSpec`, `MarketSnapshot`, `AccountSnapshot`, `Candle`, `OrderState`, `ExecutorHealth`, `ToolTraceItem`, `VekilEvent`, `McpTool`, `ToolDef`, `LlmResponse` |
| §14 / §19 bodies | `ExecuteBody`, `ExitBody`, `AdjustBody`, `ProposeBody`, `ApplyBody`, `CloseBody`, `KillBody`, `VerifyBody`, `RogueBody`, `OwnerNoteBody` (1–300), `AskBody` |

Every schema exports its type via `z.infer`.

**`events.ts`**: `SSE_EVENT_TYPES` (§19), `SseEventType`, `makeEvent(type, data, opts)`, `InMemoryEventBus implements EventBus`.

**`time.ts`**: `TZ = "Europe/Istanbul"`, `TRT_OFFSET_SEC = 10800`, `dayKey(ms)`, `hourIndex(sec)` / `dayIndex(sec)` (same formulas as the contract), `msToSec` (floor), `secToMs`, `endOfDayIstanbul(ms)` (23:59:59.000), `isWholeSecond`, `SystemClock`, `SimClock(startMs, { autoAdvance })` with `advance(ms)` and timers for `sleep`/`every`.

**`arming.ts`**: `armLive()` (called only by `live.ts`), `isLiveArmed({ mode, env })` (live/demo **and** core armed or `EXECUTOR_ARM_TOKEN` set), `assertLiveArmed()`, `__resetArmingForTests()`.

**`config.ts`**: `loadConfig({ env = process.env, dotenv = true })`. It treats empty strings as unset, applies the §8 defaults, derives `dataDir` and `chainId` (31337 / 43113 / 43114) and the RPC URL, and refuses: demo/live without anthropic + fuji/mainnet; a non-loopback `HOST`; fuji/mainnet without `AGENT_PRIVATE_KEY`; anthropic without `ANTHROPIC_API_KEY`. Also `redactConfig(cfg)` for logs. Tests always pass `env` explicitly with `dotenv: false`, so they never read `.env`.

**`interfaces.ts`**: exactly §9.9: `Clock`, `EventBus`, `StateStore<T>`, `Ledger`, `LlmClient`, `AtkReader`, `MarketData`, `Exchange`, `OrderHistorySource`, `PolicyChain` (full §13.2 incl. `ChainView`, `ChainCounters`, `ChainApproval`), `ExecutorApi`, `AgentDeps`, the `RunAgent` type, `VekilCore`, `Scheduler`, `PublicState` (§19), `PreflightInput`/`PreflightResult` (§12 types only), `LlmRequest`/`Message` (U9).

### 4.3 Tests and frozen vectors

**How the vectors get frozen:** expected values come from Foundry's **independent** encoder (`cast abi-encode` + `cast keccak`), not from our own TS. They are pasted as constants, then TS must match them, and Track C asserts the same constants in forge. Nobody may change a vector to make a test pass.

| Test file | Cases |
|---|---|
| `order-hash.test.ts` | **FROZEN:** chainId `43113`, policy `0x5fbdb2315678afecb367f032d93f642f64180aa3` (anvil's first deploy address), req `{ AVAX-TRY, buy, px "494.7", sz "0.40428", stopPx "488.8", tpPx "506.6", timeStopMin 240, decisionHash 0x11…11, nonce 0x22…22 }` → `ORDER_HASH_VECTOR` and `"v…"` clOrdId. Exit vector: exitNonce `0x33…33` → `"x…"`. The overflow-size request (px 700700000 scaled, sz 142714428000) encodes. Changing any single field changes the hash. |
| `merkle.test.ts` | **FROZEN:** `entryHash_i = keccakUtf8("vekil-entry-" + i)`, i = 1..5. Roots for n = 1, 2, 3, 5; proofs for every index at n = 5 (and n = 3, to cover the carry-up); all verify; a tampered leaf or proof fails; n = 1 means root = leaf; empty input throws. |
| `canonical.test.ts` | **FROZEN:** canonical string + hash of a nested sample with Turkish characters (`"İşlem ğüşöç"`). Key sorting; arrays keep order; `undefined` omitted. Throws on 1.5, NaN, Infinity, 2**53, 1n, functions. |
| `hash.test.ts` | `manifestHash` doesn't depend on tool order; floats in `inputSchema` are allowed; a missing description equals `""`. |
| `money.test.ts` | **FROZEN:** `toScaled("494.7") = 49470000000n`, `"0.00000001" = 1n`, uint64 max OK and max + 1e-8 throws, 9 dp throws, negative throws. `toScaledSigned("-1.234567899") = -123456789n` (toward zero), int64 bounds. `pct2ToBps`: "0.3"→30, "3"→300, "0.05"→5, "20"→2000; "0.001" and "0" throw. Tick and lot rounding (`ceilToTick("494.71","0.1") = "494.8"`, `floorToLot`). Hard caps scaled = `100000000000n` / `50000000000n`. |
| `time.test.ts` | `dayKey` flips at 21:00:00Z; `hourIndex`/`dayIndex` across TRT midnight; `endOfDayIstanbul`; SimClock `sleep`/`every`/`autoAdvance`; SystemClock smoke. |
| `reasons.test.ts` | Bit order equals the §9.4 table; R1 mask (bits 2, 5, 6) is critical; ZERO_VALUE alone is not; ORDER_TOO_LARGE is critical only above 2×; every code has a Turkish string; exit codes 1..6 round-trip. |
| `schemas.test.ts` | The default policy is valid; every Policy refinement fails on purpose; Pct2 cases; Hex32 and Address accept lowercase only; a decision union strips foreign fields; ADJUST needs at least one field; a BUY with no stop and a foreign instId **passes** the schema (the contract judges it); ledger payload schemas accept sample payloads. |
| `config.test.ts` | Defaults; `""` means unset; refused combos (live + scripted, live + local, demo + fake chain); non-loopback HOST refused; fuji without the agent key refused; `dataDir` derivation; `redactConfig` hides keys. |
| `arming.test.ts` | Paper is never armed; live without arm or token is not armed; `armLive` arms it; the executor token arms it; `assertLiveArmed` throws. |
| `events.test.ts` | Subscribe, emit and unsubscribe; `makeEvent` shape. |
| `policy-encode.test.ts` (U2) | **FROZEN** `policyHash` of the default policy at a fixed `validUntil`. |

### 4.4 Implementation order at 10:00 (`pnpm check` after each step)

1. `git init` in `~/vekil`, commit the design package, clone `refs/agent-trade-kit` at the tag for 1.4.8, and create the `track-c` worktree (Track C starts in parallel).
2. Scaffold: package.json, tsconfig, vitest config, `pnpm i`, an empty `pnpm check`.
3. `money.ts` → `canonical.ts` → `hash.ts` → `time.ts`
4. Freeze the vectors with `cast`, then `order-hash.ts` → `merkle.ts` (→ `policy-encode.ts`)
5. `reasons.ts` → `schemas.ts` → `events.ts` → `arming.ts` → `config.ts` → `interfaces.ts`
6. `config/atk-allowlist.json`, `anvil --version`
7. Acceptance: `pnpm i && pnpm check` with every vector; vekil-reviewer; PROGRESS.md; commit "M0"; "M0 committed".

Target: about 60 minutes. If it runs late, `policy-encode.ts` and the HTTP body schemas are the first to slip, but only with your OK, because `src/shared` freezes after M0.
