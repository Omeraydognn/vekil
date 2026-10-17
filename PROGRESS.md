# VEKİL progress (v2.1)

This file is updated on `main` only. Track branches put their status in commit messages, and the M2 session copies it here after merging. Keep it short. Newest decisions go at the top.

## Now
- Milestone: M1 (A, B, C, D) and M2 steps 1–3 done on branch `claude/intelligent-lamport-lcmrjk` (one session merged the four WIP track branches and finished them). Next: M2 step 4 (Fuji dev contract + paper run) and step 5 (first live trade, human).
- Working on: —
- Blocked by: human setup for real runs — `~/.okx/config.toml` (tr-read, tr-trade), Fuji wallets + AVAX, `ANTHROPIC_API_KEY`, dev `.env`. The cloud session has no route to tr.okx.com and no API key, so `probe:market`, the Anthropic variants of `probe:agent`/`probe:policy` and `atk:probe` with auth must run on a dev machine.

## Milestones
| Milestone | Status | Evidence (command → result) | Commit |
|---|---|---|---|
| M0 foundation (shared + frozen vectors, anvil ok) | ☑ | `pnpm i && pnpm check` → 12 files, 118 tests pass; vectors re-derived with `cast` (also by vekil-reviewer: PASS); `anvil --version` → 1.5.1-stable | M0 |
| M1-C contract + chain + ledger + verify (started 10:00) | ☑ | `forge test` → 101/101; `pnpm probe:chain --local` → 9/9 (approve, R1 critical reject + auto-pause, recordExit, anchor while paused, verifyEntry); ledger/verify tests (V1–V6, proof, tamper) | Track C |
| M1-B ATK discovery + preflight + market + executor + auditor | ☑ (probe:market pending) | ATK_NOTES §0–6 (auth items UNKNOWN); executor tests cover every refusal code, inventory, dust, one in-flight exit, monitor, pause watcher; auditor A1–A3. `pnpm probe:market` not run (no network to tr.okx.com in the cloud session) | Track B |
| M1-A agent + reasoning + red-team + Text-to-Policy | ☑ (real-LLM probes pending) | `LLM_PROVIDER=scripted pnpm probe:policy` → 3 proposals; `EXECUTION_MODE=fake LLM_PROVIDER=scripted pnpm probe:agent` → tool trace + reasoning + zod OK. Anthropic/ATK variants need the key and network | Track A |
| M1-D core + server + dashboard (UI replay) | ☑ | `UI_REPLAY=fixtures/ui-events.jsonl pnpm dev` renders feed, reasoning, red-team, brake, positions; core tests (kill vs mutex, idempotent kill, owner close while HALTED, sync awaits recordExit, SC13) | Track D |
| M2 merge + smoke on anvil + paper on Fuji (approvals on-chain) | ◐ smoke ☑, Fuji/paper ☐ | `pnpm smoke` → 14/14 in 12.5 s on the real contract; `EXECUTION_MODE=fake LLM_PROVIDER=scripted CHAIN=local pnpm dev` end to end (API + dashboard). `pnpm check` → 325/325. Fuji + paper needs the human setup | M2 |
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
| dev (main, M2) | Fuji | `0x75c9b0155b0b026f869351ab3450723c44e57999` (block 59594490) | [0xdd668a6e…](https://testnet.snowtrace.io/tx/0xdd668a6e2cff771bc46fffce96a757703697a14382dcd76ecad06820e5138d0a) · default policy [0x8317a4dc…](https://testnet.snowtrace.io/tx/0x8317a4dc87c4484e801fc5f48fd356ba2419d5b5d36627bcd59562b0a758c1f7) | **#280** ([register](https://testnet.snowtrace.io/tx/0xced08a98c35ae0de4bc0766b18eda38c8168ab6db601383088882302d7e591ce), [setAgentId](https://testnet.snowtrace.io/tx/0xcb15a73a4646801a00ad2ef180cc37ff019dafda47b87d77429b7317abacac99)) | dev wallets: owner 0x9d64…dcb4, agent 0x29c2…4f86; data/paper-fuji |
| live (M2, reused at 16:15) | Fuji | | | | archive + fresh only if SC10/SC13 fail |
| live mainnet (S5, if required) | mainnet | | | | |

## Evidence for the demo
| What | Tx / ID | Link |
|---|---|---|
| PolicySet with Turkish source text | v3 0xdfce1ca9… | https://testnet.snowtrace.io/tx/0xdfce1ca975af5ccbf6d2664e942e5599eaf39467548b97ecdb0953550680c076 |
| OrderApproved (paper run on Fuji; live trade still to do) | 0x14c4f3e7… → fill vbffa58a… → STOP_HIT → ExitRecorded 0xc05124ca… | https://testnet.snowtrace.io/tx/0x14c4f3e73947f4bb5226ef96fd70590af91710346077c53215b22daa1dbe2e27 |
| OKX clOrdId of the live trade | | |
| OrderRejected + Paused (red-team) | R1, one tx 0x4c254b82… | https://testnet.snowtrace.io/tx/0x4c254b825fb099417e40aa1f82ba596ce16cc3bcce9f5d0fbaeb27beaa2bf38c |
| Anchored + on-chain proof (verifyEntry) | anchor #35–57 0x657ae5c7…; `pnpm verify --prove 56` ✓ | https://testnet.snowtrace.io/tx/0x657ae5c7038e52b251ef2fd784afb48a064c33b33198d472057d56a2b4c6e2c5 |
| `pnpm audit:orders` report (all OK) | | |

## Decisions log
- 17 Oct 16:30 — Owner note may override the playbook (e.g. stand aside in TREND_DOWN), never the on-chain rules: the cycle message says so and C1 step 2 says "unless an OWNER NOTE asks for a trade". Without it the agent ignored "Kurallar içinde minimum tutarda bir alım değerlendir." in a down trend. The contract still judges every order (SPEC §10.2 unchanged in spirit).
- 17 Oct 16:30 — AVAX-TRY minimum size makes a 45 TL order fail ORDER_BELOW_MIN_SIZE (the agent reported it); use ≥ ~60 TL per trade for the live run.
- 17 Oct (human request) — LLM_PROVIDER gains `openrouter` (OpenAI-compatible chat API over fetch, no new dependency) next to `anthropic`. This changes the frozen `src/shared/config.ts` with the human's approval: `OPENROUTER_API_KEY`, `LLM_MODEL` must be an OpenRouter id (`vendor/model`), demo/live accept anthropic or openrouter (never scripted). Risk noted: free models have rate limits and weaker tool calling.
- 17 Oct 11:10 — One session continued all four WIP tracks on `claude/intelligent-lamport-lcmrjk` (PLAN "1 session" layout) and did M2 steps 1–3; `src/core/dev-stubs/` deleted. `src/shared` unchanged.
- 17 Oct 11:10 — `<R1_PAIR>` = DOGE-TRY (`R1_PAIR` in `src/agent/redteam.ts`). R1 carries a limit from DOGE-TRY's ask so the contract sees the real notional (no ZERO_VALUE).
- 17 Oct 11:10 — Owner chain scripts (`chain:fuji`, `policy:set`, `owner:pause`, `probe:chain` on Fuji) ask `y` on a TTY or take `--yes`; mainnet always needs a TTY + `MAINNET`.
- 17 Oct 11:10 — The scripted LLM fixture feeds parser turns (`propose_policy`) and agent turns from one file, each in its own order.
- 17 Oct 11:10 — V5: an EXIT without an EXIT_RECORDED entry yet is "pending" (a warning in details), not a failure. Tamper: V2 uses recomputed hashes, so a tampered entry breaks its anchor too.
- 17 Oct 10:30 — Track C decisions C1–C5 (see the track-c commit): duplicate instIds rejected; readView takes sourceText from the PolicySet log and fails closed; policyVersion starts at 0; pause/unpause idempotent.
- 17 Oct 10:00 — Track A: Sonnet 5.5 rejects forced tool_choice; the Anthropic adapter sends tool_choice auto with only the forced tool.
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
- [x] 1 ATK tool names/params (incl. order history) — ATK_NOTES §2 (`spot_get_orders status=history`)
- [x] 2 clOrdId / ioc / tdMode / tgtCcy — ATK_NOTES §3 (clOrdId ≤ 32, ioc ok, tdMode required → cash, market sell sz in base)
- [x] 3 capabilities fields; --read-only HIDES write tools; balances/permissions in `account` — ATK_NOTES §1
- [x] 4 AVAX-TRY / DOGE-TRY / BTC-TRY specs — ATK_NOTES §4 (BTC-TRY lotSz 9 dp, context only)
- [x] 5 fee rate — AVAX-TRY taker 0.22 %, maker 0.10 % (`account_get_trade_fee`); FEE_RATE=0.0022
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
- Runbook: if an exit's state stays unknown (ALERT "EXIT_STATE_UNKNOWN"), that position can't be closed from VEKİL until OKX answers (no double sell by design). Check the order on OKX TR directly.
- Policy `feeBps` default is 20; the verified taker fee is 22 bps. Set `--feeBps 22` (or in the Turkish rules) so the on-chain worst case is not understated.
- SPEC question (for the human): `recordExit` is once per entry, but a partial exit leaves a remainder that a second x-order sells; V5 / the auditor would flag that second exit. Market sells normally fill fully; unfilled retries are already ignored by the auditor.
- Deferred to M3 (not built yet): SC4, SC6, SC9, SC10, SC12, SC14; `register-agent` + `docs/agent-card.json` (ERC-8004 ABI not verified); `pnpm evidence` (S7); `executor.Dockerfile` (S3); "Ajana sor" (S2).
- `pnpm atk:probe` must be re-run with the `tr-read` profile to fill the auth-only items in ATK_NOTES (balance shape, fee, key permissions, demo, news).
