# VEKİL

**Yapay zekâya ek kart veriyorsun: kuralı Türkçe yazıyorsun, kural Avalanche'taki kontratın ta kendisi oluyor; yapay zekâ kandırılsa bile kontrat reddediyor ve kartı donduruyor.**

Agentic Hackathon (OKX TR × Team1 Türkiye, Avalanche), Ankara, 17 Ekim 2026.

## Özet (Türkçe)

VEKİL, OKX TR hesabınızda AVAX-TRY spot işlem yapan otonom bir yapay zekâ ajanıdır. Farkı: **kurallar ajanın içinde değil, Avalanche'taki VekilPolicy kontratında.**

- **Kuralı Türkçe yazarsınız.** "Sadece AVAX, işlem başına en fazla 200 TL, her işlemde zarar-kes." Yapay zekâ bunu yapılandırılmış kurala çevirir, siz onaylarsınız, kontrata yazılır. Türkçe cümleniz zincirdeki olayda durur.
- **Yapay zekâ sadece okur.** OKX Agent Trade Kit'in salt-okunur araçlarıyla piyasayı inceler, rejimi, oyun planını, kanıtlarını ve senaryolarını açıkça yazar, bir karar önerir.
- **Her alım zincirden onay ister.** Kontrat emri kurala göre onaylar ya da reddeder; ikisi de zincirde kayıtlıdır. Açıkça zararlı bir istek (izinsiz parite, zarar-kes yok, limitin 2 katı) **freni kendiliğinden çeker.**
- **Emir gönderici ayrı bir süreçtir.** İşlem anahtarı sadece ondadır; yalnızca kontratın onayladığı emri gönderir, sadece kendi aldığını satar, zarar-kes/kâr-al/süre çıkışlarını kendisi yönetir. Fren çekilince açık emirleri kendisi iptal eder.
- **Her şey doğrulanabilir.** Karar defteri zincirleme hash'lidir, Merkle kökleri Avalanche'a çapalanır, tek bir kararın kanıtı zincirde doğrulanır; bağımsız denetçi borsadaki her emri zincirdeki onayla eşleştirir.

**Neden?** OKX TR API sözleşmesi sorumluluğu kullanıcıya yüklüyor (5.2 temsil, 6.2 işlem öncesi risk kontrolü, 12.2 prompt-injection koruması, 10.x denetim). Bugünkü yaygın çözüm "anahtarı ver ve umut et". VEKİL'de kural ve uygulaması, sadece sahibin değiştirebildiği açık bir kontratta.

**Kimin için?** Yapay zekâ ajanına küçük bir bütçeyle işlem yaptırmak isteyen bireysel yatırımcı ("ek kart"); ikinci olarak, ajan geliştiren ekipler ve kurumlar (uyum ve denetim izi).

**İş modeli.**
- (a) Bireysel: aylık abonelik ya da onay başına küçük bir ücret.
- (b) B2B: borsalar ve ajan platformları için "politika katmanı" API'si.
- (c) Kural motoru, OKX.AI'da başka ajanlara servis olarak sunulur ("bu emri gönderebilir miyim?").

CEX'lerde ajan erişimi hızla açılıyor (OKX ATK, Binance, Bitget, Coinbase) ve hepsinde aynı güven sorunu var.

## How it works

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

- **Entry:** decision → zod → preflight → `requestApproval` (tx, receipt) → APPROVED → executor recomputes the order hash and re-checks the chain → IOC buy with `clOrdId = "v" + hash[0..15)` → position with the approved stop / TP / time stop.
- **Rejection:** `OrderRejected(reasons)` stays on-chain. Critical reasons pause the contract; the executor sees it by itself, cancels and halts; core halts.
- **Exit:** the executor sells only its own inventory, never waits for the chain, then core records `recordExit` on-chain.
- **Kill:** local halt + executor halt and cancel-all + on-chain `pause()`, with timings shown in the dashboard.

