# AGENTS.md

Instructions for AI coding agents working on this repository live in **[CLAUDE.md](CLAUDE.md)**. Read it first: it has the current state, the repository map, the safety invariants (never break them), the commands and the conventions.

Quick orientation:
- What VEKİL is and the evidence of what ran: [README.md](README.md)
- What to build (source of truth): [docs/SPEC.md](docs/SPEC.md) · plan: [docs/PLAN.md](docs/PLAN.md) · status: [PROGRESS.md](PROGRESS.md)
- Verified OKX TR / Agent Trade Kit facts: [docs/ATK_NOTES.md](docs/ATK_NOTES.md)
- Before any commit: `pnpm check` must pass; contracts → `cd contracts && forge test`; chain/core changes → `pnpm smoke`.
- Never read or print `.env`, `~/.okx/` or keys. Never place live orders or run `pnpm live`, `pnpm resume` or `pnpm chain:mainnet`; those are human-only. Never touch `../vekil-live`.
