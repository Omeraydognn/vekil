# VEKİL Guard: plan (JUDGING_PLAN §4)

Durum: **taslak, onay bekliyor.** Kod yazılmadı.

## Amaç

VekilPolicy'nin kural motorunu başka ajanların kullanabileceği bir servis olarak açmak. Başka bir ajan "bu emri gönderebilir miyim?" diye sorar. Guard, `requestApproval` çağrısını `eth_call` ile **simüle eder**:

- işlem göndermez, gaz harcamaz, zincirde iz bırakmaz;
- anahtar ya da para istemez;
- cevap, kontratın **o anki** gerçek durumuna göre verilir (sayaçlar, risk bütçesi, fren).

Bu OKX Integration'ın 2. alt kriterine (OKX.AI'da servis olarak listelenebilir, 5 puan) ve iş modeli anlatımına yazar.

## Nasıl çalışır

- **Simülasyon:** `requestApproval` yalnızca `agent` adresinden çağrılabiliyor. eth_call'u `from = agent()` ile yaparız. eth_call için imza gerekmez, yani anahtar gerekmez.
- **Revert olmaz:** kontrat politika nedeniyle hiç revert etmez. Dönüş `(orderHash, reasons)` olur; `critical` değeri `isCritical` ile hesaplanır (zincirdeki kuralın aynısı, `src/shared/reasons.ts`).
- **AlreadyRequested önlenir:** her simülasyon taze bir rastgele `nonce` kullanır.
- **Ek bilgi:** worst-case ve notional SPEC §13.1 formülüyle zincir dışında hesaplanır. Bunlar sadece bilgi amaçlıdır; karar `reasons`'tan gelir.

## Uç noktalar (HTTP JSON)

| Yöntem | Yol | Ne döner |
|---|---|---|
| GET | `/.well-known/vekil-guard.json` | Servis tanımı (manifest): ad, açıklama, zincir, kontrat adresi, uç noktalar, girdi/çıktı şemaları, fiyat bilgisi |
| GET | `/v1/policy` | Zincirdeki kurallar (Türkçe kaynak metin dahil), sürüm, fren durumu, bu saat/bugün sayaçları, kullanılan risk |
| POST | `/v1/check` | Girdi `{ instId, px, sz, stopPx?, tpPx?, timeStopMin? }` (alım, long-only). Çıktı `{ verdict: "APPROVE" \| "REJECT", reasons: [{code, tr}], critical, wouldPause, notional, worstCase, policyVersion, blockTimestamp, simulated: true }` |
| GET | `/v1/audit/:clOrdId` | `v…` için zincirde onay var mı ve onaylanan px/sz ne. `x…` için hangi girişe ait. Diğerleri için `MANUAL`. İsteğe bağlı `?px=&sz=&side=` verilirse bunları onaylanan emirle karşılaştırır (denetçi A1/A2 kuralları) |
| POST | `/v1/policy/propose` | Girdi `{ text }` (Türkçe kurallar). Çıktı `PolicyProposal`: alanlar, eşleme, varsayımlar, sorular, hatalar. **Uygulamaz**, çünkü Guard'da owner anahtarı yok. LLM yapılandırılmamışsa 503 döner |

**İsteğe bağlı, ilk kesilecek:** "onay başına ücret" simülasyonu. `GUARD_PRICE` ayarlanmışsa ve `x-payment` başlığı yoksa `/v1/check` HTTP 402 ve fiyat bilgisi döner. Gerçek ödeme yok; iş modeli anlatımı için.

## Dosyalar

| Dosya | İçerik |
|---|---|
| `src/chain/policy-chain.ts` | `ViemPolicyChain.simulateApproval(req)`: eth_call, `from = agent()`. Dönüş `{ orderHash, reasonsMask, blockTimestamp }`. Paylaşılan `PolicyChain` arayüzü değişmez (src/shared dondurulmuş) |
| `src/guard/guard.ts` | Saf mantık: girdi doğrulama (zod), `OrderRequest` oluşturma, cevap biçimi, worst-case/notional, audit kuralları (`src/audit/auditor.ts`'teki A1/A2 mantığını yeniden kullanır) |
| `src/guard/server.ts` | Express: uç noktalar, JSON hataları, istek başına zaman aşımı, basit hız sınırı |
| `src/guard/manifest.ts` | Manifest, hem uç noktada hem `docs/guard-manifest.json` dosyasında |
| `scripts/guard.ts` + `pnpm guard` | Servisi başlatır. Ortam: `CHAIN`, RPC, `VEKIL_POLICY_ADDRESS` veya `$DATA_DIR/deployment.json`, `GUARD_PORT` (varsayılan 8791), `GUARD_HOST` (varsayılan 127.0.0.1) |
| Testler | anvil üzerinde gerçek kontrat (smoke gibi). Geçerli emir → APPROVE. R1 → REJECT `[INSTRUMENT_NOT_ALLOWED, ORDER_TOO_LARGE, STOP_MISSING]`, critical, wouldPause. Simülasyondan sonra zincir değişmemiş olmalı (`approvals(hash).status == 0`, `paused == false`, blok numarası aynı). Fren aktifken PAUSED gelmeli. Audit v/x/manuel. HTTP şema ve hata kodları. Propose için scripted LLM |
| `README.md` | "VEKİL Guard" bölümü, curl örnekleri, iş modeli cümlesi |

## Güvenlik

- Guard **hiçbir anahtar tutmaz**: ne owner, ne agent, ne OKX. Yalnızca public RPC'den okur ve simüle eder.
- Varsayılan olarak 127.0.0.1'e bağlanır. İnternete açmak senin kararın; anahtar tutmadığı için risk düşük, ama yine de yalnızca bilerek açılmalı.
- Executor'a, ledger'a ve core'a dokunmaz. Ayrı bir süreçtir.
- `src/chain` değiştiği için commit'ten önce vekil-reviewer, `pnpm check` ve `pnpm smoke` çalışır.

## Süre ve kesme sırası

Tahmini süre 60–80 dakika. Zaman daralırsa kesme sırası:
1. 402 ücret simülasyonu
2. `/v1/policy/propose`
3. audit'te `?px=&sz=` karşılaştırması

Kesilmeyecekler: `/v1/check` simülasyonu, manifest ve `/v1/policy`.
