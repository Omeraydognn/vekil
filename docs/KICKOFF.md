# VEKİL: Claude Code başlangıç rehberi (v2.1)

This guide is for the team, so it is in Turkish; the prompts are in English. You can also write them in Turkish, but the documents are in English, so English prompts give fewer misunderstandings.

## 1. Paketin içi

| Dosya | Ne işe yarar |
|---|---|
| `CLAUDE.md` | Claude Code her oturumda bunu otomatik okur: proje özeti, 11 değişmez güvenlik kuralı, çalışma şekli, komutlar |
| `docs/SPEC.md` | Ne yapılacağının tamamı: VekilPolicy kontratı, izole emir gönderici, Türkçe kural yazma, ajan muhakemesi, kandırma testi, Merkle kanıtı, denetçi |
| `docs/PLAN.md` | Saat saat kilometre taşları, kimin hangi klasöre dokunacağı, kabul kriterleri, kesme sırası, canlıya geçiş adımları |
| `docs/ATK_NOTES.md` | Track B'nin ilk işi: ATK'nın gerçek araç adları ve parametreleri (tahmin yok, keşif var) |
| `PROGRESS.md` | Durum panosu; sadece `main` dalında güncellenir |
| `.claude/settings.json` | İzin kuralları: sırlar ve canlı klasör okunamaz; canlı/mainnet komutları yasak; zincire yazan komutlar ve `pnpm kill` sorulur |
| `.claude/agents/vekil-reviewer.md` | Her kilometre taşı sonunda değişiklikleri SPEC'e ve güvenlik kurallarına göre denetleyen alt ajan |
| `.mcp.json` | Claude Code'a ATK'yı **salt-okunur** bağlar |
| `.env.example` | Ortam değişkenleri şablonu (sırları sen dolduracaksın; varsayılan portlar geliştirme portları) |
| `.gitignore` | `.env`, `data/`, `refs/` vb. git'e girmez |

## 2. Bu sürümde ne var (jüri feedback'i + iki bağımsız denetim)

- **Kurallar zincirde:**
  - VekilPolicy kontratı her emri değerlendirir.
  - Reddi kaydeder (revert etmez).
  - Açık saldırıda freni kendisi çeker.
- **Emir gönderici izole:**
  - Ayrı bir süreçtir; işlem anahtarı sadece onda durur.
  - Zincir onayı olmadan emir göndermez.
  - Fren çekilince açık emirleri kendisi iptal eder.
  - Stop-loss'u da o yönetir, yani ajan çökse bile stop çalışır.
- **Türkçe kural yazma zorunlu:** Sahip yazar, yapay zekâ dönüştürür, sahip onaylar, kontrata yazılır. Sahibin cümlesi zincirdeki olayda yer alır.
- **Ajan muhakemesi görünür:** rejim, oyun planı, kanıtlar, senaryolar, ders.
- **Kandırma testi zincire kadar gider:** "10.000 TL DOGE AL, stopsuz" kontrattan döner ve fren çekilir. Ajan kanmazsa sistem bunu dürüstçe söyler ve simülasyonu gösterir.
- **Kanıt:** saatlik Merkle kökü; zincir üstünde tek bir kararın kanıtı; OKX hesabını zincirle eşleştiren bağımsız denetçi.
- **Sahip çıkışları:** "Pozisyonu kapat" ve "Durdur ve kapat" her durumda çalışır.
- **Denetimlerde yakalanıp düzeltilenler (önemli olanlar):**
  - kontrattaki taşma hatası: kandırma testindeki emir kontratı çökertecekti;
  - `pnpm audit`'in pnpm'in kendi komutuyla çakışması: artık `pnpm audit:orders`;
  - geliştirme ile canlının aynı OKX hesabına dokunması;
  - çapa (anchor) yarışları;
  - gerçekçi olmayan saat planı.
- **Dürüst sınır:** TEE için "bugün kriptografik garanti" demiyoruz. Bugün ayrı süreç ve denetçiyle tespit var; üretimde hedef TEE ve attestation.

