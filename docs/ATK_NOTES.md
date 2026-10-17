# ATK notes: verified facts only

Track B owns this file. Every line has a source: an `okx-readonly` MCP tool output (marked **MCP**, 17 Oct 2026 ~06:45Z), a public REST GET against `https://tr.okx.com` (marked **TR-REST**, no auth), or a file:line in `refs/agent-trade-kit` (marked **src**, paths relative to `refs/agent-trade-kit/packages/`). Unknowns say UNKNOWN and how we handle them. No balances or account data appear here.

> **Discovery status.** `~/.okx/config.toml` did not exist yet at discovery time (MCP `system_get_capabilities` → `hasAuth: false`; `spot` and `account` → `requires_auth / AUTH_MISSING`). Everything public (market, instruments, read-only filtering, tool names and params from source) is verified. Items that need a key (balances, fee tier, key permissions, demo trading, news, private order shapes) are **UNKNOWN — re-run `pnpm atk:probe` once the human has created the `tr-read` profile**.

## 0. Versions (SPEC §25.14)

- Global `@okx_ai/okx-trade-mcp` (the one `.mcp.json` spawns): **1.4.8** (global `package.json`); MCP `system_get_capabilities` → `server.version: "1.4.8"`.
- Local pin in `package.json`: **1.4.8** (`node_modules/@okx_ai/okx-trade-mcp/package.json`). Matches.
- Bin entry: `"bin": { "okx-trade-mcp": "dist/index.js" }`. Spawn as `process.execPath <pkgdir>/dist/index.js` (SPEC §26).
- `refs/agent-trade-kit`: tag **v1.4.8**, commit `343e3ffbc5338cd48ba72fab5be346f637e5f255`. Matches the pin.

## 1. Capabilities (SPEC §25.3)

`system_get_capabilities` for the read instance (`--profile tr-read --modules market,account,spot --read-only`), **without a config file** (MCP):

```json
{ "readOnly": true, "hasAuth": false, "demo": false,
  "moduleAvailability": { "market": {"status":"enabled"},
    "spot": {"status":"requires_auth","reasonCode":"AUTH_MISSING"},
    "account": {"status":"requires_auth","reasonCode":"AUTH_MISSING"},
    "swap|futures|option|event|news|smartmoney|earn.*|bot.*|skills": {"status":"disabled","reasonCode":"MODULE_FILTERED"} } }
```

- "read-only / write disabled": `capabilities.readOnly` (boolean). src `mcp/src/server.ts:84` (`readOnly: config.readOnly`).
- "demo": `capabilities.demo` (boolean).
- Modules: `capabilities.moduleAvailability` (`enabled` | `disabled` | `requires_auth`). A module we asked for is `enabled` (market always; others only with auth). src `mcp/src/server.ts:57-90`.
- The same `capabilities` object is attached to **every** tool result and error (src `server.ts` `successResult`/`errorResult`), so any call can re-assert read-only.
- **`--read-only` HIDES write tools from `listTools`.** src `core/src/tools/index.ts:55-61`: `buildTools()` returns `tools.filter(t => !t.isWrite)` when `readOnly`. Calling a hidden name returns `isError` with `code: "TOOL_NOT_AVAILABLE"` (src `server.ts` `unknownToolResult`). → SC3 can check both the capabilities field and the name pattern.
- Trade instance (`--modules market,spot`, no `--read-only`), read from source, **not** started: all `market` tools below plus every `spot` tool, i.e. adds the write tools `spot_place_order`, `spot_cancel_order`, `spot_amend_order`, `spot_batch_orders`, `spot_batch_amend`, `spot_batch_cancel`, `spot_place_algo_order`, `spot_amend_algo_order`, `spot_cancel_algo_order`, **`spot_set_leverage`** (margin). No withdraw/transfer tool exists in `market` or `spot` (`account_transfer` is in `account`). The executor's `AtkClient` must still allowlist calls (`executorTrade`), because `spot_set_leverage`/`spot_batch_orders` are exposed.

### Tools per module (src `core/src/tools/*.ts`, `isWrite` in brackets)

