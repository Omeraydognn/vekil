# VEKİL progress (v2.1)

This file is updated on `main` only. Track branches put their status in commit messages, and the M2 session copies it here after merging. Keep it short. Newest decisions go at the top.

## Now
- Milestone: (not started)
- Working on:
- Blocked by:

## Milestones
| Milestone | Status | Evidence (command → result) | Commit |
|---|---|---|---|
| M0 foundation (shared + frozen vectors, anvil ok) | ☐ | | |
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
- (date time) decision — why

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
- [ ] 14 refs tag for the pinned ATK version
- [ ] 15 anvil on every dev machine

## Known bugs / follow-ups
-