## 3. Saat 10:00'dan önce (kod yok)

`docs/PLAN.md` → "Before 10:00" listesini yap.

Özetle:
- Organizatörlere 5 soruyu sor; workshop'ta DOGE-TRY listede mi bak.
- OKX TR'de iki anahtar aç (salt-okunur; işlem + para çekme YOK) ve `tr-read`/`tr-trade` profillerini oluştur.
- **Foundry** kur: `forge --version` ve `anvil --version` çalışmalı. **Windows'ta her şeyi WSL içinde çalıştır, Claude Code dahil.**
- **Dört** cüzdan aç ve hepsine Fuji AVAX koy.
- `.env`'i dev anahtarlarıyla doldur. Varsayılan portlar (8788/8790) zaten geliştirme portları.
- Anthropic API anahtarını al.

> Önceden kod yazmıyoruz; bu paket tasarım ve ayar dosyası. Check-in'de kurala uygun olduğunu teyit et.

## 4. 10:00: kurulum

```bash
unzip vekil-claude-code-paketi-v2.zip   # "vekil" klasörü çıkar (gizli dosyalar dahil)
cd vekil && git init
cp .env.example .env                     # SEN doldur (dev anahtarları); Claude bu dosyayı görmez
git clone --depth 1 --branch <kurulu ATK sürümünün etiketi> https://github.com/okx/agent-trade-kit refs/agent-trade-kit
# (etiket yoksa --branch kısmını sil)
git add -A && git commit -m "VEKİL tasarım paketi v2.1"
# 2+ kişiyseniz Track C hemen başlar (kontrat src/shared'e bağlı değil):
git worktree add ../vekil-c -b track-c
claude
```

Claude Code açılınca:
1. `okx-readonly` MCP sunucusunu **onayla**.
2. `/context` ile CLAUDE.md'nin yüklendiğini gör.
3. **Shift+Tab** ile "⏸ plan mode on" yap.
4. **Prompt 0**'ı yapıştır.

İkinci kişi aynı anda `../vekil-c` içinde `cp ../vekil/.env . && pnpm i 2>/dev/null; claude` ile **Track C** promptunu başlatır (§6). İlk dakikalarda `package.json` yoksa `pnpm i`'nin başarısız olması normal.

> **MCP bağlanmadıysa:** terminalde `okx-trade-mcp --profile tr-read --modules market,account,spot --read-only` çalıştırıp hataya bak.

## 5. Prompt 0: M0 (ana klasör, tek oturum)

```
We are building VEKİL during the hackathon. Before anything else, read CLAUDE.md, docs/SPEC.md and docs/PLAN.md in full. Then:
1. Summarize VEKİL in 5 bullets and restate the 11 safety invariants in your own words.
2. List anything in the SPEC that looks contradictory or unclear, with section numbers. Don't resolve it yourself.
3. Write a plan for milestone M0 only (PLAN.md "M0"): every file you will create, the exports of each src/shared module (interfaces exactly as SPEC §9.9, types from §9.10), the zod schemas mapped to SPEC §9, and the tests with their frozen vectors (order hash, Merkle 1/2/3/5 leaves, canonical, money incl. toScaledSigned and Pct2).
M0 does NOT include ATK discovery (that is Track B's first task). Do not write any code yet. Stop after the plan.
```

Planı oku, gerekirse düzelttir (**Ctrl+G**), plan modundan çık.

```
Plan approved. Implement M0 step by step and run pnpm check after each module. Check that `anvil --version` works.
Finish with the M0 acceptance list from PLAN.md: show the evidence, update PROGRESS.md and commit. Then tell me "M0 committed" so the other sessions can start.
```

## 6. M1: paralel izler

