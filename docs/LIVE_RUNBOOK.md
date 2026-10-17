# Canlı işlem (Bonus 1): adım adım

Bu adımları **sen, kendi terminalinde** çalıştırırsın. Claude Code `../vekil-live` klasörüne hiç girmez ve `pnpm live` / `pnpm resume` komutlarını çalıştırmaz (CLAUDE.md, kural 6 ve 11).

## 0. Önce kontrol et

- [ ] OKX TR'de **işlem anahtarı** var: okuma + işlem yetkili, **para çekme yetkisi YOK**. OKX TR'nin API sayfasında kendi gözünle kontrol et.
- [ ] `~/.okx/config.toml` içinde `tr-trade` profili bu anahtarla tanımlı ve `site = "tr"`.
- [ ] OKX TR hesabında yalnızca kaybetmeyi göze aldığın kadar TRY var. 100–200 TL yeterli.
- [ ] **Canlı** cüzdanlar (OWNER-live, AGENT-live) dev cüzdanlardan farklı ve ikisinde de Fuji AVAX var (en az 0,05).
- [ ] Dev panelindeki kâğıt işlem koşusunu (`pnpm dev`) Ctrl+C ile durdur.

## 1. Canlı klasörü oluştur

Ana klasörde (`~/vekil`), commit edilmiş son hâlden:

```bash
git worktree add --detach ../vekil-live claude/intelligent-lamport-lcmrjk
```

```bash
cd ../vekil-live
```

```bash
pnpm i
```

## 2. Canlı `.env`

`../vekil-live/.env` dosyasını sen oluştur. Dev `.env` dosyasını kopyalayıp şu satırları değiştirmen yeterli:

```
EXECUTION_MODE=live
CHAIN=fuji
LLM_PROVIDER=anthropic
PORT=8787
EXECUTOR_PORT=8789
FUJI_RPC_URL=https://avalanche-fuji-c-chain-rpc.publicnode.com
ATK_TRADE_PROFILE=tr-trade
FEE_RATE=0.0022
AGENT_PRIVATE_KEY=<AGENT-live anahtarı>
OWNER_PRIVATE_KEY=<OWNER-live anahtarı>
I_CONFIRM_NO_WITHDRAW=yes
LLM_MODEL=claude-sonnet-5-5
```

`I_CONFIRM_NO_WITHDRAW=yes` satırını **sadece** 0. adımda para çekme yetkisinin kapalı olduğunu gördüysen yaz. Bu satır yoksa başlangıç kontrolü SC6 geçmez ve vekil karar vermez.

## 3. Canlı kontratı kur ve kuralları ayarla

Her komut Fuji'ye işlem gönderir ve senden `y` ister.

```bash
pnpm chain:fuji
```

```bash
pnpm policy:set --maxOrderQuote 75 --maxHoldMin 20 --maxTradesPerHour 3 --feeBps 22
```

- **75 TL:** AVAX-TRY'nin borsa alt sınırı nedeniyle 45 TL'lik emir `ORDER_BELOW_MIN_SIZE` aldı. 60 TL'nin üstü güvenli.
- **20 dakika:** pozisyon en geç 20 dakikada süre dolunca kendiliğinden kapanır.
- **22 bps:** OKX TR'de doğrulanan gerçek alıcı komisyonu.

## 4. Başlat

```bash
pnpm live
```

`CANLI` yaz. Başlangıç kontrollerinin hepsi yeşil olmalı (SC6 "Para çekme yetkisi yok" dahil). Panel: http://127.0.0.1:8787

## 5. İşlem

1. İstersen panelde Türkçe kurallarını yaz → "Yapay zekâ ile dönüştür" → "Onayla ve zincire yaz".
2. Sahip notu: `Kurallar içinde minimum tutarda bir alım değerlendir.` → "Sahip notu gönder" → "Şimdi düşün".
3. Akışta **ONAYLANDI** (Snowtrace linki) → **GERÇEKLEŞTİ** (OKX TR'de dolum) görünmeli. OKX TR'de emir geçmişinde `clOrdId` `v` ile başlar.
4. Çıkış: zarar-kes, kâr-al ya da en geç 20 dakikada süre dolunca kendiliğinden olur. İstersen önce "Pozisyonu kapat"a bas. Ardından akışta "Çıkış zincirde kayıtlı" satırı çıkar.

## 6. Kanıt

Canlı klasörde (`../vekil-live`):

```bash
pnpm audit:orders
```

```bash
pnpm verify
```

İkisi de yeşil olmalı. Bana yapıştır:
- ONAYLANDI tx linki
- OKX `clOrdId`
- ExitRecorded tx linki
- `audit:orders` çıktısı

README'deki "Live OKX TR trade" satırını bunlarla dolduracağım. Sonra Ctrl+C ile durdurabilirsin.

## Bir şey ters giderse

- **DURDUR** düğmesi ya da başka bir terminalde `pnpm kill`: yeni emir girişi durur, açık emirler iptal edilir.
- **Kontrat freni çekildiyse devam:** `pnpm owner:pause --unpause` → Ctrl+C → `pnpm resume` (`DEVAM` yaz) → `pnpm live`.
- **"Emir durumu bilinmiyor" uyarısı:** emri doğrudan OKX TR'de kontrol et. Vekil çift satış yapmamak için bekler.