Full design: [`docs/SPEC.md`](docs/SPEC.md). Build plan and status: [`docs/PLAN.md`](docs/PLAN.md), [`PROGRESS.md`](PROGRESS.md). Verified OKX TR / ATK facts: [`docs/ATK_NOTES.md`](docs/ATK_NOTES.md).

## Deployments and evidence

| What | Link |
|---|---|
| VekilPolicy (dev, Fuji) | [`0x75c9b0155b0b026f869351ab3450723c44e57999`](https://testnet.snowtrace.io/address/0x75c9b0155b0b026f869351ab3450723c44e57999) |
| Deploy tx | [0xdd668a6e…](https://testnet.snowtrace.io/tx/0xdd668a6e2cff771bc46fffce96a757703697a14382dcd76ecad06820e5138d0a) |
| `PolicySet` with Turkish source text | _to be added_ |
| `OrderApproved` (agent order) | _to be added_ |
| `OrderRejected` + `Paused` (red-team) | _to be added_ |
| Anchor + on-chain proof (`verifyEntry`) | _to be added_ |
| Live OKX TR trade (`clOrdId`) + clean `pnpm audit:orders` | _to be added_ |

## Run it

Requirements: Node ≥ 22.12, pnpm, Foundry (`anvil`, `forge`). On Windows use WSL.

```bash
pnpm i
pnpm check                 # typecheck + 340 unit/property tests
cd contracts && forge test # 101 contract tests (unit, fuzz, invariant)
pnpm smoke                 # end to end on its own anvil with the real contract, ~15 s, no .env needed
```

Dashboard with no keys at all (fake market, scripted LLM, local chain):

```bash
EXECUTION_MODE=fake LLM_PROVIDER=scripted CHAIN=local pnpm dev   # http://127.0.0.1:8788
```

Real market data and Fuji (paper trading, no real orders): copy `.env.example` to `.env`, fill the dev keys (OKX `tr-read` profile, Fuji wallets, LLM key), then

```bash
pnpm chain:fuji            # deploy your own VekilPolicy on Fuji
pnpm dev                   # paper: real OKX TR prices, simulated balances, approvals on Fuji
```

Live trading starts only through `pnpm live` in a separate checkout, by a human on a terminal (see `docs/PLAN.md`).

## Verify and audit

```bash
pnpm verify                # V1 ledger chain, V2 Merkle anchors, V3 approval before execution,
                           # V4 rejections on-chain, V5 exits on-chain, V6 policy matches the chain
pnpm verify --prove <seq>  # build the Merkle proof for one decision and check it with verifyEntry on-chain
pnpm audit:orders          # every agent order on the exchange ↔ an on-chain approval
```

## LLM providers

`LLM_PROVIDER=anthropic` (default, `LLM_MODEL=claude-sonnet-5-5`), `openrouter` (any OpenAI-compatible tool-calling model; comma-separated fallback list), or `scripted` (tests and offline demo; refused for live). The model only drafts: every decision and every policy is validated in code, and the contract enforces the rules.

## Honest limits

1. A contract can't block a CEX API call by itself. Enforcement is **authorization** (the executor obeys only on-chain approvals) plus **detection** (the independent auditor). Attested TEE execution is the next step.
2. Market sanity checks are local, because there is no TRY oracle on-chain.
3. Stops are enforced by the executor process (an exchange-side stop is a planned addition).
4. The daily limit is planned worst-case risk based on the stops, not realized PnL; price gaps can exceed it.
5. The LLM drafts the policy, but the owner confirms it and the contract enforces the hard caps (1000 TL per order, 500 TL daily risk).
6. Today the owner key for `setPolicy`/`pause` is held by the local core as a demo convenience; browser-wallet signing replaces it.

## Next steps

TEE attestation for the executor (Nitro / Oyster), browser-wallet signing, an on-chain price collar with an oracle, VekilPolicy as a shared policy service for other agents (OKX.AI listing), a dedicated Avalanche L1 for policy registries.