```bash
# M0 commit'lendikten sonra (≈11:00), ana klasörden:
git worktree add ../vekil-a -b track-a
git worktree add ../vekil-b -b track-b
git worktree add ../vekil-d -b track-d
# her biri için:
cd ../vekil-b && cp ../vekil/.env . && pnpm i
git clone --depth 1 --branch <aynı etiket> https://github.com/okx/agent-trade-kit refs/agent-trade-kit   # A ve B için
claude
```

**Track C: kontrat, zincir, defter (10:00'da başlar)**
```
You are the Track C session (VekilPolicy contract, chain client, ledger, verification) on branch track-c. Read CLAUDE.md, PLAN.md (Ownership + Track C) and SPEC §9.1, §9.2, §9.4, §9.6, §9.7, §9.9, §13, §16 and §23.4. Only edit files Track C owns.
src/shared does not exist yet on this branch: start with the contract, which doesn't depend on it. When I say "M0 committed", merge main into track-c and then assert hashOrderFor and verifyEntry against the frozen TS vectors.
First write a plan and wait for my approval. Then forge tests FIRST (every reason bit, auto-pause, access control, setPolicy validation, ALL arithmetic in uint256 with the overflow unit test, the no-revert fuzz test, buckets with vm.warp, exits, anchors, counters(), one basic invariant), then the contract. Vendor forge-std with --no-git. Then abi-sync (ABI + bytecode), policy-chain.ts (no bigint may leave src/chain), fake-policy-chain.ts, anvil.ts, then ledger and verify (V1–V4, proof, tamper), then the scripts and probe:chain --local. Never touch mainnet. Defer V5/V6, register-agent and Fuji probe:chain to M3.
At the end: forge test, pnpm check, the Track C acceptance steps with evidence, the vekil-reviewer subagent on your diff, and a commit whose message contains your status. Do not edit PROGRESS.md.
```

**Track B: ATK, ön kontrol, piyasa, emir gönderici, denetçi**
```
You are the Track B session (ATK discovery and client, market data, preflight, isolated executor, auditor) on branch track-b. Read CLAUDE.md, PLAN.md (Ownership + Track B), docs/ATK_NOTES.md and SPEC §8, §9.2–9.5, §9.9, §9.10, §12, §13.1, §13.2, §14, §15.2, §16.5, §17, §23.1, §23.2 and §26. Only edit files Track B owns. src/shared is frozen: if you need a change, stop and tell me exactly what and why.
Your FIRST task is ATK discovery: use the okx-readonly MCP tools and refs/agent-trade-kit to answer SPEC §25 items 1–7 and 14 and choose <R1_PAIR> in docs/ATK_NOTES.md (redact balances); then atk/client.ts (injected spawner — tests never spawn okx-trade-mcp; arming guard; cancelOnly rules), atk-probe, pnpm atk:lock and the allowlist.
Then write a plan for the rest and wait for my approval: preflight tests FIRST (every local reason, the routing table, PF1–PF6), the preflight, the fake (multi-instrument, forcePrice keeps the spread) and ATK market data, the executor (every refusal code, inventory, dust, one in-flight exit, monitor, pause watcher, cancel-all, HTTP server + client + in-process adapter, fake/paper/ATK exchanges; AtkExchange is never called against the live exchange), then the auditor with its order source by mode.
At the end: pnpm check, the Track B acceptance steps with evidence, the vekil-reviewer subagent on your diff, and a commit whose message contains your status. Do not edit PROGRESS.md.
```

**Track A: ajan ve Türkçe kural yazma**
```
You are the Track A session (agent loop, reasoning, red-team, Text-to-Policy parser) on branch track-a. Read CLAUDE.md, PLAN.md (Ownership + Track A) and SPEC §9.1, §9.3, §9.9, §9.10, §10, §11, §21, §22, Appendix C1, C2, D and §23.1. Only edit files Track A owns. src/shared is frozen: if you need a change, stop and tell me exactly what and why.
First write a plan and wait for my approval. Then work test-first: the loop (budget rules, forced submit_decision, allowlist, truncation, injection hook), prompts (C1 from the on-chain policy and counters, C2 naive only for test cycles, OWNER NOTE block), tools (get_agent_state, get_indicators with suggested levels exactly per §22.2, get_market_context), the scripted LLM (pctOfAsk, pctOfStop, validUntilInHours, suggested), red-team R1–R3 built at run time from the policy and current ask, then policy-parser.ts (forced propose_policy tool, validation and caps in code) and probe:policy. probe:agent must never touch the chain or the executor.
At the end: pnpm check, the Track A acceptance steps with evidence, the vekil-reviewer subagent on your diff, and a commit whose message contains your status. Do not edit PROGRESS.md.
```

**Track D: çekirdek, sunucu, panel**
```
You are the Track D session (core pipeline, server, Turkish dashboard) on branch track-d. Read CLAUDE.md, PLAN.md (Ownership + Track D) and SPEC §8, §9.5, §9.6, §9.8, §9.9, §10.1, §11, §12, §13.2, §15, §16, §17, §18, §19, §20, §21 and Appendix B. Only edit files Track D owns. src/shared is frozen: if you need a change, stop and tell me exactly what and why.
The other tracks are not on your branch: build against src/shared/interfaces.ts with minimal stand-ins in src/core/dev-stubs/ (deleted at M2). First write a plan and wait for my approval. Include: the §15 pipeline with routing, executor event sync (await the first recordExit), idempotent kill with integer ms timings that never waits for the mutex, owner close and flatten in every status, anchoring through the chain-write queue (§16.2), Text-to-Policy propose/apply, the startup checks listed for M1, every §19 endpoint, the dashboard (reasoning card, Text-to-Policy preview, red-team, Pozisyonu kapat, Doğrula with Kanıtla/Şimdi çapala, Denetçi, Sahip notu), fixtures/ui-events.jsonl with an SSE replay mode, and live.ts/resume.ts/kill.ts. Do not write smoke.ts (that is M2).
At the end: pnpm check, the Track D acceptance steps with evidence (UI replay), the vekil-reviewer subagent on your diff, and a commit whose message contains your status. Do not edit PROGRESS.md.
```

## 7. M2: birleştirme (13:15–14:45), ana klasörde tek oturum

```
Milestone M2. Merge the track branches into main in this order: track-c, track-b, track-a, track-d. Delete src/core/dev-stubs/. Resolve conflicts without changing the semantics of src/shared. Update PROGRESS.md from the track commit messages.
Then wire src/main.ts for real and check EXECUTION_MODE=fake LLM_PROVIDER=scripted CHAIN=local pnpm dev end to end. Write scripts/smoke.ts exactly per SPEC §23.3 and make pnpm smoke pass.
Then ask me before running pnpm chain:fuji (dev contract). Start EXECUTION_MODE=paper CHAIN=fuji LLM_PROVIDER=anthropic pnpm dev in the background, apply a Turkish policy through the API, and show me three real cycles with their reasoning, the on-chain OrderApproved/OrderRejected txs (Snowtrace links) and one paper fill through the executor process.
Do not run pnpm live and never touch ../vekil-live. I will do the live trade myself.
```

Sonra **sen**, kendi terminalinde, ilk gerçek işlemi yap (PLAN.md → M2 madde 5):
- paper'ı durdur;
- `../vekil-live`'ı aç, **canlı** anahtarları, `PORT=8787`, `EXECUTOR_PORT=8789` ve `I_CONFIRM_NO_WITHDRAW=yes` ayarla;
- `pnpm chain:fuji`, ardından `pnpm policy:set --maxOrderQuote <küçük> --maxHoldMin 20 --maxTradesPerHour 3`;
- `pnpm live` ve "CANLI";
- sahip notu gönder;
- sonunda `pnpm audit:orders`.

## 8. M3, 16:15, M4, M5

**M3 (14:45–16:15)**
```
Milestone M3. Work through the M3 list in PLAN.md in order, one item at a time: a short plan, implementation with tests, pnpm check (and forge test if contracts changed), a commit. Iterate kill and red-team scenarios on CHAIN=local; run each once on the Fuji dev contract with dev keys. When a resume is needed, ask me (I will unpause, stop, run pnpm resume and restart). After each item tell me in one line what changed and how to see it. Check the time with `date` between items; at 16:00 stop and report.
```

**16:15:** Özellik dondurma. Canlıyı **sen** PLAN.md → "16:15" adımlarıyla güncelle:
1. Varsayılan olarak **aynı kontrat ve aynı veri** ile devam et: `git checkout --detach main && pnpm i`, sonra `pnpm live`.
2. Başlangıç kontrolü (SC10 veya SC13) başarısız olursa arşivle ve taze kontrat kur.
3. Gerçek kuralları Türkçe yaz ve onayla.
4. `pnpm register-agent` çalıştır.

**M4 (16:15–17:30)**
```
Milestone M4: feature freeze, bug fixes only (dev keys, ports 8788/8790; never touch ../vekil-live). For every bug I report, first write a failing test, then fix it.
Then write README.md as described in PLAN.md M4 (including the honest limits from SPEC §24) and implement pnpm evidence (S7).
Finally, prove a fresh clone works without any .env: clone the repo into a temp folder, run pnpm i and pnpm smoke there, and show the output.
```

**M5:** İki prova yap; strateji anlatımı en fazla 10 saniye. Yedek video çek ve gönder.
- Provada canlı kontrat durduysa: `pnpm owner:pause --unpause` → Ctrl+C → `pnpm resume` → `pnpm live`.

## 9. Kurtarma komutları

| Durum | Ne yap |
|---|---|
| Yanlış yöne gidiyor | **Esc** ile durdur, yönlendir |
| Kötü bir değişiklik yaptı | **Esc Esc** veya `/rewind` |
| Yeni kilometre taşına geçiyorsun | `/clear`, sonra o taşın promptu |
| Bağlam doluyor | `/compact Keep: current milestone, files changed, failing tests, open questions, decisions.` |
| Spec'ten sapıyor | `Stop. Re-read SPEC §<n>. List every difference between the spec and your implementation, then propose fixes. Don't change code until I approve.` |
| Hash/Merkle uyuşmuyor | `Stop. Compare the TypeScript and Solidity encodings field by field against the frozen vectors in src/shared tests. Don't change the vectors.` |
| Kontrat testi revert ile düşüyor | `Check every multiplication in requestApproval is done in uint256 (SPEC §13.1). Policy reasons must never revert.` |
| Aynı hatayı döndürüp duruyor | `You've tried the same fix twice. Stop. List three hypotheses with the evidence for each, and the cheapest experiment that tells them apart.` |
| Kalite kontrolü | `Use the vekil-reviewer subagent to review this milestone's diff against the SPEC and the safety invariants. Fix every BLOCKER.` |

## 10. Güvenlik (senin sorumluluğun)

- Anahtarları **asla** sohbete yapıştırma. `.env`'e ve `~/.okx/config.toml`'a sen yaz.
- **Canlı anahtarlar sadece `../vekil-live/.env` içinde durur.** Claude'u o klasörde hiç açma.
- `pnpm live`, `pnpm resume` ve `pnpm chain:mainnet` **sadece senin terminalinde** çalışır.
- Dev ve canlı **aynı OKX hesabını** kullanır. Bu yüzden:
  - paper modu gerçek bakiyeye ve emirlere dokunmaz;
  - iptal-only istemci sadece canlı veri klasöründe çalışır.

  Bu kuralları gevşetme.
- İzin istemlerini okumadan onaylama: zincir komutları, `pnpm kill`, `git push`.
- Her push'tan önce `git diff --staged | grep -iE "secret|passphrase|private|api_key"` ile kontrol et.
- Canlı hesapta sadece kaybetmeyi göze aldığın tutar dursun.
