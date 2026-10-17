# VEKİL: build plan for 17 Oct 2026 (v2.1)

Times are targets. When a milestone runs late, the **cut order** decides what gets dropped. **Submission is 19:00**, and we aim to submit at 18:45.

## Ground rules

- **Every milestone ends with:**
  1. `pnpm check` passing (plus `forge test` if contracts changed);
  2. the acceptance steps run and shown (command + output);
  3. a status update;
  4. a commit.
- **Where the status update goes:**
  - On `main`, update `PROGRESS.md`.
  - **Track branches don't edit PROGRESS.md.** They put their status in the commit message.
- **`src/shared/` is frozen after M0.** A change needs human approval, and every session has to be told about it.
- **Human-only commands:** `pnpm live`, `pnpm resume` and `pnpm chain:mainnet` are run **only by a human**. Live runs in `../vekil-live`; Claude Code never runs commands there (SPEC §8.4).
- **Test first** wherever the spec gives exact behavior: contract, preflight, hashes, Merkle, executor checks.
- **When in doubt, re-read the SPEC section.** If the SPEC is wrong or unclear, ask. Don't invent.

## Before 10:00 (humans only; no code)

- [ ] Ask the organizers:
  - (a) Are design docs written before the event OK?
  - (b) Does Bonus 2 need mainnet or is Fuji enough?
  - (c) What is the submission format?
  - (d) Is there a Fuji faucet coupon?
  - (e) Does OKX TR support demo trading through ATK?
- [ ] At the 09:30 workshop, write down: ATK tool names, TR notes, AVAX-TRY minimum size and fees, and whether DOGE-TRY is listed.
- [ ] Install:
  - Node 20+, pnpm, git, Claude Code (latest);
  - **Foundry** (`forge --version` **and `anvil --version`**); on Windows run **everything** (including Claude Code) inside WSL;
  - `npm i -g @okx_ai/okx-trade-mcp@<version>`. Note the version.
- [ ] OKX TR:
  - a sub-account if possible, funded with 500–1000 TL;
  - two API keys: **read-only**, and **trade without withdraw**;
  - the profiles `tr-read` and `tr-trade` in `~/.okx/config.toml` with `site = "tr"`.
- [ ] **Four** EVM wallets (OWNER-dev, AGENT-dev, OWNER-live, AGENT-live), all funded with Fuji AVAX. Optionally a browser wallet holding OWNER-live (S1).
- [ ] An Anthropic API key with credit.
- [ ] `.env` from `.env.example` with **dev** keys. The default ports 8788/8790 are already dev. **Claude never sees `.env`.**
- [ ] A phone hotspot.

## Ownership

| Area | Folders and files | Owner |
|---|---|---|
| Foundation | `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/shared/**` (including `time.ts` with SystemClock/SimClock), `config/atk-allowlist.json` (empty skeleton) | M0 (single session) |
| Track A: agent and Text-to-Policy | `src/agent/**`, `fixtures/smoke-script.json`, `fixtures/policy-fixtures.json`, `scripts/{probe-agent,probe-policy}.ts` | Session A |
| Track B: ATK, market, preflight, executor, auditor | `src/atk/**`, `src/market/**`, `src/preflight/**`, `src/executor/**`, `src/audit/**`, `scripts/{atk-probe,probe-market,audit-orders}.ts`, `atk-manifest.lock.json`, `config/atk-allowlist.json` (content), `docs/ATK_NOTES.md`, `executor.Dockerfile` | Session B |
| Track C: contract, chain, ledger, verify, ERC-8004 | `contracts/**`, `src/chain/**`, `src/ledger/**`, `scripts/{deploy,policy-set,owner-pause,register-agent,verify,probe-chain,abi-sync}.ts`, `docs/agent-card.json` | Session C |
| Track D: core, server, UI | `src/core/**` (including `dev-stubs/`, deleted at M2), `src/server/**`, `web/**`, `src/main.ts`, `fixtures/ui-events.jsonl`, `scripts/{live,resume,kill,evidence}.ts` | Session D |
| Integration | `scripts/smoke.ts` | M2 session |

### Session layouts

- **2+ people:** **Track C starts at 10:00 in parallel with M0.** It works in a `track-c` worktree made from the initial commit; contracts don't depend on `src/shared`. After M0 lands (~11:00), C merges `main` and asserts the TS vectors. A, B and D start at 11:00 from `main`.
- **4 people:** M0 + C at 10:00; then A, B, C and D.
- **2 sessions:** session 1 does M0, then B, then A. Session 2 does C, then D. **Cut Should items up front.**
- **1 session:** M0, then C, B, A, D. **Cut Should items up front.**
- Every worktree has its own `pnpm i` and its own **dev** `.env`.

## M0: foundation (10:00–11:00, one session; Track C in parallel)

