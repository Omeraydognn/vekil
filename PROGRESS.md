# VEKİL progress (v2.1)

This file is updated on `main` only. Track branches put their status in commit messages, and the M2 session copies it here after merging. Keep it short. Newest decisions go at the top.

## Now
- Milestone: M0 done (17 Oct, 09:15). Next: M1 tracks (C is ready in ../vekil-c; A, B, D start from main).
- Working on: —
- Blocked by: human setup — `~/.okx/config.toml` profiles (tr-read, tr-trade), Fuji wallets, Anthropic key, dev `.env`.

## Milestones
| Milestone | Status | Evidence (command → result) | Commit |
|---|---|---|---|
| M0 foundation (shared + frozen vectors, anvil ok) | ☑ | `pnpm i && pnpm check` → 12 files, 118 tests pass; vectors re-derived with `cast` (also by vekil-reviewer: PASS); `anvil --version` → 1.5.1-stable | M0 |
| M1-C contract + chain + ledger + verify (started 10:00) | ☐ | | |
| M1-B ATK discovery + preflight + market + executor + auditor | ☐ | | |
| M1-A agent + reasoning + red-team + Text-to-Policy | ☐ | | |
| M1-D core + server + dashboard (UI replay) | ☐ | | |
| M2 merge + smoke on anvil + paper on Fuji (approvals on-chain) | ☐ | | |
| M2 first live round trip + clean `audit:orders` (../vekil-live) | ☐ | | |
| M3 kill timings, red-team on-chain, proof, auditor, deferred checks, ERC-8004 | ☐ | | |
| 16:15 freeze: live updated, Turkish policy on-chain, ERC-8004, running | ☐ | | |
| M4 hardening + README + evidence + fresh-clone smoke | ☐ | | |
| M5 rehearsal + submission | ☐ | | |

## Should items
| Item | Status |
|---|---|
| S1 wallet signing | ☐ |
| S2 Ajana sor | ☐ |
| S3 Docker executor | ☐ |
| S4 Snowtrace verification | ☐ |
| S5 mainnet | ☐ |
| S7 evidence export | ☐ |
| S8 exchange-side stop | ☐ |
| S9 demo mode | ☐ |

The owner exits (formerly S6) are now Must M17.

## Deployments
| Purpose | Chain | VekilPolicy address | Deploy tx | ERC-8004 id | Notes |
|---|---|---|---|---|---|
| dev (main, M2) | Fuji | | | | dev wallets |
| live (M2, reused at 16:15) | Fuji | | | | archive + fresh only if SC10/SC13 fail |
| live mainnet (S5, if required) | mainnet | | | | |

## Evidence for the demo
| What | Tx / ID | Link |
|---|---|---|
| PolicySet with Turkish source text | | |
| OrderApproved (live trade) | | |
| OKX clOrdId of the live trade | | |
| OrderRejected + Paused (red-team) | | |
| Anchored + on-chain proof (verifyEntry) | | |
| `pnpm audit:orders` report (all OK) | | |

## Decisions log
- 17 Oct 09:15 — Work is local only: no git remote, never push (human).
- 17 Oct 09:15 — Frozen vectors live in `src/shared/vectors.ts`, computed with Foundry `cast abi-encode`/`cast keccak`, not with our TS. Track C asserts the same constants in forge.
- 17 Oct 09:15 — Toolchain: Node ≥ 22.12 (vitest 5 requires it; SPEC said 20+), TypeScript 7.0.2, zod 4.6.7, viem 2.57.7, ATK 1.4.8 (global = local pin, refs tag v1.4.8).
- 17 Oct 08:10 — U1: exit clOrdId nonce is `bytes32` (32 random bytes); helper `exitClOrdId` in `order-hash.ts`.
- 17 Oct 08:10 — U2: `src/shared/policy-encode.ts` (`toChainPolicy`, `fromChainPolicy`, `policyHash`) is in M0 with frozen vectors; forge asserts them.
- 17 Oct 08:10 — U3: `readView().policy.sourceText` comes from `policy-cache.json` / the latest `PolicySet` log, checked against `sourceTextHash` (Track C).
- 17 Oct 08:10 — U4: owner input uses strict `PolicySchema`; `readView` parses with the looser `ChainPolicySchema` (contract rules only).
- 17 Oct 08:10 — U5: bigints are allowed inside shared encoding helpers (`toScaled`, `orderHash`, `policy-encode`); `canonical()` throws on bigint so none reach JSON.
- 17 Oct 08:10 — U6: smoke's `monitorTick`/`pauseWatchTick`/`injectRestingOrder` live on Track B's in-process classes, not on `ExecutorApi`.
- 17 Oct 08:10 — U7: the ledger takes a `Clock` in its constructor (Track C).
- 17 Oct 08:10 — U8: core holds `OWNER_PRIVATE_KEY` for applyPolicy/kill pause as a demo convenience; S1 replaces it. Say so in the honest limits.
- 17 Oct 08:10 — U9: `interfaces.ts` uses `import type { MessageParam }` from `@anthropic-ai/sdk`.
- 17 Oct 08:10 — U10: `SIDE_NOT_ALLOWED` is only reachable in forge tests (TS side is the literal "buy").
- 17 Oct 08:10 — U11: ATK pinned to 1.4.8 (installed globally).

## Open questions (SPEC §25)
- [ ] 1 ATK tool names/params (incl. order history)
- [ ] 2 clOrdId / ioc / tdMode / tgtCcy
- [ ] 3 capabilities fields; does --read-only hide or refuse write tools; which module holds balances/permissions?
- [ ] 4 AVAX-TRY / <R1_PAIR> (DOGE-TRY?) / BTC-TRY specs (≤ 8 decimals?)
- [ ] 5 fee rate
- [ ] 6 demo on TR
- [ ] 7 news on TR
- [ ] 8 Fuji faucet
- [ ] 9 Bonus 2 mainnet?
- [ ] 10 ERC-8004 ABI
- [ ] 11 submission format / pre-written docs OK?
- [ ] 12 Snowtrace verification
- [ ] 13 rate limits
- [x] 14 refs tag for the pinned ATK version — v1.4.8 (commit 343e3ff), matches global + local 1.4.8
- [x] 15 anvil on every dev machine — this Mac: anvil/forge 1.5.1-stable (check other machines)

## Known bugs / follow-ups
-