- **market** (all read): `market_get_ticker`, `market_get_tickers`, `market_get_orderbook`, `market_get_candles`, `market_get_instruments`, `market_get_instruments_by_category`, `market_get_trades`, `market_get_funding_rate`, `market_get_mark_price`, `market_get_index_ticker`, `market_get_index_candles`, `market_get_price_limit`, `market_get_open_interest`, `market_get_stock_tokens`, `market_get_indicator`, `market_list_indicators` (indicator.ts), `market_filter`, `market_filter_oi_change`, `market_get_oi_history`, `market_get_pair_spread` (market-filter.ts).
- **spot** read: `spot_get_order`, `spot_get_orders`, `spot_get_fills`, `spot_get_algo_orders`. Write: listed above.
- **account** read: `account_get_balance`, `account_get_asset_balance`, `account_get_balance_all`, `account_get_bills`, `account_get_bills_archive`, `account_get_config`, `account_get_max_size`, `account_get_max_avail_size`, `account_get_max_withdrawal`, `account_get_positions`, `account_get_positions_history`, `account_get_trade_fee`, **`trade_get_history`** (audit.ts: reads the local `~/.okx/logs` files, not the exchange; never allowlisted). Write: `account_transfer`, `account_set_position_mode`.
- Plus `system_get_capabilities` (meta, always listed).
- The read-only instance's `listTools` (MCP tool list in this session) equals exactly the read entries above. Note `account_get_max_withdrawal` does **not** match the SC3 write pattern (`withdraw` must be followed by `[_.-]` or end).

## 2. Tool names and parameters (SPEC §25.1)

Every result is `content[0].text` = JSON `{ tool, ok: true, data: { endpoint, requestTime, data: <OKX data array> }, capabilities, timestamp }`. Errors: `isError: true`, text JSON `{ tool, error: true, type, code, message, suggestion?, endpoint?, traceId?, capabilities }` (src `server.ts` `successResult`/`errorResult`, `core/src/utils/errors.ts:115`).

| Purpose | Tool name | Key params | Response fields we use | Source |
|---|---|---|---|---|
| ticker | `market_get_ticker` | `instId` | `bidPx, askPx, last, bidSz, askSz, ts` (strings) | MCP; src `core/src/tools/market.ts:18` |
| order book | `market_get_orderbook` | `instId`, `sz` (depth/side, default 1, max 400) | `bids`/`asks`: `[px, sz, "0", nOrders]`, `ts` | MCP; market.ts:88 |
| candles | `market_get_candles` | `instId`, `bar` (`5m`,`15m`,`1H`…), `limit` (default 100) | arrays `[ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]`, **newest first**, `confirm "0"` = open candle | MCP; market.ts:124 |
| recent trades | `market_get_trades` | `instId`, `limit` (default 20, max 500) | `px, sz, side, ts` | MCP; market.ts:353 |
| instruments | `market_get_instruments` | `instType: "SPOT"`, `instId` | `tickSz, lotSz, minSz, state, baseCcy, quoteCcy` | MCP; market.ts:194 |
| balance | `account_get_balance` | `ccy?` | `details[].ccy, availBal` (OKX v5) — **shape UNKNOWN until auth** | src account.ts:17 |
| account config / perms | `account_get_config` | — | `perm` expected (OKX v5 `/account/config`) — **UNKNOWN until auth** | src account.ts:385 |
| trade fee | `account_get_trade_fee` | `instType: "SPOT"`, `instId?` | `taker, maker` — **UNKNOWN until auth** | src account.ts:351 |
| spot place order | `spot_place_order` | `instId, tdMode, side, ordType, sz` (required), `px, clOrdId, tgtCcy` | `data[0]: ordId, clOrdId, sCode, sMsg` | src spot-trade.ts:30-124 |
| spot cancel order | `spot_cancel_order` | `instId`, `ordId` or `clOrdId` | `data[0]: sCode, sMsg` | src spot-trade.ts:127 |
| spot get order | `spot_get_order` | `instId`, `ordId` or `clOrdId` | `state, accFillSz, avgPx, fee, feeCcy, cTime, px, sz, side, ordId, clOrdId` | src spot-trade.ts:711 |
| spot open orders | `spot_get_orders` | `status: "open"` (default), `instId` | as get order | src spot-trade.ts:218 (`/trade/orders-pending`) |
| **spot order history** (auditor) | `spot_get_orders` | `status: "history"` (7 d) or `"archive"` (3 mo), `instId`, `begin`/`end` (ms strings), `limit` (default 100) | as get order | src spot-trade.ts:218-290 |
| spot algo (S8) | `spot_place_algo_order` / `spot_get_algo_orders` / `spot_cancel_algo_order` | (not used for M1) | | src spot-trade.ts:293-580 |
| news | `news` module tools | private GETs (`/api/v5/orbit/*`) | — **UNKNOWN on TR; not allowlisted** | src tools/news.ts:6-11,110 |