**Tasks**
1. Scaffold:
   - `package.json` with the SPEC §6 dependencies (exact pins) and **every script in SPEC §7** (stubs for later tracks);
   - `tsconfig.json` (strict, NodeNext, `include: ["src", "scripts"]`);
   - `vitest.config.ts` (`include: ["src/**/*.test.ts", "scripts/**/*.test.ts"]`) and `.gitignore`.
2. `src/shared/`, exactly per SPEC §8–§9:
   - `config.ts`, `schemas.ts` (all of §9, including §9.10), `reasons.ts`, `events.ts`;
   - `canonical.ts`, `hash.ts`;
   - `order-hash.ts` (**frozen vector**), `merkle.ts` (**frozen vectors for 1, 2, 3 and 5 leaves**);
   - `money.ts` (`toScaled`, `toScaledSigned`, `Pct2` → bps, rounding, caps), `time.ts` (`dayKey`, SystemClock, SimClock), `arming.ts`;
   - `interfaces.ts` (exactly §9.9).
3. Check that `anvil --version` works. If it doesn't, stop and tell the human.

**Acceptance:** `pnpm i && pnpm check` passes with every frozen vector. Commit "M0" and update PROGRESS.md. Tell the other sessions to merge `main`.

## M1: tracks in parallel (C 10:00–13:15; A, B, D 11:00–13:15)

### Track C: contract, chain, ledger (starts at 10:00)

1. `VekilPolicy.sol` with **tests first** (§13.1, §23.4):
   - every reason bit, auto-pause, access control, `setPolicy` validation and caps;
   - **the uint256 arithmetic and the overflow test**;
   - buckets with `vm.warp`, exits, anchors, `counters()`;
   - the no-revert fuzz test and one basic invariant.
2. Vendor forge-std (`--no-git`).
3. `abi-sync.ts` → `abi.ts` (ABI + bytecode).
4. After M0 lands: assert `hashOrderFor` and `verifyEntry` against the TS vectors.
5. `policy-chain.ts` (no bigint leaves), `fake-policy-chain.ts`, `anvil.ts`.
6. `ledger.ts`, `verify.ts` (V1–V4, proof, tamper).
7. The scripts `deploy`, `policy-set` (every `--<field>` flag; `--text` is wired at M2), `owner-pause`, `verify`, `probe-chain --local`.

**Acceptance:** `forge test` and `pnpm check` pass. `pnpm probe:chain --local` approves, rejects (critical → paused), records an exit, anchors and verifies an entry. **Deferred to M3:** V5/V6, `register-agent` + agent card, `probe:chain` on Fuji, wider invariant tests.

### Track B: ATK, market, preflight, executor, auditor

1. **ATK discovery first** (§25 items 1–7 and 14, plus `<R1_PAIR>`):
   - use the `okx-readonly` MCP server and `refs/agent-trade-kit`, and fill `docs/ATK_NOTES.md`;
   - `atk/client.ts` (injected spawner, arming guard, `cancelOnly` rules), `manifest.ts`, `parse.ts`;
   - `scripts/atk-probe.ts`, then `pnpm atk:lock` and the allowlist.
2. `preflight.ts`, with **tests first**: every local reason, the routing table, property tests PF1–PF6.
3. `fake-market.ts` + `synthetic.ts` (AVAX-TRY, `<R1_PAIR>`, BTC-TRY; `forcePrice` keeps the spread), then `atk-market.ts`.
4. Executor (§14): `executor.ts` (every refusal, inventory, dust, one in-flight exit), `monitor.ts`, `pause-watch.ts`, the exchanges (fake/paper/ATK; ATK never called live), `server.ts`, `main.ts`, `client.ts` (HTTP and in-process).
5. `auditor.ts` + `scripts/audit-orders.ts` (order source by mode).

**Acceptance:** `pnpm check` passes. `pnpm probe:market` prints the AVAX-TRY spec, snapshot, candles, book imbalance and trade flow. The executor tests cover every refusal code and the monitor/pause watcher.

### Track A: agent and Text-to-Policy

1. `llm/anthropic.ts`, `llm/scripted.ts` (relative values: `pctOfAsk`, `pctOfStop`, `validUntilInHours`, `suggested`).
2. `prompt.ts` (C1 from the on-chain policy and counters, C2, OWNER NOTE), `tools.ts`, `indicators.ts` (suggested levels per §22.2), `context.ts`, `loop.ts`, `redteam.ts` (injection, naive, R1–R3 built from policy and ask).
3. `policy-parser.ts` (§11, Appendix D, validation in code).
4. `scripts/probe-policy.ts`.
5. `ask.ts` (S2, only if time allows).

