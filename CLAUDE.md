# VEKİL — instructions for Claude Code

VEKİL is our entry for the Agentic Hackathon (OKX TR × Team1 Türkiye, Avalanche ecosystem partner), Ankara, 17 Oct 2026.

**One line:** an autonomous AI agent that trades AVAX-TRY spot on the owner's OKX TR account through OKX Agent Trade Kit (ATK).
- The owner writes the rules in Turkish, and they become a policy in the **VekilPolicy** contract on Avalanche.
- The contract approves or rejects every order, and both outcomes are recorded on-chain.
- An isolated executor trades only what the chain approved.
- The brake is on-chain.

## Read first
- `docs/SPEC.md` is the source of truth for what to build. If the code and the spec disagree, the spec wins. Propose spec changes to the human; never diverge silently.
- `docs/PLAN.md` has the milestones, folder ownership, acceptance criteria and cut order.
- `PROGRESS.md` holds the current status. It is updated on `main` only; track branches put their status in commit messages.
- `docs/ATK_NOTES.md` holds verified facts about ATK on OKX TR. Fill it by discovery; never guess.

## Safety invariants
Never violate these. If a task seems to require breaking one, stop and ask the human.

1. **The LLM never gets a write-capable ATK instance.** It sees only the read-only instance through the allowlist, plus our local tools.
2. **The trade key lives only in the executor process (`src/executor/`).**
   - The executor sends an entry only for an `orderHash` it recomputed itself, and only if that hash is APPROVED on-chain, the approval hasn't expired, the policy version is unchanged and the contract isn't paused.
   - It only sells its own inventory.
   - Nothing else uses a trade-capable ATK instance, except the cancel-only client in `scripts/kill.ts` (SPEC §8.2).
3. **The rules live on-chain.**
   - VekilPolicy is the judge.
   - Local preflight only checks market sanity, and it must route every suspected policy violation to the chain (SPEC §12). Never make a local check the final judge of a policy rule.
4. **Preflight (`src/preflight/`) is a pure function:** no I/O, no clock reads, no randomness, Decimal only.
5. **Fail closed for entries; exits never wait.**
   - On any error, timeout, stale data or failed check, no entry order is sent.
   - Exits are never blocked by the chain, a halt or a pause.
6. **Never place live orders yourself.**
   - Work with `EXECUTION_MODE=fake` or `paper` and `CHAIN=fake`, `local` or `fuji`.
   - `demo`/`live` start only through `pnpm live`, which a human runs.
7. **Never read, print, log or commit secrets:** `.env`, `~/.okx/`, private keys, API keys.
   - Use `.env.example` for documentation.
   - Override settings on the command line (`EXECUTION_MODE=fake CHAIN=local pnpm dev`). Never edit `.env`.
8. **No withdrawal or transfer tools or permissions.** No derivatives, no leverage, no shorting.
9. **Chains:** `fake`/`local` (anvil) for development and smoke, Fuji by default for real runs. Mainnet only when the human explicitly asks, through human-only scripts.
10. **Core and executor bind to 127.0.0.1 only.**
11. **Never touch the live run.**
    - Never run commands in or read from `../vekil-live`.
    - Use dev keys, ports 8788/8790 and the per-mode `DATA_DIR`.
    - Tests and smoke always use a temp data dir.

## How to work
- **Before a milestone:** read the relevant SPEC sections and write a short plan (files, interfaces, tests). Wait for approval where PLAN or the human says so.
- **While working:** take small steps. After each one, run the narrowest relevant test.
- **At the end of a milestone:**
  1. Run `pnpm check` (and `cd contracts && forge test` if contracts changed) and the milestone's acceptance steps, and show the evidence.
  2. Run the `vekil-reviewer` subagent on your diff and fix every BLOCKER.
  3. Record your status: PROGRESS.md on `main`, or the commit message on a track branch.
  4. Commit.
