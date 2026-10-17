# ATK notes: verified facts only

Fill this file in during M0 by discovery: the `okx-readonly` MCP server, `pnpm atk:probe` and the source in `refs/agent-trade-kit/`. After M0, Track B owns it. Every line needs a source (the tool output, or a file and line in refs). If something is unknown, write "UNKNOWN" and how we handle it. Redact balances and anything account-specific.

## 0. Versions (SPEC §25.14)

- `@okx_ai/okx-trade-mcp` version, global (Claude Code MCP): …
- `@okx_ai/okx-trade-mcp` version, local pin (package.json): …
- Bin entry file (from the package's `package.json` `bin`): …
- Tag and commit in `refs/agent-trade-kit`, and whether they match the pinned version: …

## 1. Capabilities (SPEC §25.3)

- `system_get_capabilities` for the read instance (`--profile tr-read --modules $ATK_READ_MODULES --read-only`, default `market,account,spot`). Paste the JSON:
- Field that means "read-only / write disabled": …
- Field that means "demo": …
- Field that lists the modules: …
- Does `--read-only` **hide** write tools from `listTools`, or list them and refuse at call time? (SC3 depends on this.)
- Tools exposed by `--modules market,spot` without `--read-only` (the executor's trade instance; read from the source, **not** by starting it): …

## 2. Tool names and parameters (SPEC §25.1)

| Purpose | Tool name | Key params | Response fields we use | Source |
|---|---|---|---|---|
| ticker (bid/ask/last) | | | | |
| order book | | `sz` / depth | bids, asks | |
| candles | | `bar`, `limit` | ts, o, h, l, c, vol, confirm | |
| recent trades | | `limit` | px, sz, side, ts | |
| instruments (SPOT) | | `instType=SPOT`, `instId` | tickSz, lotSz, minSz, state, baseCcy, quoteCcy | |
| balance | | `ccy` | availBal | |
| account config / key permissions | | | perm? | |
| trade fee | | `instType=SPOT`, `instId` | taker, maker | |
| spot place order | | instId, side, ordType, px, sz, clOrdId?, tdMode?, tgtCcy? | ordId, clOrdId, sCode, sMsg | |
| spot cancel order | | instId, clOrdId or ordId | | |
| spot get order | | instId, clOrdId or ordId | state, accFillSz, avgPx, fee, feeCcy, cTime, px, sz, side | |
| spot open orders | | instId | | |
| **spot order history** (auditor) | | instId, begin/end or limit | clOrdId, side, px, sz, state, cTime | |
| spot algo / conditional (S8) | | | | |
| news (if usable on TR) | | | | |

## 3. Order details (SPEC §25.2)

- `clOrdId` accepted by spot place? YES / NO. Max length; allowed characters. Source:
- `ordType` values supported (`ioc`? `market`?):
- `tdMode=cash` required or defaulted?
- Market sell `sz` unit (base by default?), and `tgtCcy` support:
- Error format (`sCode` / `sMsg`?):
- `avgPx` when nothing filled (`""`?), and the sign of `fee`:

## 4. Instruments on OKX TR (SPEC §25.4–5)

| instId | tickSz | lotSz | minSz | state | ≤ 8 decimals? |
|---|---|---|---|---|---|
| AVAX-TRY | | | | | |
| DOGE-TRY (red-team realism) | | | | | |
| BTC-TRY (market context) | | | | | |

- Fee rate (taker/maker) and fee currency on buys:
- Top of book at discovery time (bid/ask/spread%):

## 5. Site and modes (SPEC §25.6–7)

- How `site = "tr"` is handled (base URL, file:line):
- Demo trading on TR: SUPPORTED / NOT SUPPORTED / UNKNOWN. Evidence:
- Is the news module usable on TR?
- Rate limits we noticed:

## 6. Allowlist decision (fills `config/atk-allowlist.json`)

- `llm` (agent): ticker, book, candles, trades (+ news if verified): …
- `core` (snapshots, specs, balances, auditor order history): …
- Executor trade instance (`market,spot`): place, cancel, get order, open orders, ticker: …

## 7. ERC-8004 (SPEC §25.10), verified ABI

- Fuji Identity Registry address: `0x8004A818BFB912233c491871b3d84c89A494BD9e` (verify on Snowtrace)
- `register` signature(s):
- Event carrying `agentId`:
- Source of the ABI (verified contract / repo + commit):

## 8. Surprises and gotchas

- …
