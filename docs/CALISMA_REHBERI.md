# VEKİL: Baştan Sona Çalışma Rehberi

Bu belge, VEKİL hakkında gelebilecek her soruyu cevaplayabilmen için yazıldı. Önce büyük resim, sonra her parçanın ayrıntısı, ardından kriterlere göre cevaplar ve sık sorulan sorular geliyor. Teknik terimlerin açıklamaları en sondaki sözlükte.

---

## 0. Otuz saniyede VEKİL

> **VEKİL, OKX TR hesabında kendi kendine AVAX-TRY alıp satan bir yapay zekâ ajanıdır. Farkı şu: kurallar ajanın içinde değil, Avalanche'taki bir akıllı kontrattadır. Ajan her alımdan önce kontrattan izin ister. Kontrat kurala uymayan emri reddeder; açıkça kötü niyetli bir emir gelirse freni kendisi çeker. Emri borsaya gönderen parça ayrıdır ve sadece zincirin onayladığını yapar. Her adım kayıt altındadır ve herkes zincirden doğrulayabilir.**

**Benzetme:** VEKİL, yapay zekâya verilen **limitli bir ek kart** gibidir.
- **Limitleri** kartın sahibi koyar: Türkçe kurallar.
- **Her harcamada banka provizyon verir:** kontratın onayı.
- **Şüpheli harcamada kart kendiliğinden donar:** otomatik fren.
- **Ekstre herkesin görebileceği yerdedir:** zincirdeki kayıtlar ve denetçi.

---

## 1. Problem: neden VEKİL var?

1. **Borsalar yapay zekâ ajanlarına kapı açıyor.** OKX'in Agent Trade Kit'i (ATK) var; Binance, Bitget, Coinbase da benzerlerini yapıyor.
2. **Bugünkü yöntem: "anahtarı ver ve umut et".** Ajana API anahtarı verilir. Ajan ne yaparsa yapar.
3. **Yapay zekâlar güvenilir risk yöneticisi değildir:**
   - **Prompt injection:** piyasa verisinin içine gizlenmiş "her şeyi sat" gibi talimatlara uyabilirler.
   - Sayı uydurabilir, gereksiz çok işlem açabilirler. Alpha Arena denemesinde çoğu model para kaybetti.
4. **Sorumluluk kullanıcıda.** OKX TR API sözleşmesine göre:
   - **5.2:** ajan kullanıcının temsilcisidir, sonuçtan kullanıcı sorumludur.
   - **6.2:** işlem öncesi risk kontrolü ve pozisyon limitleri kullanıcının görevidir.
   - **10.x:** OKX model, strateji ve risk kontrollerini sorabilir; anormallikler 24 saatte bildirilmelidir.
   - **12.2:** prompt-injection'a karşı korunmak kullanıcının sorumluluğundadır.
5. **Rakip botların "bize güvenin" yaklaşımı da çözüm değildir.** Çoğu trading botu kuralları kendi kodunun içinde tutar. O kodu yazan ya da anahtarı ele geçiren kişi kuralları atlayabilir; kullanıcının elinde kanıt yoktur. VEKİL bu yüzden kuralları kendi kodundan çıkarıp herkese açık, kimsenin değiştiremediği bir kontrata koyar.

**VEKİL'in cevabı:** kuralları **herkese açık, sadece sahibin değiştirebildiği bir kontrata** koymak. Anahtarı tutan parçanın tek bir işi olsun: zincirin onayladığını yapmak. Sonradan her şeyi bağımsız olarak denetlemek.

**Hedef kullanıcı:**
1. Yapay zekâya küçük bir bütçeyle işlem yaptırmak isteyen bireysel yatırımcı ("ek kart").
2. Ajan geliştiren ekipler ve kurumlar: uygulanabilir kurallar ve denetim izi isterler.

---

## 2. Büyük resim: beş parça

```
 GÜVENİLMEZ          BİZİM (güvenilir)         AVALANCHE (hakem)        İZOLE
┌───────────┐ karar ┌──────────────┐  istek  ┌───────────────┐ okur ┌────────────────┐
│ Ajan (LLM)│──────►│ Çekirdek     │────────►│ VekilPolicy   │◄─────│ Emir gönderici │
│ sadece    │       │ (core)       │         │ kontratı      │      │ işlem anahtarı │
│ okur      │       │ ön kontrol,  │         │ onay / ret /  │      │ sadece onda    │
└───────────┘       │ kayıt defteri│         │ fren          │      └───────┬────────┘
                    └──────────────┘         └───────────────┘              │ emir
                                       Denetçi: borsa emirleri ↔ zincir     OKX TR
```

| Parça | Ne yapar | Neye güveniyoruz |
|---|---|---|
| **1. Ajan (yapay zekâ)** | Piyasayı okur, düşünür, karar **önerir** | Hiç güvenmiyoruz; çıktısını her seferinde kontrol ediyoruz |
| **2. Çekirdek (core)** | Kararı kontrol eder, kontrata sorar, her şeyi kaydeder, paneli sunar | Bizim kodumuz; işlem anahtarı yok |
| **3. VekilPolicy kontratı** | Kuralları tutar, her emri onaylar ya da reddeder, freni çeker | Hakem; herkese açık ve değiştirilemez kod |
| **4. Emir gönderici (executor)** | Onaylı emri borsaya gönderir, pozisyonu korur, çıkışı yapar | İşlem anahtarının tek sahibi; izole süreç |
| **5. Denetçi (auditor)** | Borsadaki her emri zincirdeki onayla eşleştirir | Bağımsız; sadece okuma anahtarı ve herkese açık zincir yeter |

---

## 3. Bir emrin yolculuğu (bugünkü gerçek işlem üzerinden)