## 3. Order details (SPEC §25.2)

- `clOrdId` accepted by spot place: **YES**, "Client order ID (max 32 chars)" (src spot-trade.ts:70). Our ids are 31 chars `[vx][0-9a-f]{30}` (OKX: alphanumeric, starts with a letter). Get/cancel by `clOrdId` also supported.
- `ordType`: `market | limit | post_only | fok | ioc` (src spot-trade.ts:55). We use `ioc` (buys, needs `px`) and `market` (sells).
- `tdMode`: **required** by the tool (`required: [instId, tdMode, side, ordType, sz]`), enum `cash|cross|isolated`. We always send `"cash"`.
- `sz` unit: "Buy market: quote amount, all others: base amount"; `tgtCcy` `base_ccy|quote_ccy` (src spot-trade.ts:59-66). **Market sell `sz` is base** (what we send); we never send market buys.
- The handler adds `tag: "MCP"` to every order (src spot-trade.ts:115, `constants.ts` `DEFAULT_SOURCE_TAG`).
- Error format: HTTP/top-level OKX `code` other than `"0"`/`"1"` → tool `isError` with `code`/`message`. **`code "1"` (per-order failure) is NOT an error at the tool level** (src `core/src/client/rest-client.ts:235,400`): the result is `ok: true` and the failure is only in `data.data[0].sCode != "0"` / `sMsg`. `AtkExchange` must check `sCode`.
- `avgPx` when unfilled: `""` per OKX v5 (SPEC §26) — **not verified on TR yet (needs auth)**; parser maps `""` → `null`. Fee sign: negative per OKX v5 — parser takes `|fee|`.
- Rate limits in ATK: `spot_place_order`/`spot_cancel_order`/`spot_get_order` 60 rps token bucket, `spot_get_orders` 20 rps (src spot-trade.ts `privateRateLimit`, `tools/common.ts:23`).

## 4. Instruments on OKX TR (SPEC §25.4–5)

MCP `market_get_instruments` and TR-REST `GET https://tr.okx.com/api/v5/public/instruments?instType=SPOT&instId=…` return identical objects.

| instId | tickSz | lotSz | minSz | state | ≤ 8 decimals? | other |
|---|---|---|---|---|---|---|
| AVAX-TRY | 0.1 | 0.00001 | 0.1 | live | yes | `maxMktAmt 6200`, `maxPxLmtPct 0.05` |
| DOGE-TRY | 0.001 | 0.001 | 10 | live | yes | `maxMktAmt 5200` |
| BTC-TRY | 1 | **0.000000001** | 0.0001 | live | **NO: lotSz has 9 dp** | context only (never ordered) |

- **`<R1_PAIR>` = `DOGE-TRY`** (listed and live on TR; a believable foreign instrument for the R1 red-team order).
- Fee rate and buy-fee currency: **UNKNOWN until auth** (`account_get_trade_fee`). Keep `FEE_RATE=0.002`; buy fee assumed in base (OKX v5 convention, SPEC §26).
- Top of book at discovery (MCP ticker, 06:44Z): bid 494.1 / ask 494.7 → spread ≈ 0.12 %. Book depth ~100–500 AVAX at the top levels.
- **Liquidity is thin:** the last two AVAX-TRY trades were ~1 h apart and the latest 15m candles have volume 0. Candles with no trades repeat the previous close.

## 5. Site and modes (SPEC §25.6–7)