**Acceptance:** `pnpm check` passes. `pnpm probe:agent` runs one real cycle on real ATK data and prints the tool trace, the reasoning fields and the zod result, without touching the chain or the executor. `pnpm probe:policy` prints 3 proposals with mapping, assumptions and questions.

### Track D: core, server, UI

1. `src/core/dev-stubs/`: minimal stand-ins for the agent, preflight, chain and executor, used until M2.
2. `mutex.ts`, `state-store.ts` (atomic; SC13), `vekil.ts`:
   - the §15 pipeline and routing; sync (awaits the first `recordExit`);
   - idempotent kill with integer timings; owner close and flatten;
   - anchoring through the queue (§16.2); Text-to-Policy propose/apply.
3. `scheduler.ts`, `startup.ts` (SC1–SC3, SC5, SC7, SC8, SC11, SC13 now; the rest in M3).
4. The server with every §19 endpoint; the dashboard (§20).
5. `fixtures/ui-events.jsonl` plus an SSE replay mode.
6. `live.ts` (TTY, ports, CANLI), `resume.ts`, `kill.ts` (fallbacks by mode).

**Acceptance:**
- Core tests pass with stubs.
- The dashboard renders `fixtures/ui-events.jsonl` replayed over SSE: feed, reasoning card, Text-to-Policy preview, DURDUR timings, the red-team card with rejection and brake, Pozisyonu kapat, Doğrula and Denetçi.
- The full fake-mode `pnpm dev` check moves to M2.

## M2: integration (13:15–14:45)

1. Merge into `main`: C → B → A → D. Delete `src/core/dev-stubs/`. Update PROGRESS.md from the commit messages.
2. Wire `src/main.ts` for real:
   - fake → in-process executor;
   - paper → executor process;
   - `CHAIN=local` → anvil + deploy from bytecode;
   - `CHAIN=fake` → FakePolicyChain.

   Check that `EXECUTION_MODE=fake LLM_PROVIDER=scripted CHAIN=local pnpm dev` works end to end in the dashboard.
3. **Write `scripts/smoke.ts` exactly per SPEC §23.3 and make `pnpm smoke` pass.**
4. Deploy the dev contract with `pnpm chain:fuji` (the human approves). Run `EXECUTION_MODE=paper CHAIN=fuji LLM_PROVIDER=anthropic pnpm dev`:
   - apply a Turkish policy;
   - show 3 real cycles with reasoning and `OrderApproved`/`OrderRejected` on Snowtrace;
   - show one paper fill through the executor process.
5. **Human:** the first real trade (Bonus 1).
   1. Stop paper.
   2. Create the live checkout and start it:

      ```bash
      git worktree add --detach ../vekil-live main
      cd ../vekil-live
      # .env here: LIVE keys, PORT=8787, EXECUTOR_PORT=8789, EXECUTION_MODE=live, CHAIN=fuji, I_CONFIRM_NO_WITHDRAW=yes
      pnpm i
      pnpm chain:fuji
      pnpm policy:set --maxOrderQuote <near the exchange minimum> --maxHoldMin 20 --maxTradesPerHour 3
      pnpm live      # type CANLI
      ```
   3. Send the owner note "Kurallar içinde minimum tutarda bir alım değerlendir."
   4. Check `OrderApproved` on Snowtrace and the fill on OKX TR.
   5. The exit happens within 20 min (time stop), or earlier with "Pozisyonu kapat".
   6. Run `pnpm audit:orders` → OK, then Ctrl+C.
6. **Acceptance:** smoke passes; the paper run with on-chain approvals is visible; one live round trip with a clean audit, or a written reason why not.

**If M2 runs past 14:45,** move step 5 to the start of M3. Don't drop it.

## M3: completion (14:45–16:15)

Iterate the kill and red-team work on `CHAIN=local`, whose data is wiped on every start. Run each scenario **once** on the Fuji dev contract. Claude can't resume; when a resume is needed, **ask the human** to run `pnpm owner:pause --unpause`, stop `pnpm dev`, run `pnpm resume` and restart.

Order of work:
1. Kill switch end to end: the three timings, `pnpm kill` fallbacks, the executor's pause watcher after `pnpm owner:pause` from another terminal, owner close and flatten in every status.
2. Red-team: injection (naive), R1 fallback, R2/R3. Auto-pause is visible on Snowtrace (Fuji run).
3. Doğrula with "Kanıtla" (on-chain proof; "Şimdi çapala" for recent items), the tamper demo and the Denetçi card.
4. Deferred items:
   - SC4, SC6, SC9, SC10 (V2), SC12, SC14;
   - V5 and V6;
   - `register-agent` + agent card (test on the dev contract);
   - `probe:chain` on Fuji;
   - wider invariant tests.
5. Should items, as time allows: S1, S2, S4, S3.