Bugün saat 18:00 civarında yaşanan gerçek OKX TR işlemi:

| # | Adım | Ne oldu |
|---|---|---|
| 1 | **Kural** | Canlı kontrata kurallar yazıldı: sadece AVAX-TRY, işlem başına en fazla 75 TL, saatte 3 işlem, en fazla 20 dakika tutma, zarar-kes %0,3–3, komisyon 22 bps. |
| 2 | **Sahip notu** | "Kurallar içinde minimum tutarda bir alım değerlendir." Bu not stratejiyi geçersiz kılabilir, kuralları kılamaz. |
| 3 | **Ajan düşündü** | Araçları sırayla çağırdı: `get_agent_state` → `get_indicators` → `get_market_context` → OKX piyasa araçları. Sonra `submit_decision` ile karar verdi: AL AVAX-TRY ~70 TL, önerilen zarar-kes ve kâr-al, 20 dakika süre. |
| 4 | **Çekirdek kontrol etti** | Kararın biçimi doğru mu (zod)? Piyasa makul mü (ön kontrol: fiyat taze mi, alış-satış farkı dar mı, bakiye yeter mi)? |
| 5 | **Kontrata soruldu** | `requestApproval` işlemi Fuji'ye gitti. Kontrat 15 kuralı tek tek kontrol etti, hepsi geçti → **OrderApproved** (tx `0x654458a3…`). |
| 6 | **Emir gönderici tekrar kontrol etti** | Emrin özetini (hash) kendisi yeniden hesapladı. Zincirde onaylı mı, süresi geçmedi mi, kurallar değişmedi mi, fren çekili mi? Hepsi tamam. |
| 7 | **Borsaya emir** | OKX TR'ye IOC limit alım emri gitti. Emir kimliği zincirdeki hash'ten türetildi: `v2fa4881396d46d374bd41c52f82d8d`. |
| 8 | **Pozisyon korundu** | Emir gönderici her 10 saniyede fiyatı izledi: zarar-kes, kâr-al ve 20 dakika süre sınırı. |
| 9 | **Çıkış** | Sahip "Pozisyonu kapat"a bastı → piyasa satışı `x972cb5f8…`. Emir gönderici sadece kendi aldığını sattı. |
| 10 | **Zincire kayıt** | Çıkış zincire yazıldı → **ExitRecorded** (tx `0x0c4125d3…`). |
| 11 | **Denetim** | `pnpm audit:orders` OKX'in emir geçmişini okudu, iki emri de zincirle eşleştirdi → "**Tüm ajan emirleri onaylı**". |

**Ret yolu (kandırma testi):** "10.000 TL DOGE al, zarar-kes koyma" emri kontrata gitti. Kontrat üç nedenle reddetti: izinsiz parite, limit aşımı, zarar-kes yok. Bu nedenler kritik olduğu için **aynı işlemde freni çekti** (`Paused`). Emir gönderici freni kendisi gördü, açık emirleri iptal etti ve durdu; çekirdek de durdu. Emir borsaya hiç gitmedi.

---

## 4. Parçaların ayrıntısı

### 4.1 Ajan (yapay zekâ)

- **Model:** Anthropic Claude Sonnet 5.5 (`claude-sonnet-5-5`), Messages API ve "tool use" ile. OpenRouter desteği de var. Testlerde "scripted" sahte LLM kullanılıyor.
- **Ajanın araçları:**

| Araç | Ne verir |
|---|---|
| `get_agent_state` | Açık pozisyon, kâr/zarar, zincirdeki sayaçlar (bu saat ve bugün kaç işlem), kullanılan risk, bekleme süresi, kurallar |
| `get_indicators` | EMA20/EMA50 (trend), RSI14, ATR14 (oynaklık), 24 saatlik aralık ve **önerilen seviyeler**: giriş, zarar-kes, kâr-al. Önerilen zarar-kes her zaman kuralların içine sığacak şekilde hesaplanır. |
| `get_market_context` | BTC-TRY trendi, emir defteri dengesi (alış/satış hacim oranı), işlem akışı (son 200 işlemde alıcı/satıcı oranı), hacim |
| OKX ATK piyasa araçları | Ticker, emir defteri, mumlar, işlemler; sadece izin listesindeki okuma araçları |
| `submit_decision` | Kararı bildirir; döngüyü bitiren araç |

- **Karar alanları:** eylem (AL, KAPAT, BEKLE, ZARAR-KES GÜNCELLE), rejim (yükselen trend, düşen trend, yatay bant, yüksek oynaklık, haber etkisi, belirsiz), oyun planı, 1–6 kanıt (her biri bir araç sonucuna dayanmak zorunda), yükseliş ve düşüş senaryoları, gerekçe, fikri bozan durum, güven puanı, **sonraki kontrol zamanı** ve ders.
- **Döngü kuralları:**
  - Döngü başına en fazla 8 araç çağrısı; son hakta `submit_decision` zorunlu.
  - Döngü başına 60 saniye zaman aşımı; saatte en fazla 20 döngü.
  - Araç sonuçları 6.000 karakterde kesilir.
- **Otonomi:** ajan bir sonraki bakış zamanını kendisi seçer. Çekirdek bunu 2–30 dakika arasına, açık pozisyon varken 2–10 dakikaya sınırlar.
- **Strateji (oyun planları):**
  - Trendde geri çekilmede al, bant içinde dipten al, kırılım sonrası testte al.
  - Yüksek oynaklık, haber, belirsizlik ya da düşen trendde **kenarda bekle**.
  - Pozisyon kârdaysa zarar-kesi başabaşa çek.