- Sites: `tr → https://tr.okx.com` (src `core/src/constants.ts:34-37`). Resolution: `--site` > `OKX_SITE` > toml profile `site` > OAuth site > `"global"` (src `core/src/config.ts:129-170`). **Without a profile the server talks to `www.okx.com`**; public AVAX-TRY data there is identical to tr.okx.com. Our `AtkClient` passes `--site tr` explicitly so a profile typo can't silently route elsewhere.
- Demo on TR: **UNKNOWN (needs auth)**. Evidence so far: a public demo ticker (`x-simulated-trading: 1`) for AVAX-TRY on tr.okx.com returns `askPx ""`, `bidPx ""`, volume 0, stale `last` 595.2 → even if demo orders work, the demo AVAX-TRY book is empty. Treat demo as **NOT USABLE** for the demo flow; paper is the rehearsal mode.
- News on TR: **UNKNOWN** (private endpoints; needs auth). Not in `ATK_READ_MODULES`; not allowlisted.
- Rate limits noticed: none hit (a handful of calls).
- Empty book fields are strings `""`: snapshot parsing must reject them (→ `MARKET_DATA_MISSING`), never coerce to 0.

### Lock (SC4)

`pnpm atk:lock` (17 Oct, read-only instance via `AtkClient` + stdio spawner, `--site tr`, `hasAuth: false`): 38 tools, no write-pattern names, `manifestHash 0xee0ce2924337cfad58e2d1a8f65e53ec3b95a5c7c4af037763da2a2c450dffe0` → `atk-manifest.lock.json`. Auth does not change the list (src `core/src/tools/index.ts:55`), so the lock stays valid once the profile exists; re-run `pnpm atk:probe` to confirm.

## 6. Allowlist decision (`config/atk-allowlist.json`)

- `llm`: `market_get_ticker`, `market_get_orderbook`, `market_get_candles`, `market_get_trades` (news only after §25.7 is verified).
- `core`: `system_get_capabilities`, `market_get_instruments`, `market_get_ticker`, `market_get_orderbook`, `market_get_candles`, `market_get_trades`, `account_get_balance`, `account_get_trade_fee`, `account_get_config`, `spot_get_order`, `spot_get_orders` (auditor history: `status: "history"`).
- `executorTrade` (live/demo trade instance, `market,spot`): `system_get_capabilities`, `market_get_ticker`, `market_get_instruments`, `spot_place_order`, `spot_cancel_order`, `spot_get_order`, `spot_get_orders`. Cancel-only client: `spot_cancel_order` only.
- Executor's separate read-only `account` instance (live): `account_get_balance` (+ `system_get_capabilities`).

## 7. ERC-8004 (SPEC §25.10)

Track C owns this section.

- Fuji Identity Registry address: `0x8004A818BFB912233c491871b3d84c89A494BD9e` (verify on Snowtrace)
- `register` signature(s):
- Event carrying `agentId`:
- Source of the ABI:

## 8. Surprises and gotchas

- `--read-only` hides write tools (good for SC3), and the `capabilities` object rides on every result.
- Per-order failures come back as `ok: true` with `sCode != "0"` (code "1" passthrough). Never treat `ok: true` as "placed".
- `spot_set_leverage` and `spot_batch_*` are exposed on the trade instance: the executor allowlist is the guard.
- `trade_get_history` reads local log files under `~/.okx/logs`: never call it.
- BTC-TRY `lotSz` has 9 decimals: `toScaled` would throw; BTC-TRY is context-only, so the market layer keeps its spec as strings and never scales it.
- Demo AVAX-TRY book is empty (`""` prices).
- No `~/.okx/config.toml` yet → `pnpm atk:probe` must be re-run after the human creates `tr-read` to fill §2 UNKNOWN shapes, the fee and the key permissions, and `pnpm atk:lock` must be run with the authenticated instance (the tool list does not change with auth, src `tools/index.ts:55` — only modules and `readOnly` filter it — so the lock written now stays valid).
- **UNVERIFIED:** how `spot_get_order` reports an order that does not exist. `AtkExchange` maps OKX code `51603` ("Order does not exist", OKX v5 docs) or a "does not exist / not found" message to "not found". Verify with the authenticated `okx-readonly` MCP (`spot_get_order` with a random `clOrdId`) and record the exact envelope here. Until then an unrecognised error counts as "unknown": entries are refused (`ALREADY_EXECUTED`, fail closed) and an unknown exit is released after 12 background polls (~60 s) so it can be retried; a retried sell is bounded by inventory and the account's base balance.

