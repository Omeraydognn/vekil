# VEKİL — jüri kriterlerine göre yapılacaklar (17 Eki)

Kaynak: organizatörlerin kriter tablosu (aşağıda) + topluluk rehberi (agentic-hackathon-tr.vercel.app; resmi değil). Ağırlıklar tabloda yazdığı gibi. Her satırda: **elimizde ne var**, **eksik**, **yapılacak**. Öncelik: ⭐ = puan/emek oranı en yüksek.

| Kriter | Ağırlık | Alt kriterler |
|---|---|---|
| Agentic Design | 20% | Otonomi: uçtan uca, adım adım yönlendirme olmadan (10) · Akıl yürütme ve araç kullanımı: çok adımlı plan, doğru araç/API seçimi (10) |
| Technical Execution | 15% | Çalışan, deploy edilmiş ürün (5) · Mimari kalitesi (5) · Teknik zorluk (5) |
| Avalanche Integration | 10% | C-Chain'e veya bir L1'e deploy (5) · Avalanche'ın güçlü yanlarını kullanma: hızlı kesinlik, özel L1, ICM (5) |
| OKX Integration | 10% | OKX ajan araçları: OnchainOS, Agent Trade Kit, Wallet/DEX API (5) · OKX.AI'da servis olarak listelenebilir (5) |
| Innovation & Real-World Value | 25% | Özgünlük (10) · Net problem ve hedef kullanıcı (5) · Pazar potansiyeli / iş modeli (5) · Pazara hazır (5) |
| Demo & Presentation | 20% | Çalışan canlı demo (5) · UX tasarımı (5) · Sunum ve soru-cevap (10) |

---

## 1. Agentic Design (20%)

**Var:** Ajan kendi kontrol zamanını seçiyor (`nextCheckInMin`, scheduler), her döngüde birden fazla aracı sırayla çağırıyor (`get_agent_state` → `get_indicators` → `get_market_context` → ATK `market_*` → `submit_decision`), rejim/oyun planı/kanıt/senaryo/ders üretiyor, son reddi okuyup uyum sağlıyor. `probe:agent` gerçek veriyle 4 araç çağrısı + HOLD üretti.

**Risk:** Ücretsiz model (OpenRouter) yoğun/boş yanıt veriyor → otonomi demoda kesilirse bu kriter düşer.

**Yapılacak:**
- ⭐ Demo için güvenilir model: 5 $ Anthropic kredisi (`LLM_PROVIDER=anthropic`) veya en azından çalıştığı kanıtlanmış ücretsiz model + yedek listesi. Prova sırasında 3 döngüyü kesintisiz göster.
- ⭐ Panelde "Akış" kartında araç izini (hangi aracı neden çağırdı) görünür tut; sunumda "kimse adım adım söylemiyor, kendi planlıyor" cümlesini bu ekranla göster.
- Otonom bir zinciri baştan sona göster: kendi kendine çalışan döngü → zincir onayı → emir gönderici → pozisyon → stop/TP/süre çıkışı → zincire çıkış kaydı. Hiçbir adımda insan yok (sahip notu opsiyonel).
- Ajanın Türkçe yazması: ücretsiz modeller İngilizce kaçırıyor; Anthropic veya Gemma ile Türkçe çıktı.

## 2. Technical Execution (15%)

**Var:** Kontrat (101 forge testi: fuzz + invariant), izole emir gönderici, Merkle kanıtı, denetçi, 339 TS testi, `pnpm smoke` gerçek kontratla 14/14.

**Eksik:** "Deploy edilmiş" ürün → şu an sadece yerelde. Kontrat henüz Fuji'de değil.

**Yapılacak:**
- ⭐ `pnpm chain:fuji` (dev) + canlı kontrat; adresleri ve Snowtrace linklerini README'ye koy.
- ⭐ README: güven katmanları diyagramı (SPEC §5), test sayıları, "nasıl doğrulanır" (`pnpm verify`, `pnpm audit:orders`).
- Panel yerel çalışıyor (güvenlik gereği 127.0.0.1). "Deploy" kanıtı olarak: zincirdeki kontrat + canlı işlem + kayıtlı video. (Paneli internete açmıyoruz; jüriye nedenini söyle: anahtar tutan süreç dışarı açılmaz.)
- Teknik zorluğu anlatırken 3 somut şey: uint256 taşma hatasının testle yakalanması, Merkle kanıtının zincirde doğrulanması, yeniden başlatmada çift satışı engelleyen kurtarma.

## 3. Avalanche Integration (10%)

**Var:** VekilPolicy Fuji C-Chain'e deploy edilecek; her emir zincirde onaylanıyor/reddediliyor; otomatik fren; Merkle çapaları; ERC-8004 kimliği planda (M15).