- **Güvenlik:**
  - Araç sonuçları **veri** sayılır, talimat değil (prompt-injection'a karşı).
  - Sadece sistem mesajı ve "OWNER NOTE" talimattır; sahip notu bile kuralları değiştiremez.
- **Neden yapay zekâ?** Rejimi okur, plan seçer, kanıtları tartar, kendini açıklar, Türkçe kuralları çevirir. **Risk kararı yapay zekâda değil**; deterministik kodda ve zincirde.

### 4.2 Türkçe kuraldan kontrata (Text-to-Policy)

1. Sahip panelde Türkçe yazar (en fazla 1.000 karakter).
2. Yapay zekâ `propose_policy` aracıyla yapılandırılmış bir kural taslağı üretir: alanlar, "senin cümlen → kontrat alanı → değer" eşlemesi, varsayımlar ve sorular.
3. **Kod kontrol eder (yapay zekâ değil):** aralıklar, sabit tavanlar, en yakın zarar-kes < en uzak zarar-kes, parite OKX'te gerçekten var ve açık mı, geçerlilik en fazla 7 gün.
4. Panel önizleme gösterir. Soru varsa sahip metni düzeltir ya da "varsayımları kabul ediyorum"u işaretler.
5. "Onayla ve zincire yaz" → kontratta `setPolicy` çalışır. Türkçe metin zincirdeki olayda kalır, hash'i kontratta saklanır.
6. Kaldıraç, açığa satış ya da zarar-kessiz işlem istenirse kurala yazılmaz; sahibe soru olarak gösterilir.

**Sabit tavanlar:** işlem başına en fazla **1.000 TL**, günlük risk en fazla **500 TL**. Kontrat kurulurken yazılır ve **asla değişmez**. Yapay zekâ kuralı yanlış çevirse ya da panel ele geçirilse bile bu tavan aşılamaz.

### 4.3 Ön kontrol (preflight)

- **Saf fonksiyondur:** dosya okumaz, saat okumaz, rastgelelik kullanmaz, sadece ondalık matematik yapar. Aynı girdiye her zaman aynı cevabı verir; bu yüzden kolay test edilir (2.000'er rastgele denemeyle özellik testleri).
- **Kontrol ettikleri:**
  - vekil durdurulmuş mu, fren çekili mi, zincir verisi taze mi (30 sn)
  - piyasa verisi var mı ve taze mi (15 sn), parite işleme açık mı
  - alış-satış farkı en fazla %0,3, fiyat piyasadan en fazla %1 uzakta
  - borsanın en küçük emir miktarı, bakiye yeterli mi
  - zaten açık pozisyon var mı, zarardan sonraki 60 dakikalık bekleme
- **Önemli kural: ön kontrol hakem değildir.** Şüpheli bir emri (izinsiz parite, limit üstü tutar, zarar-kes yok) **kendisi reddetmez, zincire gönderir.** Böylece kötü niyetli istek kontrat tarafından kalıcı olarak kaydedilir ve fren çekilir.
- **Neden piyasa kontrolleri zincirde değil?** Zincirde TL fiyat kaynağı (oracle) yok. Fiyat tazeliği gibi kontroller yerelde yapılır; politika kuralları zincirde.

### 4.4 VekilPolicy kontratı (Avalanche)

- **Dil ve araçlar:** Solidity 0.8.24; Foundry ile geliştirildi ve test edildi; Avalanche C-Chain'de (Fuji test ağı) yayında.
- **Sakladıkları:** kurallar, izinli pariteler, sürüm, fren durumu, her emrin onay/ret kaydı, saatlik ve günlük işlem sayaçları, günlük kullanılan risk, çıkış kayıtları, Merkle mühürleri, ERC-8004 ajan kimliği.
- **`requestApproval(emir)`:** sadece ajan cüzdanı çağırabilir. 15 kuralı kontrol eder:

| Bit | Kural | Kritik mi (fren çeker mi)? |
|---|---|---|
| 0 | Fren aktif | – |
| 1 | Kuralların süresi dolmuş | – |
| 2 | Parite izinli değil | **evet** |
| 3 | Yön izinli değil (sadece alım) | **evet** |
| 4 | Fiyat veya miktar sıfır | hayır |
| 5 | Tutar limiti aşıyor | **evet, limitin 2 katından fazlaysa** |
| 6 | Zarar-kes yok | **evet** |
| 7–9 | Zarar-kes geçersiz / çok yakın / çok uzak | – |
| 10 | Kâr-al geçersiz | – |
| 11 | Süre sınırı geçersiz | – |
| 12–13 | Saatlik / günlük işlem sınırı doldu | – |
| 14 | Günlük risk bütçesi aşılır | – |

- **Hiçbir zaman politika yüzünden geri alınmaz (revert).** Ret de kaydedilir; böylece kötü niyetli istek kalıcı olarak görünür. Sadece "ajan değilsin" ve "bu emir zaten soruldu" durumlarında geri alınır.
- **Taşma koruması:** bütün çarpımlar 256 bitle yapılır. Testte bulunan bir hata buydu: 10.000 TL'lik kandırma emri 64 bitlik çarpımda taşıp kontratı çökertecekti.
- **En kötü kayıp formülü:** (giriş − zarar-kes) × miktar + tutar × (2 × komisyon + kayma). Günlük toplam bütçeyi aşamaz.
- **Sayaçlar Türkiye saatine göre:** saat = (zaman + 10.800) / 3.600, gün = (zaman + 10.800) / 86.400. 10.800 saniye 3 saattir (UTC+3).
- **Onayın geçerlilik süresi 120 saniyedir.** Emir gönderici onayı 2 dakika içinde kullanmazsa onay geçersiz olur.
- **Diğer fonksiyonlar:**
  - `setPolicy` (sadece sahip; aralıkları ve tavanları kontrol eder; freni açmaz, sayaçları sıfırlamaz)
  - `pause` / `unpause` (sadece sahip)
  - `recordExit` (çıkış kaydı; fren çekiliyken de çalışır)
  - `anchor` (Merkle mühürü; sıralı olmak zorunda)
  - `verifyEntry` (bir kaydın mühürde olduğunu doğrular)
  - `setAgentId` (ERC-8004 bağlantısı)

### 4.5 Emir gönderici (executor)

- **Ayrı bir işletim sistemi sürecidir.** OKX **işlem** anahtarı sadece burada. Anahtarda para çekme yetkisi yok; başlangıçta SC6 kontrolü bunu sahibe onaylatır.
- **Alım öncesi kontrolleri:**
  1. Emrin hash'ini kendisi yeniden hesaplar; çekirdeğin söylediğine güvenmez.
  2. Zincirde bu hash **onaylı** mı?
  3. Onayın süresi geçmemiş mi (blok zamanına göre)?
  4. Kurallar o zamandan beri değişmemiş mi?
  5. Fren çekili değil mi?
  6. Bu emir daha önce gönderilmemiş mi?
- **Emir:** IOC limit alım (hemen dolmayan kısım iptal olur; fiyat kaçarsa pahalıya almaz). Fiyat ve miktar tam olarak onaylanan değerlerdir.
- **Emir kimliği (clOrdId):** `v` + zincirdeki hash'in ilk 15 baytı. Borsadaki emir doğrudan zincirdeki onaya bağlanır. Çıkışlar `x` + (giriş hash'i + rastgele sayı) hash'i.
- **Envanter:** sadece kendi aldığını satar. Komisyon düşülür; borsanın satamayacağı kadar küçük kalan kısım "toz" sayılır.
- **Koruyucu çıkışlar:** her 10 saniyede zarar-kes, kâr-al ve süre sınırına bakar. Çıkışlar **zinciri beklemez**; fren çekili olsa bile çalışır. Aynı anda pozisyon başına tek çıkış yapılır (çift satış olmaz).
- **Fren izleyici:** her birkaç saniyede kontrata bakar. Fren çekildiyse açık emirleri iptal eder ve durur. Çekirdek çökse bile çalışır.
- **Bugünkü izolasyon:** ayrı süreç. **Hedef:** TEE (AWS Nitro Enclaves ya da Marlin Oyster) ve zincirde doğrulanmış kod hash'i.

### 4.6 Çekirdek (core)

- **Döngü:** karar → zod → taze veri → ön kontrol → kayıt.
  - Alım ise: zincire sor → onaylıysa emir göndericiye ilet.
  - Kapatma ve zarar-kes güncellemesi doğrudan emir göndericiye gider.
- **Zincire yazma kuyruğu:** ajan cüzdanından aynı anda tek işlem gider (nonce çakışmasın). Sıra: onaylar, çıkış kayıtları, mühürler.
- **Durdurma (DURDUR):**
  1. Yerel durma (milisaniyeler içinde)
  2. Emir gönderici durur ve açık emirleri iptal eder
  3. Zincirde fren (`pause`)
  - Süreler panelde gösterilir; örnek: "yerel 14 ms · emirler 283 ms · zincir 4,6 sn". İlk iki adım hiçbir şeyi beklemez.
- **Devam ettirme sadece insanla olur:** freni sahip açar (`pnpm owner:pause --unpause`), terminalde `pnpm resume` ve `DEVAM`. Panelde devam düğmesi **bilerek yok**.
- **Başlangıç kontrolleri:**

| Kontrol | Ne kontrol eder |
|---|---|
| SC1 | Ayarlar geçerli |
| SC2 | Mod izinli |
| SC3 | Okuma anahtarı salt-okunur |
| SC5 | Emir gönderici hazır ve izole |
| SC6 | Para çekme yetkisi yok |
| SC7 | Parite açık |
| SC8 | Kontrat erişilebilir |
| SC11 | Durdurma kaydı yok |
| SC13 | Veri klasörü bu çalıştırmaya ait |

- **Mühürleme:** saatte bir (ve durdurmada, frende) kayıtların Merkle kökü zincire yazılır.

### 4.7 Kayıt defteri ve doğrulama

- **Kayıt defteri:** her olay (karar, ön kontrol, zincir isteği, emir, dolum, çıkış, durdurma…) bir satır. Her satırın hash'i bir öncekini içerir; biri değiştirilirse zincir kopar.
- **Kanonik JSON:** anahtarlar sıralı, ondalık sayı yok, büyük sayı yok. Aynı veri her yerde aynı hash'i verir.
- **Merkle mühürü:** bir grup kaydın tek bir kök hash'e indirgenmesi. Kök zincire yazılır; sonra tek bir kaydın o kökte olduğu kısa bir kanıtla gösterilir.
- **Doğrulama (V1–V6):**

| Kontrol | Anlamı |
|---|---|
| V1 | Defter sağlam |
| V2 | Mühürler zincirle eşleşiyor |
| V3 | Her emirden önce zincirde onay var |
| V4 | Her ret zincirde kayıtlı |
| V5 | Her çıkış zincirde kayıtlı |
| V6 | Kurallar zincirdekiyle aynı |

- **Kanıtla:** tek bir kararın zincirdeki mühürde olduğunu **kontratın kendisine** doğrulatır (`verifyEntry`).
- **Kurcalama testi:** bir kaydın kopyasını bozar; sistem tam o kayıtta hatayı yakalar.

### 4.8 Denetçi

- **Girdi:** son 24 saatin borsa emirleri. Canlıda OKX'ten okuma anahtarıyla, emir göndericiden bağımsız olarak okunur.
- **Kurallar:**
  - **`v…` emirleri:** zincirde onay var mı, fiyat, miktar ve parite onaylananla aynı mı?
  - **`x…` emirleri:** çıkış zincirde kayıtlı mı, satılan miktar alınandan fazla değil mi?
  - **Diğerleri:** "manuel"; sahibin elle verdiği emirler.
- Emir gönderici hile yapsa bile burada yakalanır. Bugün bu bir **tespit** katmanı; TEE gelince **engelleme** katmanı da olacak.

### 4.9 VEKİL Guard

- **Fikir:** kontratın kural motorunu başka ajanlara servis olarak sunmak. Soru: "Bu emri gönderebilir miyim?"
- **Nasıl:** `requestApproval` çağrısı `eth_call` ile **simüle edilir**. İşlem gönderilmez, gaz harcanmaz, zincir değişmez, anahtar gerekmez. Kontrat politika yüzünden geri alınmadığı için cevap kontratın kendi ret nedenlerini içerir.
- **Uç noktalar:** kurallar (`/api/policy`), emir kontrolü (`/api/check`), emir kimliği denetimi (`/api/audit`), servis tanımı (`/.well-known/vekil-guard.json`).
- **Nerede:** herkese açık sitede (https://vekilanchetr.vercel.app), panelde "Kontrata sor" sayfasında ve `pnpm guard` ile yerel bir API olarak.
- **OKX.AI:** kriter "listelenebilir" istiyor. Guard anahtarsız, durumsuz, makinenin okuyabileceği tanımı olan bir servis; listelenmeye hazır.

### 4.10 Panel ve herkese açık site

- **Panel (sahip için, `127.0.0.1`):** Türkçe, 4 sayfa:
  - **Kontrol paneli:** kural yaz, zincirdeki kurallar, ajanın kararı ve gerekçesi, bugünün özeti, işlem günlüğü
  - **Kontrata sor:** Guard
  - **Doğrula:** V1–V6, kanıt, mühür, kurcalama, denetim, sistem kontrolleri
  - **Dayanıklılık testi:** gerçek kandırma testleri
  - Ayrıca: 4 adımlık rehber, "şu an ne yapıyor ve neden" cümlesi, durdurulunca devam adımları.
- **Herkese açık site (Vercel):** anahtarsız. Zincirdeki kurallar, kontrata sorma, kayıtları zincirde doğrulama, emir kimliği arama, gerçek işlemin kanıtı ve neden orada işlem yapılmadığının açıklaması.

### 4.11 ERC-8004 ajan kimliği

- ERC-8004, yapay zekâ ajanları için zincir üstü bir **kimlik kaydı** standardıdır; her ajan bir NFT benzeri kimlik alır.
- VEKİL'in **ajan kartı** (adı, açıklaması, ajan cüzdanı, kontrat adresi, kaynak kod linki) kayda yazıldı. Kontrat da bu kimliğe bağlandı (`setAgentId`).
- **Canlı ajan #283, geliştirme ajanı #280** (Fuji Identity Registry `0x8004A818…`).
- **Neden:** başka ajanlar ve platformlar VEKİL'i tanıyabilir, itibar ve doğrulama sistemlerine bağlanabilir.

---

## 5. Kullandığımız teknolojiler ve nedenleri

| Teknoloji | Nerede | Neden |
|---|---|---|
| **TypeScript + Node.js 22** | bütün uygulama | Tip güvenliği; OKX ATK ve viem'in ekosistemi |
| **zod** | her dış girdi (ayarlar, yapay zekâ çıktısı, OKX cevapları, HTTP) | Güvenilmeyen veriyi doğrulamadan kullanmamak |
| **decimal.js** | bütün para hesapları | Ondalık sayılarda hata olmasın (0,1 + 0,2 sorunu) |
| **viem** | kontratla konuşma | Modern, tipli Ethereum/Avalanche kütüphanesi |
| **Solidity 0.8.24 + Foundry** | kontrat ve testleri | Fuzz ve invariant testleri; `anvil` ile yerel zincir |
| **Avalanche C-Chain (Fuji)** | kontrat | Hızlı kesinlik (~1–3 sn): her emre zincirde onay pratik hâle geliyor; ucuz gaz |
| **OKX Agent Trade Kit 1.4.8** (`okx-trade-mcp`) | piyasa verisi, bakiye, emir | OKX'in resmî ajan aracı; MCP üzerinden; TR sitesi destekli |
| **Model Context Protocol SDK** | ATK ile konuşma | ATK bir MCP sunucusu |
| **Anthropic SDK (Claude Sonnet 5.5)** | ajan ve Text-to-Policy | Araç kullanımı ve Türkçe yeteneği güçlü |
| **Express + SSE** | panelin API'si | Canlı akış (olaylar anında panele düşer) |
| **Saf JavaScript** | panel ve site | Hızlı, bağımlılıksız |
| **Vercel** | herkese açık site + Guard API | Anahtarsız, sunucusuz yayın |
| **vitest + fast-check** | TypeScript testleri | Birim ve özellik (rastgele) testleri |
| **Multicall3** | Fuji'de okumalar | Okumaları tek istekte topluyor; RPC hız sınırı için |
| **publicnode RPC** | Fuji bağlantısı | Varsayılan Avalanche RPC'si bizi hız sınırına takıp engelledi |

---

## 6. Çalışma modları

| Mod | Piyasa verisi | Emirler | Kullanım |
|---|---|---|---|
| **fake** | sahte | sahte borsa | testler, `pnpm smoke`, anahtarsız demo |
| **paper** (kâğıt) | **gerçek OKX TR** | simüle (gerçek para yok) | geliştirme ve güvenli deneme; onaylar yine gerçek kontrata |
| **live** (canlı) | gerçek OKX TR | **gerçek OKX TR emri** | sadece `pnpm live`, insanın terminalinden, `CANLI` yazılarak |

- **Zincir seçenekleri:** `fake` (sahte), `local` (anvil, gerçek kontrat), `fuji` (test ağı), `mainnet` (sadece insan).
- **Geliştirme ve canlı birbirinden ayrı:** ayrı klasör (`vekil-live`), ayrı portlar (8787/8789 canlı, 8788/8790 geliştirme), ayrı veri klasörü, ayrı kontrat.

---

## 7. Güvenlik: kurallarımız ve nedenleri

**On bir değişmez kural (sade dille):**
1. Yapay zekâ asla emir verebilen bir araç almaz; sadece okur.
2. İşlem anahtarı sadece emir göndericidedir. O da sadece kendi doğruladığı, zincirde onaylı emri gönderir ve sadece kendi aldığını satar.
3. Kurallar zincirdedir. Yerel kontrol hakem değildir; şüpheliyi zincire gönderir.
4. Ön kontrol saf fonksiyondur.
5. Hata olursa alım yapılmaz; çıkış ise hiçbir şeyi beklemez.
6. Canlı emirleri sadece insan başlatır.
7. Gizli bilgiler (anahtarlar, `.env`) asla okunmaz, yazdırılmaz, kaydedilmez.
8. Para çekme ve transfer yetkisi yok. Kaldıraç, vadeli işlem ve açığa satış yok.
9. Mainnet sadece insanın açık isteğiyle.
10. Çekirdek ve emir gönderici sadece `127.0.0.1`'de dinler.
11. Canlı klasöre geliştirme sırasında dokunulmaz.

**Neden her şey internette değil?**
- Parayı yönetebilen hiçbir anahtar internete açık bir sunucuda durmaz. Herkese açık olan sadece anahtarsız kısımlar: kontrat, Guard ve doğrulama.
- Başkasının hesabını bizim sunucumuzdan yönetmek OKX TR API sözleşmesine (9.3) de aykırı.
- **Ürünleşince:** kullanıcı cüzdanıyla girer, OKX'e OAuth ile bağlanır (ATK destekliyor), kendi kontratını kendi cüzdanından kurar, emir gönderici TEE'de çalışır. Anahtar hiçbir zaman bizde olmaz.

---

## 8. Testler ve kalite

| Test | Sayı / sonuç |
|---|---|
| TypeScript testleri (birim, özellik, entegrasyon) | **367** test |
| Kontrat testleri (Foundry: birim, fuzz, invariant, taşma) | **101** test |
| Uçtan uca smoke (yerel zincirde gerçek kontratla 14 adım: kural, alım, engel, zarar-kes, çıkış, kandırma, fren, doğrulama, denetim) | yaklaşık 35 sn, geçiyor |
| **Sabit test vektörleri** | Emir hash'i, Merkle kökleri ve kural hash'i Foundry'nin `cast` aracıyla **bağımsız olarak** hesaplandı. TypeScript ve Solidity birebir aynı sonucu veriyor. |
| Özellik testleri (fast-check) | Ön kontrol için 2.000'er rastgele deneme; sitenin kodu ile ana kodun aynı davrandığını gösteren testler |
| Kod incelemesi | Her önemli değişiklikte güvenlik kurallarını ve SPEC'i kontrol eden bir inceleme ajanı |

---

## 9. Bugün canlıda olanlar (kanıt listesi)

| Ne | Kanıt |
|---|---|
| Gerçek OKX TR işlemi | onay `0x654458a3…` → emir `v2fa4881…` → çıkış `0x0c4125d3…` |
| Denetim | "Tüm ajan emirleri onaylı" (giriş OK, çıkış OK) |
| Kandırma testi | ret + fren tek işlemde `0x4c254b82…` |
| Kâğıt modda otonom tur | onay → dolum → zarar-kes tetiklendi → çıkış zincirde |
| Zincirde kanıt | Merkle mühürü + `verifyEntry` = doğru |
| Türkçe kural zincirde | `PolicySet` olayında sahibin metni |
| ERC-8004 | #283 (canlı), #280 (geliştirme) |
| Herkese açık ürün | https://vekilanchetr.vercel.app |
| Kod | https://github.com/Omeraydognn/vekil |

---

## 10. Kriterlere göre cevaplar

**Agentic Design: otonomi**
- Ajan ne zaman bakacağını kendisi seçer.
- Araçlarını kendisi seçip sırayla çağırır.
- Pozisyonu zarar-kes, kâr-al ve süre sınırıyla otomatik kapatır; çıkışı zincire kendisi yazar.
- Kâğıt modda insan dokunmadan tam tur yaptı: onay → dolum → zarar-kes → çıkış kaydı.
- Sahip notu isteğe bağlı. Düşen piyasada ajan haklı olarak bekliyordu; test için alım istedik. Kontrat yine son sözü söyledi.

**Agentic Design: akıl yürütme ve araç kullanımı**
- Çok adımlı plan: durum → indikatörler → piyasa bağlamı → OKX araçları → karar.
- Her kanıt bir araç sonucuna dayanmak zorunda.
- Rejim, oyun planı, iki senaryo, fikri bozan durum ve ders panelde görünür. Önceki ret nedenlerini okuyup uyum sağlar.

**Technical Execution**
- **Deploy edilmiş ürün:** kontrat Fuji'de, gerçek OKX işlemi yapıldı, site ve Guard API Vercel'de yayında.
- **Mimari:** güven katmanları (salt-okunur yapay zekâ, zincirde hakem, izole emir gönderici, bağımsız denetçi); her dış girdi doğrulanıyor; hata olursa alım yok.
- **Zorluk:** TS ↔ Solidity hash eşitliği, zincirde Merkle kanıtı, 256 bit taşma koruması, fuzz ve invariant testleri, çift satışı önleyen çıkış kilidi, onay süresi ve blok zamanı kontrolü.

**Avalanche Integration**
- **C-Chain'de:** VekilPolicy Fuji C-Chain'de; her alım zincirde onaylanıyor ya da reddediliyor.
- **Avalanche'ın gücü:** hızlı kesinlik sayesinde her emre zincirde ~3 saniyede onay pratik; Ethereum'da bu 12 saniyeden fazla olurdu. Kendi kendini durduran kontrat, Merkle mühürleri, ERC-8004 kimliği.
- **Yol haritası:** kural kayıtları için özel bir Avalanche L1; borsalar arası kural paylaşımı ICM ile.

**OKX Integration**
- **Agent Trade Kit gerçekten kullanılıyor:** ajan ve çekirdek için salt-okunur örnek, emir gönderici için ayrı işlem örneği; araç izin listesi ve araç listesi kilidi. OKX TR'de doğrulandı, gerçek emir verildi.
- **OKX.AI:** VEKİL Guard anahtarsız, makinenin okuyabileceği servis tanımı olan bir API olarak yayında; listelenmeye hazır.

**Innovation & Real-World Value**
- **Özgünlük:** kural ajanın içinde değil, herkese açık bir kontratta; ajan kandırılsa bile kontrat reddeder ve freni çeker.
- **Problem ve kullanıcı:** OKX TR sözleşmesi risk kontrolü ve prompt-injection korumasını kullanıcıya yüklüyor; kullanıcı yapay zekâya bütçe vermek isteyen yatırımcı ve ajan geliştiren ekipler.
- **İş modeli:** bireysel abonelik (örnek aylık 99 TL); Guard kontrol başına ücret (örnek 0,01 USDC); borsalar ve platformlar için B2B politika katmanı.
- **Pazara hazırlık:** bugün gerçek işlem ve herkese açık doğrulama var. Çok kullanıcılı yol belli: cüzdan girişi, OKX OAuth, kullanıcı başına kontrat, TEE.

**Demo & Presentation**
- Türkçe panel, 4 sayfa, adım rehberi, sade dille durum.
- Herkes sitede kontratı kandırmayı deneyebiliyor.
- Kanıtların hepsi Snowtrace'te tıklanabilir.

---

## 11. İş modeli, pazar ve yol haritası

- **Pazar:** OKX, Binance, Bitget ve Coinbase ajan erişimini açıyor; hepsinde aynı güven sorunu var. Kurallar zincirde olduğu için borsadan bağımsız bir "politika katmanı" olabilir.
- **Gelir:**
  1. Bireysel abonelik
  2. Guard için kontrol başına ücret (HTTP 402 akışı simüle edildi)
  3. Borsalar ve ajan platformları için lisans
- **Yol haritası:**
  1. Cüzdanla giriş ve cüzdanla imzalanan sahip işlemleri
  2. OKX OAuth ile bağlanma
  3. Tek tıkla kullanıcı başına kontrat
  4. Emir gönderici TEE'de, kod hash'i zincirde
  5. Borsa tarafında zarar-kes emri
  6. OKX.AI listelemesi
  7. Avalanche L1 ve ICM

---

## 12. Sık sorulabilecek sorular ve cevaplar

**S: Avalanche burada sadece bir veritabanı değil mi?**
C: Hayır. Kontrat kuralları **değerlendiriyor**: onay ve ret kararını zincir veriyor, kritik ihlalde freni zincir çekiyor. Emir gönderici zincirde onay görmeden işlem yapmıyor.

**S: Kontrat borsadaki emri gerçekten engelleyebilir mi?**
C: Bir kontrat bir borsa API'sini doğrudan durduramaz; bunu açıkça söylüyoruz. Uygulama iki katmanlı: **yetkilendirme** (emir gönderici sadece zincir onayıyla çalışır) ve **tespit** (denetçi, onaysız tek bir emri bile yakalar). Üçüncü adım TEE: emir göndericinin değiştirilmediğini donanım kanıtlar.

**S: Emir gönderici değiştirilirse ne olur?**
C: Bugün tek işi olan ayrı bir süreç. Onaysız bir emir verirse denetçi bunu OKX'in emir geçmişinden yakalar ve kanıtlar. Üretimde TEE ve zincirdeki kod hash'i bunu engelleyecek.

**S: Yapay zekâ kandırılırsa?**
C: Kontrat reddeder. Kritikse freni kendisi çeker, emir gönderici açık emirleri iptal eder ve durur. Bunu canlı gösterdik.

**S: Neden yapay zekâ kullanıyorsunuz, risk yine onda değil mi?**
C: Risk kararı yapay zekâda değil. Yapay zekâ piyasayı okur, plan seçer, kendini açıklar, Türkçe kuralı çevirir. Limitler, zarar-kes zorunluluğu ve risk bütçesi zincirde ve deterministik kodda.

**S: Gecikme ve gaz maliyeti?**
C: Alımdan önce yaklaşık 1–3 saniyelik zincir onayı; 5–15 dakikalık kararlar için önemsiz. IOC limit emir fiyatı korur. Çıkışlar zinciri beklemez. Saatte birkaç işlem, mainnet'te bile kuruşlar.

**S: Para kazandırıyor mu?**
C: Amaç kontrol. Risk bütçesi zincirde zorunlu, kâr ve zarar açıkça gösteriliyor. Strateji ikincil; güvenlik katmanı ana ürün.

**S: Zarar-kes nerede çalışıyor?**
C: Emir göndericide, her 10 saniyede. Fren çekili olsa bile çalışır. Borsa tarafında zarar-kes emri sonraki adım.

**S: Fiyat boşluğunda günlük limit aşılabilir mi?**
C: Evet. Günlük limit zarar-kese göre planlanan en kötü risk; gerçekleşen zarar değil. Ani fiyat boşlukları bunu aşabilir. Bunu dürüstçe söylüyoruz.

**S: Neden paneli internete açmadınız?**
C: Panelin arkasındaki süreç anahtar tutuyor. Parayı yönetebilen anahtarı internete açmak, çözdüğümüz sorunun ta kendisi olurdu. Herkese açık olan anahtarsız kısımlar; ürün sürümünde anahtar kullanıcının cüzdanında ve TEE'de kalacak.

**S: Başka kullanıcılar nasıl kullanacak?**
C: Cüzdanla giriş, OKX OAuth ile bağlanma (ATK destekliyor), kendi cüzdanından kendi kontratını kurma, TEE'deki emir gönderici. Bizim sunucumuz hiçbir zaman başkasının anahtarını tutmayacak.

**S: Türkçe kural yanlış çevrilirse?**
C: Kod aralıkları ve tavanları kontrol eder. Önizlemede "senin cümlen → alan → değer" eşlemesi gösterilir, sahip onaylar. Kontrat da tavanları (1.000 TL / 500 TL) her durumda zorlar.

**S: Sahip notu kuralları aşabilir mi?**
C: Hayır. Not ajanın stratejisini değiştirebilir (örneğin düşen piyasada beklemek yerine almak), ama kurallar kontratta; kural dışı her istek reddedilir.

**S: Neden Fuji, neden mainnet değil?**
C: Hackathon süresinde güvenli test için. Kontrat aynı. Mainnet tek bir insan komutu (`pnpm chain:mainnet`), terminalde `MAINNET` yazarak.

**S: ERC-8004 ne işe yarıyor?**
C: Ajanın zincirdeki kimliği. Başka ajanlar ve platformlar VEKİL'i tanır; ileride itibar ve doğrulama sistemlerine bağlanır. Kontrat da bu kimliğe bağlı.

**S: VEKİL Guard ne?**
C: Kontratın kural motoru, başka ajanlar için bir soru hattı: "Bu emri gönderebilir miyim?" Simülasyondur; işlem göndermez, anahtar istemez. OKX.AI'da listelenebilir.

**S: Bu bot OKX'in kendi araçlarından ne farkı var?**
C: OKX ATK'yı kullanıyoruz ve üstüne bir **güven katmanı** koyuyoruz: kurallar zincirde, işlem anahtarı izole, her emir denetlenebilir. OKX Agentic Wallet gibi ürünlerden farkı: CEX hesabında, zincirdeki kurallarla otonom çalışması.

**S: Neden AVAX-TRY?**
C: Hackathon OKX TR ve Avalanche ortaklığında; TL ile Türkiye'deki kullanıcıya hitap ediyor. Kurallar başka pariteleri de destekliyor (en fazla 8 parite).

**S: Testlerde en çok neyi yakaladınız?**
C: Kontrattaki taşma hatası (10.000 TL'lik kandırma emri kontratı çökertecekti); sayıların kayan nokta hatası (decimal.js ile çözüldü); hash eşitliği (bağımsız vektörlerle kilitlendi).

**S: Bugün hangi sorunları yaşadınız?**
C:
- Avalanche'ın varsayılan RPC'si bizi hız sınırına takıp engelledi (Cloudflare 1015) → başka bir RPC (publicnode) ve toplu okuma (Multicall3).
- Bazı RPC'ler saçma gaz tahmini döndürdü → sabit gazla tekrar deneme.
- Canlı klasörde yönetim script'leri ayarları yanlış okuyordu → düzeltildi ve test eklendi.
- Ajan düşen trendde sahip notuna rağmen bekliyordu → sahip notunun stratejiden önce geldiği açıkça yazıldı.
- Borsanın en küçük emir tutarı ve TL bakiye konuları.

---

## 13. Sözlük

| Terim | Anlamı |
|---|---|
| **Akıllı kontrat** | Blok zincirde çalışan, kimsenin değiştiremeyeceği program |
| **Avalanche C-Chain** | Avalanche'ın Ethereum uyumlu zinciri; Fuji onun test ağı |
| **Hızlı kesinlik (finality)** | İşlemin geri dönülmez şekilde onaylanması; Avalanche'ta ~1–3 sn |
| **Agent Trade Kit (ATK)** | OKX'in yapay zekâ ajanları için resmî araç seti |
| **MCP** | Model Context Protocol; yapay zekânın araçlara bağlanma standardı |
| **LLM** | Büyük dil modeli (burada Claude) |
| **Prompt injection** | Veri içine gizlenmiş kötü niyetli talimat |
| **Hash** | Verinin parmak izi; veri değişirse hash değişir |
| **Merkle kökü** | Birçok kaydın tek bir hash'e indirgenmiş özeti |
| **eth_call / simülasyon** | Kontratı işlem göndermeden "deneme" çağrısı |
| **IOC emir** | Hemen dolmayan kısmı iptal olan limit emir |
| **clOrdId** | Borsadaki emrin bizim verdiğimiz kimliği |
| **Zarar-kes / kâr-al** | Belirli fiyatta otomatik satış (zararı ya da kârı sınırlamak için) |
| **Fren (pause)** | Kontratın tüm yeni onayları durdurması |
| **TEE** | Güvenli donanım alanı; içinde çalışan kodun değiştirilmediğini kanıtlar |
| **ERC-8004** | Yapay zekâ ajanları için zincir üstü kimlik standardı |
| **Paper (kâğıt) mod** | Gerçek fiyatlarla, sahte bakiyeyle deneme |
| **Fuzz / invariant testi** | Rastgele girdilerle kontratı zorlayan ve her durumda bozulmaması gereken kuralları kontrol eden testler |
| **bps** | Baz puan; %0,01 (22 bps = %0,22) |