**Acceptance**
- DURDUR shows the three timings, with the local step under 2 s even during an entry.
- An owner pause from the CLI makes the executor cancel by itself within about 5 s.
- The injection demo gives a 3-reason rejection plus auto-pause.
- The proof verifies on-chain.
- The auditor flags an unapproved (injected) order in fake/paper.

## 16:15: feature freeze and live run (human, in `../vekil-live`)

**Default: reuse the M2 live contract and data dir**, so the history stays continuous.
1. Ideally no open position: wait, or use "Pozisyonu kapat". If one is open, the executor reloads it after the restart and keeps protecting it.
2. Ctrl+C. Then update with `git checkout --detach main && pnpm i`.
3. Run `pnpm live`.
   - If SC10 or SC13 fails because the ledger format changed since M2: Ctrl+C, run `mv data/live-fuji ../vekil/docs/evidence/m2-live`, then `pnpm chain:fuji` (or `pnpm chain:mainnet` if the organizers require it), then `pnpm live` again.
4. In the dashboard, write the **real rules in Turkish** and confirm them on-chain.
5. Run `pnpm register-agent` (ERC-8004 + `setAgentId`).
6. Leave it running.

After the freeze: bug fixes only on `main`, each with a regression test. Dev keys, ports 8788/8790.

## M4: hardening and docs (16:15–17:30)

- Fix bugs, each with a failing test first.
- `README.md`:
  - a Turkish summary plus English details;
  - the trust-layer diagram;
  - run, verify and audit (`pnpm verify`, `pnpm audit:orders`);
  - the contract link;
  - evidence: the `PolicySet`, `OrderApproved` and `OrderRejected` + `Paused` txs, and the live `clOrdId`;
  - the honest limits (SPEC §24).
- S7 `pnpm evidence`.
- Humans: slides (problem, one line, trust layers, judging map), a dry run, a backup screen recording (2–3 min).
- **Acceptance:** a fresh clone + `pnpm i` + `pnpm smoke` passes without any `.env` (Foundry installed; bytecode committed). The README is complete.

## M5: rehearsal and submission (17:30–18:45)

- Two full rehearsals of SPEC §24, timed. Keep the strategy part to at most 10 seconds.
- **If the LLM or the network fails:** R1 needs no LLM; use the recorded video. **Never** restart live with `LLM_PROVIDER=scripted` (config refuses it anyway).
- **Before the finals, if a rehearsal paused the live contract:** `pnpm owner:pause --unpause`, Ctrl+C, `pnpm resume`, `pnpm live`.
- Submit at **18:45**.

## Cut order (drop from the top first)

1. Could items.
2. S9 demo mode.
3. S8 exchange-side stop.
4. S5 mainnet (unless required).
5. S3 Docker.
6. S4 Snowtrace verification.
7. S2 Ajana sor.
8. S7 evidence export.
9. S1 wallet signing.
10. M15 ERC-8004 (only if the ABI blocks it; tell the human).
11. Deferred startup checks SC9, SC12, SC14.
12. V6.
13. Dashboard "Kanıtla" (keep `pnpm verify --prove`).
14. Dashboard auditor card (keep `pnpm audit:orders`).

**Never cut:**
- on-chain approval, recorded rejection and auto-pause;
- executor approval checks (a separate process in paper/live);
- Text-to-Policy;
- the red-team reaching the chain;
- the kill switch;
- **owner exits (M17)**;
- V1–V4;
- the reasoning display;
- `pnpm smoke`;
- one real trade.

## Risk register

| Risk | Mitigation |
|---|---|
| ATK names or params differ | discovery is Track B's first task; adapters isolate it; ATK_NOTES is the single source |
| `clOrdId` unsupported | map via `ordId` in our cache; say so openly |
| TS/Solidity hash or Merkle mismatch | frozen vectors in M0, asserted in forge |
| Contract arithmetic reverts on a huge order | uint256 math + overflow unit test + no-revert fuzz test |
| anvil missing (Windows) | WSL; checked in M0 |
| The agent doesn't fall for the injection | automatic R1 fallback, labelled honestly |
| The approval round trip feels slow | IOC limit + collar; 5m/15m decisions; exits never wait |
| The live agent never trades | owner note; `STRATEGY_PROFILE=active`; trade early in M2 |
| The M2 live position lingers | `--maxHoldMin 20` for the first trade; "Pozisyonu kapat" works in every status |
| Dev work disturbs live (same OKX account) | paper uses simulated balances and orders; the cancel-only client only in live data dirs; separate checkout, wallets and ports; SC13 |
| LLM outage in the finals | R1 (no LLM); recorded video |
| Merge conflicts | ownership; `src/shared` frozen; tracks don't edit PROGRESS.md; merge order C → B → A → D |
| Running out of time | C starts at 10:00; deferrals to M3; cut order; freeze at 16:15 |
| Venue Wi-Fi | phone hotspot |
