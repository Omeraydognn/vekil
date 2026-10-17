# VEKİL

**An autonomous AI trading agent whose rules live on Avalanche, not inside the agent.**
The owner writes the rules in Turkish, the rules become the VekilPolicy smart contract, and every order the agent wants to place must be approved on-chain. If the agent is fooled, the contract rejects the order and pulls the brake by itself.

*Yapay zekâya limitli bir ek kart: kuralı Türkçe yazarsın, kural Avalanche'taki kontratın kendisi olur; yapay zekâ kandırılsa bile kontrat reddeder ve kartı dondurur.*

Agentic Hackathon · OKX TR × Team1 Türkiye × Avalanche · Ankara, 17 October 2026

| | |
|---|---|
| **Public site + Guard API** | https://vekilanchetr.vercel.app |
| **Live contract (Avalanche Fuji C-Chain)** | [`0xaefc457c185573503522cf2d4e7649d1b9245f04`](https://testnet.snowtrace.io/address/0xaefc457c185573503522cf2d4e7649d1b9245f04) |
| **Real OKX TR trade** | on-chain approval [0x654458a3…](https://testnet.snowtrace.io/tx/0x654458a3375d7c5e94c73950afd7456a939c69b0247d9ae309e2a00d22668ed9) → OKX order `v2fa4881396d46d374bd41c52f82d8d` → exit recorded [0x0c4125d3…](https://testnet.snowtrace.io/tx/0x0c4125d3f42175b1604178ff92e41bc510eba35612ff1b0a83d0d46510f89a28) |
| **ERC-8004 agent identity** | #283 (live agent) · #280 (dev agent) |
| **Tests** | 367 TypeScript (unit, property, integration) · 101 Foundry (unit, fuzz, invariant) · end-to-end smoke on a real contract |

---

## Contents

1. [Özet (Türkçe)](#özet-türkçe)
2. [The problem](#the-problem)
3. [How VEKİL works](#how-vekil-works)
4. [Evidence: what ran today](#evidence-what-ran-today)
5. [Security model: what is public and what is not](#security-model-what-is-public-and-what-is-not)
6. [Quick start](#quick-start)
7. [Commands](#commands)
8. [VEKİL Guard API](#vekil-guard-api)
9. [Repository map](#repository-map)
10. [Judging criteria map](#judging-criteria-map)
11. [Business model and roadmap](#business-model-and-roadmap)
12. [Honest limits](#honest-limits)
13. [Documentation index](#documentation-index)

---

## Özet (Türkçe)

VEKİL, OKX TR hesabında AVAX-TRY spot işlem yapan otonom bir yapay zekâ ajanıdır. Farkı: **kurallar ajanın içinde değil, Avalanche'taki VekilPolicy kontratındadır.**

- **Kuralı Türkçe yazarsın.** "Sadece AVAX, işlem başına en fazla 75 TL, her işlemde zarar-kes." Yapay zekâ bunu kontrat alanlarına çevirir, sen onaylarsın, kural zincire yazılır. Türkçe cümlen zincirdeki olayda kalır.
- **Yapay zekâ sadece okur.** OKX Agent Trade Kit'in salt-okunur araçlarıyla piyasayı inceler, rejimi, oyun planını, kanıtlarını ve senaryolarını yazar, ne zaman tekrar bakacağına kendisi karar verir.
- **Her alım zincirden onay ister.** Kontrat emri onaylar ya da reddeder, ikisi de kalıcıdır. Açıkça zararlı bir istekte (izinsiz parite, zarar-kes yok, limitin 2 katı) **fren kendiliğinden çekilir.**
- **Emir gönderici ayrı bir süreçtir.** İşlem anahtarı sadece ondadır; yalnızca kontratın onayladığı emri gönderir, sadece kendi aldığını satar, zarar-kes, kâr-al ve süre çıkışlarını kendisi yönetir.
- **Her şey doğrulanabilir.** Karar defteri zincirleme hash'lidir, Merkle kökleri Avalanche'a mühürlenir, bir kararın kanıtı zincirde doğrulanır; denetçi borsadaki her emri zincirdeki onayla eşleştirir.

**Bugün:** OKX TR'de gerçek bir AVAX-TRY işlemi yapıldı (zincirde onay → OKX emri → çıkış zincire kayıtlı → denetim temiz), ajan ERC-8004'e kaydoldu (#283) ve kural motoru herkese açık, anahtarsız bir servis olarak yayında: https://vekilanchetr.vercel.app

**Neden her şey internette değil?** Parayı yönetebilen hiçbir anahtar internete açık bir sunucuda durmaz. Herkese açık olan sadece anahtarsız kısımlardır: kontrat, Guard ve doğrulama. Gerçek emirleri sahibinin bilgisayarındaki VEKİL verir (üretimde güvenli donanımda, TEE). Başkasının hesabını bizim sunucumuzdan yönetmek OKX TR API sözleşmesine (9.3) de aykırıdır.

---

## The problem

Exchanges are opening their accounts to AI agents (OKX Agent Trade Kit, Binance, Bitget, Coinbase). The common setup is still *"give the agent an API key and hope"*:

- LLMs follow instructions injected into tool output, invent numbers and overtrade.
- The user carries the risk. The OKX TR API agreement makes the user responsible for pre-trade risk controls (6.2), prompt-injection protection (12.2) and auditability (10.x).
- "Trust our bot's if/else code" does not solve it: whoever holds the key can still do anything.

**Target users:** retail investors who want to give an agent a limited budget (a "limited extra card"), and teams that build trading agents and need enforceable rules plus an audit trail.

## How VEKİL works

```
 UNTRUSTED                 TRUSTED (ours)                     AVALANCHE (the judge)            ISOLATED
┌────────────────┐ dec. ┌───────────────────────────┐  tx  ┌──────────────────────────┐   ┌─────────────────────────┐
│ Agent (LLM)    │────► │ Core                      │────► │ VekilPolicy.sol          │◄──│ Executor (own process)  │
│ read-only ATK  │      │ zod → preflight (market   │      │ policy + hard caps       │read│ only holder of TRADE key│
│ + local tools  │      │ sanity) → requestApproval │      │ APPROVED / REJECTED      │   │ re-checks approval,     │
│ visible        │      │ → executor.execute(hash)  │──────┼──────────────────────────┼─► │ expiry, version, paused │
│ reasoning      │      │ ledger + Merkle anchors   │────► │ auto-pause on critical   │   │ IOC buy, clOrdId = hash │
└──────▲─────────┘      │ Text-to-Policy, kill      │────► │ setPolicy / pause (owner)│   │ stop/TP/time exits      │
       │ data           │ Turkish dashboard (SSE)   │      │ exits, anchors, proofs   │   │ pause watcher → cancel  │
 ATK read-only ◄────────└───────────────────────────┘      └─────────▲────────────────┘   └───────────┬─────────────┘
                                                                     │ public reads          ATK trade │ (market,spot)
                                        Auditor (read key + chain) ──┴── every agent order        OKX TR spot
```

| Layer | Trust | Responsibility |
|---|---|---|
| **Agent (LLM)** | untrusted | Reads the market through read-only OKX Agent Trade Kit tools and local indicator tools; proposes one decision per cycle with regime, playbook, evidence, scenarios and a lesson; picks its own next check-in time. |
| **Core** | ours | Validates every input with zod, runs a pure market-sanity preflight, asks the contract for approval, keeps a hash-chained ledger, anchors Merkle roots, runs the kill switch and serves the Turkish dashboard. Holds no trade key. |
| **VekilPolicy (Avalanche)** | the judge | Stores the owner's policy and hard caps; approves or rejects every order and records both; pauses itself on critical violations; records exits and ledger anchors; verifies Merkle proofs. |
| **Executor** | isolated | The only holder of the trade key. Recomputes the order hash, re-checks approval, expiry, policy version and pause state on-chain, places exactly the approved order with `clOrdId = "v" + hash[0..15)`, sells only its own inventory, runs stop / take-profit / time exits, cancels everything when it sees the brake. |
| **Auditor** | independent | Needs only a read key and the public chain; matches every exchange order to an on-chain approval. |

**Order lifecycle:** decision → zod → preflight → `requestApproval` (tx) → `APPROVED` → executor re-verifies on-chain → IOC buy on OKX TR → position with the approved stop, take-profit and time stop → exit (never waits for the chain) → `recordExit` on-chain.

**Rejection:** `OrderRejected(reasons)` stays on-chain. Critical reasons pause the contract; the executor sees the pause by itself, cancels open orders and halts; core halts. Resuming is human-only (wallet `unpause` + terminal).

## Evidence: what ran today

All links point to Avalanche Fuji C-Chain transactions (Snowtrace).

**Live run: real money on OKX TR** · contract [`0xaefc457c…5f04`](https://testnet.snowtrace.io/address/0xaefc457c185573503522cf2d4e7649d1b9245f04)

| Step | Proof |
|---|---|
| Contract deployed · policy set (75 TL per order, 20 min max hold, 22 bps fee) | [0x214c6479…](https://testnet.snowtrace.io/tx/0x214c64792eef926690412e2cc68ca8e371302fa6af3cfe3c7d90ad73ff0d4247) · [0x3f42d496…](https://testnet.snowtrace.io/tx/0x3f42d4962812e539642229e4a720ea6c0da850a73106fc8ff018a6857ae4a6dc) |
| `OrderApproved` for the agent's AVAX-TRY buy | [0x654458a3…](https://testnet.snowtrace.io/tx/0x654458a3375d7c5e94c73950afd7456a939c69b0247d9ae309e2a00d22668ed9) |
| OKX TR order, `clOrdId` derived from the on-chain order hash | entry `v2fa4881396d46d374bd41c52f82d8d` · exit `x972cb5f83f732960d36c1affef0280` |
| `ExitRecorded` | [0x0c4125d3…](https://testnet.snowtrace.io/tx/0x0c4125d3f42175b1604178ff92e41bc510eba35612ff1b0a83d0d46510f89a28) |
| `pnpm audit:orders` (OKX order history ↔ chain) | `✓ ENTRY OK zincirde onaylı` · `✓ EXIT OK çıkış zincirde kayıtlı` · **Tüm ajan emirleri onaylı** |
| ERC-8004 identity #283 + `VekilPolicy.setAgentId` | [0x1ebb9821…](https://testnet.snowtrace.io/tx/0x1ebb9821eb7ebd0146f79f2fca8a94a7d9b3c6f67a5ef286c47d776a0bac516a) · [0x477f25d0…](https://testnet.snowtrace.io/tx/0x477f25d0c5634e4fe75b295aad1f2ab1b71e427b9bd2b3e58c065253c720ef91) |

**Development run: paper trading on real OKX TR prices** · contract [`0x75c9b015…7999`](https://testnet.snowtrace.io/address/0x75c9b0155b0b026f869351ab3450723c44e57999)

| Step | Proof |
|---|---|
| `PolicySet` with the owner's Turkish source text in the event | [0xdfce1ca9…](https://testnet.snowtrace.io/tx/0xdfce1ca975af5ccbf6d2664e942e5599eaf39467548b97ecdb0953550680c076) |
| Red-team: "10,000 TL DOGE, no stop" → `OrderRejected` (`INSTRUMENT_NOT_ALLOWED`, `ORDER_TOO_LARGE`, `STOP_MISSING`) + `Paused(address(this))` in one tx | [0x4c254b82…](https://testnet.snowtrace.io/tx/0x4c254b825fb099417e40aa1f82ba596ce16cc3bcce9f5d0fbaeb27beaa2bf38c) |
| Kill switch "DURDUR": owner `pause()` | [0xf22c2c9d…](https://testnet.snowtrace.io/tx/0xf22c2c9d03bb956dad6e43d814546d9a7e714c90db9d99932a391415524bd7d8) |
| Autonomous round trip: `OrderApproved` → fill → stop hit → `ExitRecorded`, no human step after the decision | [0x14c4f3e7…](https://testnet.snowtrace.io/tx/0x14c4f3e73947f4bb5226ef96fd70590af91710346077c53215b22daa1dbe2e27) → [0xc05124ca…](https://testnet.snowtrace.io/tx/0xc05124ca39411d621b4d1eeeaaccb26b4a5f6eaf08604ffd1c0de3d680ceab6e) |
| Merkle anchor + on-chain inclusion proof (`verifyEntry` = true for the red-team rejection) | [0x657ae5c7…](https://testnet.snowtrace.io/tx/0x657ae5c7038e52b251ef2fd784afb48a064c33b33198d472057d56a2b4c6e2c5) · `pnpm verify --prove 56` |
| ERC-8004 identity #280 + `setAgentId` | [0xced08a98…](https://testnet.snowtrace.io/tx/0xced08a98c35ae0de4bc0766b18eda38c8168ab6db601383088882302d7e591ce) · [0xcb15a73a…](https://testnet.snowtrace.io/tx/0xcb15a73a4646801a00ad2ef180cc37ff019dafda47b87d77429b7317abacac99) |
| `pnpm verify` | V1–V6 all ✓ (ledger chain, anchors, approval before execution, rejections on-chain, exits on-chain, policy matches chain) |

## Security model: what is public and what is not

VEKİL exists to end *"give the AI the key and hope"*. So **no key that can move money ever sits on an internet-facing server.**

| Component | Where it runs | Keys | Who can use it |
|---|---|---|---|
| VekilPolicy contract | Avalanche C-Chain | none (owner wallet changes rules) | everyone can read and verify |
| Public site + VEKİL Guard API (`site/`) | Vercel | **none** | everyone: read rules, simulate orders, verify proofs |
| Agent + core + dashboard (`src/`, `web/`) | owner's machine, `127.0.0.1` only | OKX read key, agent wallet (can only request approvals), LLM key | the owner |
| Executor | owner's machine, separate process | **OKX trade key (no withdraw permission)** | nobody directly; obeys only on-chain approvals |

Managing other people's exchange accounts from our server would also conflict with the OKX TR API agreement (9.3). The production path keeps this property: wallet sign-in, OKX OAuth (supported by Agent Trade Kit), a per-user contract deployed from the user's own wallet, and the executor inside a TEE with on-chain attestation.

## Quick start

Requirements: Node ≥ 22.12, pnpm 10, Foundry (`forge`, `anvil`). On Windows use WSL.

```bash
pnpm i
pnpm check                          # typecheck + 367 tests
(cd contracts && forge test)        # 101 contract tests
pnpm smoke                          # end to end on a fresh anvil with the real contract, no .env needed
```

Dashboard with no keys at all (fake market, scripted LLM, local chain):

```bash
EXECUTION_MODE=fake LLM_PROVIDER=scripted CHAIN=local pnpm dev
```

Then open http://127.0.0.1:8788. The dashboard has four pages: **Kontrol paneli** (rules, agent, position, log), **Kontrata sor** (Guard), **Doğrula** (verify, prove, audit) and **Dayanıklılık testi** (red-team).

Real OKX TR prices with paper trading on Fuji: copy `.env.example` to `.env`, add an OKX `tr-read` profile to `~/.okx/config.toml`, and fill in the dev wallet and LLM keys, then:

```bash
pnpm chain:fuji                     # deploy your own VekilPolicy (asks y)
pnpm dev                            # paper: real prices, simulated balances, real on-chain approvals
```

Live trading runs only through `pnpm live` in a separate checkout, started by a human on a terminal. Step by step: [`docs/LIVE_RUNBOOK.md`](docs/LIVE_RUNBOOK.md).

## Commands

| Command | What it does | Who |
|---|---|---|
| `pnpm check` | typecheck + all TypeScript tests | anyone |
| `pnpm smoke` | end-to-end run on its own anvil with the real contract | anyone |
| `pnpm dev` | core + dashboard (+ executor process in paper); refuses live/mainnet | anyone |
| `pnpm verify [--prove <seq>]` | ledger, anchors, approvals, rejections, exits, policy; on-chain Merkle proof | anyone |
| `pnpm audit:orders` | every agent order on the exchange ↔ an on-chain approval | anyone |
| `pnpm guard` | VEKİL Guard HTTP API on `127.0.0.1:8791` | anyone |
| `pnpm export:proofs` | anchored ledger entries + Merkle proofs → `site/proofs.json` | anyone |
| `pnpm chain:fuji` · `pnpm policy:set` · `pnpm owner:pause` · `pnpm register-agent` | Fuji transactions, each asks for confirmation | owner |
| `pnpm kill` | halt core and executor, cancel open orders | owner |
| `pnpm live` · `pnpm resume` · `pnpm chain:mainnet` | real money / resume / mainnet; interactive terminal only | **human only** |

## VEKİL Guard API

The VekilPolicy rule engine as a service for other agents: *"may I send this order?"* Guard simulates `requestApproval` with `eth_call` from the agent address. It holds no keys, sends no transaction and changes no state. Because the contract never reverts for policy reasons, the answer carries the contract's own reason codes against the live counters, risk budget and brake. It is ready to be listed on an agent marketplace such as OKX.AI.

| Endpoint (public site) | Description |
|---|---|
| `GET /api/policy` | on-chain rules (incl. the Turkish source text), version, brake state, today's counters |
| `POST /api/check` | simulate a spot long order → `APPROVE` / `REJECT`, reasons `{code, tr}`, `critical`, `wouldPause`, notional, worst case |
| `GET /api/audit?clOrdId=v…` | is this exchange order approved on-chain? |
| `GET /.well-known/vekil-guard.json` | machine-readable service manifest |

```bash
curl -s -X POST https://vekilanchetr.vercel.app/api/check \
  -H 'content-type: application/json' \
  -d '{"instId":"DOGE-TRY","px":"7.007","sz":"1427.14428"}'
```

Answer: `REJECT` with `INSTRUMENT_NOT_ALLOWED`, `ORDER_TOO_LARGE`, `STOP_MISSING`, `critical: true`, `wouldPause: true`; nothing is written on-chain. The local service (`pnpm guard`) exposes the same checks under `/v1/*`, plus `/v1/policy/propose` (Turkish rules → policy draft, never applied). Design: [`docs/GUARD_PLAN.md`](docs/GUARD_PLAN.md).

## Repository map

| Path | What it is |
|---|---|
| `contracts/src/VekilPolicy.sol` | the on-chain policy engine; tests in `contracts/test/` |
| `src/shared/` | frozen foundation: config, zod schemas, interfaces, order hash, Merkle, money, canonical JSON, frozen test vectors |
| `src/agent/` | agent loop, prompts, tools, indicators, red-team, Text-to-Policy parser, LLM clients |
| `src/preflight/` | pure market-sanity checks that route every suspected violation to the chain |
| `src/chain/` | VekilPolicy client (viem), fake chain, anvil helper, ERC-8004 registration |
| `src/executor/` | the isolated executor: approval checks, inventory, exits, pause watcher, exchanges |
| `src/core/` | the cycle pipeline, kill switch, startup checks, executor sync, anchoring |
| `src/ledger/` | hash-chained ledger and verification (V1–V6, proofs) |
| `src/audit/` | the order auditor |
| `src/guard/` | VEKİL Guard logic and HTTP server |
| `src/server/`, `web/` | dashboard API (SSE) and the Turkish dashboard |
| `site/` | public keyless site and Guard API for Vercel |
| `scripts/` | CLI entry points (`pnpm …`) |
| `docs/` | specification, plan, OKX/ATK notes, runbook, Guard plan, agent card |

## Judging criteria map

| Criterion | Where VEKİL earns it |
|---|---|
| **Agentic design** | Self-scheduling agent; multi-step tool use (agent state → indicators → market context → OKX ATK market tools → decision); visible regime, playbook, evidence and scenarios; autonomous exits recorded on-chain with no human step. |
| **Technical execution** | Real OKX TR trade; contract on Fuji; public site; trust layers with an isolated executor; TS ↔ Solidity hash parity with frozen vectors; on-chain Merkle proofs; fuzz and invariant tests. |
| **Avalanche integration** | Every entry approved or rejected on C-Chain; the round trip (~3 s) is practical thanks to fast finality; self-pausing contract; Merkle anchors; ERC-8004 identity. |
| **OKX integration** | Agent Trade Kit: read-only instance for the agent, trade instance only in the executor, tool allowlist and manifest lock, verified on OKX TR. VEKİL Guard is a keyless service with a manifest, ready for OKX.AI. |
| **Innovation & real-world value** | Rules live in a public contract, so a fooled agent is stopped on-chain; addresses the OKX TR agreement's risk-control and prompt-injection duties; clear users and business model. |
| **Demo & presentation** | Turkish dashboard with a 4-step guide and plain-language status; anyone can try to fool the contract on the public site. |

## Business model and roadmap

- **Retail:** monthly subscription for a personal VEKİL (example: 99 TL / month).
- **VEKİL Guard:** pay-per-check policy API for agents and agent platforms (example: 0.01 USDC per check; a simulated HTTP 402 flow exists via `GUARD_PRICE`).
- **B2B:** policy-layer licence for exchanges and agent platforms; every CEX that opens to agents has the same trust problem.

**Next:** wallet sign-in and wallet-signed owner actions · OKX OAuth onboarding · one-click per-user contract · executor in a TEE (Nitro / Oyster) with on-chain attestation · exchange-side stops · OKX.AI listing · a dedicated Avalanche L1 for policy registries and ICM-based policy sharing.

## Honest limits

1. A contract cannot block a CEX API call by itself. Enforcement is **authorization** (the executor obeys only on-chain approvals) plus **detection** (the independent auditor). Attested TEE execution is the next step.
2. Market-sanity checks are local, because there is no TRY price oracle on-chain.
3. Stops are enforced by the executor process; exchange-side stops are planned.
4. The daily limit is planned worst-case risk based on stops, not realized PnL; price gaps can exceed it.
5. The LLM drafts the policy; the owner confirms it and the contract enforces hard caps (1,000 TL per order, 500 TL daily risk).
6. Today the owner key for `setPolicy` / `pause` is held by the local core as a convenience; wallet signing replaces it.
7. Contracts run on Fuji (testnet); mainnet deployment is a human-only command.

## Documentation index

| Document | For |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | full specification: the source of truth |
| [`docs/PLAN.md`](docs/PLAN.md) | milestones, ownership, acceptance criteria |
| [`PROGRESS.md`](PROGRESS.md) | status, decisions log, deployments |
| [`docs/ATK_NOTES.md`](docs/ATK_NOTES.md) | verified OKX TR / Agent Trade Kit facts |
| [`docs/LIVE_RUNBOOK.md`](docs/LIVE_RUNBOOK.md) | the human-only live trade, step by step |
| [`docs/GUARD_PLAN.md`](docs/GUARD_PLAN.md) · [`docs/guard-manifest.json`](docs/guard-manifest.json) | VEKİL Guard design and manifest |
| [`docs/agent-card.json`](docs/agent-card.json) | ERC-8004 agent card |
| [`CLAUDE.md`](CLAUDE.md) · [`AGENTS.md`](AGENTS.md) | instructions for AI coding agents working on this repo |