**Yapılacak:**
- ⭐ Fuji deploy + en az bir `OrderApproved`, bir `OrderRejected` + `Paused`, bir `PolicySet` (Türkçe metin event'te) Snowtrace linki.
- ⭐ "Hızlı kesinlik" kanıtı: onay turunun süresini ölç ve panelde göster (ör. "Zincir onayı 1,4 sn"). Sunumda: "Avalanche'ın alt-saniye kesinliği sayesinde her emir zincirde onaylanabiliyor; Ethereum'da bu 12+ sn olurdu."
- S4: Snowtrace'te kontrat kaynak doğrulaması (jüri kodu zincirde okuyabilsin).
- M15: `pnpm register-agent` (ERC-8004) — henüz yazılmadı; ABI doğrulanmalı. Zaman kalırsa.
- Mainnet (S5): organizatör isterse. Gaz ucuz; insan çalıştırır.
- Özel L1 / ICM: yapmıyoruz; "sonraki adım" olarak anlat: kural kontratları için ayrı bir L1, borsalar arası politika paylaşımı ICM ile.

## 4. OKX Integration (10%)

**Var (alt kriter 1 tam):** Agent Trade Kit gerçekten kullanılıyor: salt-okunur örnek (ajan + çekirdek + denetçi), işlem örneği sadece emir göndericide, iptal-yalnız istemci, araç kilidi (manifest hash), izin listesi. OKX TR üzerinde doğrulandı (`atk:probe`, `probe:market`).

**Eksik (alt kriter 2, 5 puan):** "OKX.AI'da servis olarak listelenebilir" — hiçbir şey yok.

**Yapılacak:**
- ⭐ **"VEKİL Guard" servisi:** kontratın kural motorunu bir servis olarak dışarı aç. Başka bir ajan "bu emri gönderebilir miyim?" diye sorar; servis `requestApproval`'ı `eth_call` ile **simüle eder** (kontrat hiç revert etmediği için reddi ve nedenleri döner), işlem göndermez, para/anahtar istemez. Ayrıca `audit` (bir clOrdId zincirde onaylı mı?) ve `proposePolicy` (Türkçe → kural önerisi). Bunu HTTP JSON + kısa bir servis tanımı (manifest) olarak yaz; OKX.AI'ya gerçekten kaydetmesek de "listelenmeye hazır" diye gösteririz. (Rehberdeki "ATK service recipe / A2MCP" fikri buna denk.)
- İsteğe bağlı: HTTP 402 ile "onay başına ücret" simülasyonu (rehberdeki 402 lab fikri) → iş modeli kriterine de yazar.

## 5. Innovation & Real-World Value (25%) — en büyük kalem

**Özgünlük (10):** "Kurallar CEX ajanının içinde değil, Avalanche'taki kontratta; ajan kandırılsa bile kontrat reddedip freni çekiyor" — güçlü. Bunu ilk 20 saniyede söyle.

**Net problem + hedef kullanıcı (5):**
- Problem: OKX TR API sözleşmesi sorumluluğu kullanıcıya yüklüyor (5.2, 6.2 risk kontrolü, 12.2 prompt-injection, 10.x denetim). Bugünkü çözüm: "anahtarı ver ve umut et".
- Kullanıcı: yapay zekâ ajanına küçük bir bütçeyle işlem yaptırmak isteyen bireysel yatırımcı ("ek kart" benzetmesi); ikinci segment: ajan geliştiren ekipler/kurumlar (uyum ve denetim izi).

**Pazar potansiyeli / iş modeli (5) — şu an eksik:**
- ⭐ README'ye ve sunuma kısa bir iş modeli: (a) bireysel: aylık abonelik veya onay başına küçük ücret (VEKİL Guard), (b) B2B: borsalar/ajan platformları için "politika katmanı" API'si, (c) OKX.AI üzerinde servis olarak listeleme (4. maddedeki servis). Pazar: CEX'lerde ajan erişimi açılıyor (OKX ATK, Binance Agent, Bitget, Coinbase Agentic Wallet) — hepsinin aynı güven sorunu var.

**Pazara hazır (5):**
- ⭐ README: 5 dakikada kurulum, `.env.example`, güvenlik notları, dürüst sınırlar (SPEC §24).
- Türkçe arayüz zaten var; ilk açılışta "nasıl başlarım" kartı eklemek iyi olur.
- Gerçek işlem (Bonus 1) "pazara hazır" iddiasını destekler.

## 6. Demo & Presentation (20%)

**Var:** Türkçe panel, DURDUR + süreleri, Kandırma testi kartı, Doğrula/Kanıtla, Denetçi, UI replay modu, SPEC §24'te 5 dakikalık akış ve soru-cevap hazırlığı.

**Yapılacak:**
- ⭐ Canlı demo güvenliği: LLM kesilirse demo durmasın → R1 kandırma testi LLM'siz çalışıyor; yedek video çek (2–3 dk); UI replay yedeği hazır (`UI_REPLAY=fixtures/ui-events.jsonl pnpm dev`).
- ⭐ İki tam prova, süre tutarak. Strateji anlatımı ≤ 10 sn.
- UX: panelde zincir onay süresi (Avalanche puanı), Snowtrace linkleri tıklanabilir, Türkçe metinler.
- Soru-cevap: SPEC §24 "Q&A prep" + dürüst sınırlar ezber.

---

## Öncelik sırası (kalan süre için)

1. Güvenilir LLM (Anthropic kredisi önerilir) → `probe:policy` + `probe:agent` yeşil.
2. `pnpm chain:fuji` + paper koşusu: Türkçe kural → `PolicySet`, 3 döngü, onay/ret Snowtrace linkleri.
3. Kandırma testi zincirde (R1 → ret + otomatik fren) — Snowtrace linki.
4. Gerçek işlem (Bonus 1, ~60 TL, insan).
5. README: problem, kullanıcı, iş modeli, mimari diyagram, kanıt linkleri, dürüst sınırlar.
6. VEKİL Guard servisi (OKX.AI listelenebilir) — `eth_call` simülasyonu + manifest.
7. Panelde zincir onay süresi; Snowtrace kaynak doğrulama (S4).
8. ERC-8004 kaydı (M15), zaman kalırsa.
9. Yedek video + iki prova.