- **Don't guess external APIs:**
  - **ATK:** use the `okx-readonly` MCP server (`system_get_capabilities`, the tool list) and `refs/agent-trade-kit/`, and record the findings in `docs/ATK_NOTES.md`.
  - **ERC-8004:** verify the ABI first.
- **Hash parity is sacred.** `orderHash` and Merkle roots must match between TypeScript and Solidity. The frozen vectors are in `src/shared` tests and are asserted in forge.
- **Stay in your lane:** edit only your track's folders (PLAN, "Ownership"). `src/shared/` is frozen after M0; propose changes instead of editing it.
- **Scope:** SPEC Must/Should items only, unless the human approves more. Don't add dependencies beyond SPEC §6 without saying why.
- **If you're stuck:** after about 15 minutes blocked, stop and report the options. Never improvise around a safety invariant.

## Stack
- Node 20+, pnpm, TypeScript (strict, ESM)
- zod, decimal.js, dotenv
- vitest + fast-check, tsx
- express (HTTP + SSE)
- `@modelcontextprotocol/sdk` (stdio client spawning `okx-trade-mcp`)
- `@anthropic-ai/sdk`, viem
- Foundry (`forge`, `anvil`) for the contracts
- Dashboard: static vanilla JS served by core

## Commands
| Command | What it does | Who runs it |
|---|---|---|
| `pnpm i` | install | anyone |
| `pnpm check` | typecheck + TypeScript unit/property tests; must pass before every commit | anyone |
| `pnpm test` | TypeScript tests only | anyone |
| `cd contracts && forge test` | contract unit, fuzz and invariant tests | anyone |
| `pnpm smoke` | end-to-end on its own anvil with the real contract, fake market, scripted LLM, temp data dir | anyone |
| `pnpm dev` | core + dashboard (+ the executor process in paper) per env; refuses live/demo/mainnet | anyone |
| `pnpm verify [--prove <seq>]` | ledger, Merkle anchors, approvals, rejections, exits, policy; on-chain proof | anyone |
| `pnpm audit:orders` | check that every agent order has an on-chain approval (never `pnpm audit`: that's pnpm's own command) | anyone |
| `pnpm abi:sync` | `forge build` + regenerate the committed ABI and bytecode in `src/chain/abi.ts` | anyone (Track C) |
| `pnpm kill` | halt core and the executor and cancel the agent's open orders (may send an owner pause) | anyone, but it asks first |
| `pnpm chain:fuji`, `pnpm policy:set`, `pnpm owner:pause`, `pnpm register-agent`, `pnpm probe:chain` | Fuji transactions (`probe:chain --local` uses anvil) | anyone, but each one asks first |
| `pnpm live`, `pnpm resume`, `pnpm chain:mainnet` | real money / mainnet; need an interactive terminal | **human only** |

SPEC §7 has the full script list. Never name a script after a pnpm built-in command.

## Conventions
- **Money:**
  - Use decimal.js with string I/O (`src/shared/money.ts`).
  - On-chain amounts are scaled exactly ×1e8 with `toScaled()`. Never go through `Number`.
  - Round prices up to `tickSz` for buys; round sizes down to `lotSz`.
- **Solidity arithmetic:** do all of it in `uint256`. `uint64 × uint64` reverts on overflow, and `requestApproval` must never revert for policy reasons.
- **Ledger numbers:** every number in a ledger payload is a safe integer (durations `Math.round(ms)`); amounts are Dec strings.
- **Validation:** validate every external input with zod: env, LLM output, ATK responses, HTTP bodies, executor requests.
- **Hashing:**
  - Ledger: keccak256 over canonical JSON (sorted keys, integers only, no bigint).
  - Orders: keccak256 over ABI encoding (`order-hash.ts`).
  - Merkle: sorted pairs (`merkle.ts`).
- **Timestamps:** ms off-chain, seconds on-chain. Convert explicitly.
- **Language:** UI text is Turkish (SPEC Appendix B). Code, identifiers and comments are English.
- **Logs:** structured, with secrets redacted.
- **Compacting:** preserve the current milestone, files changed, failing tests and open questions.
