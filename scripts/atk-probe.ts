// pnpm atk:probe [--write-lock]
// Starts ONLY the read-only instance (--profile $ATK_READ_PROFILE --modules $ATK_READ_MODULES --read-only --site tr),
// prints version, capabilities, tools and sample shapes for ATK_NOTES, and with --write-lock writes atk-manifest.lock.json.
// Balances and account data are redacted: only field names and currency codes are printed.
// It does not load .env; override with ATK_READ_PROFILE / ATK_READ_MODULES on the command line.
import { writeFileSync } from "node:fs";
import { AtkClient, stdioSpawner } from "../src/atk/client.js";
import { buildLock, isWriteToolName } from "../src/atk/manifest.js";
import { AtkToolError } from "../src/atk/parse.js";

const PROBE_INSTRUMENTS = ["AVAX-TRY", "DOGE-TRY", "BTC-TRY"];
const LOCK_PATH = "atk-manifest.lock.json";

function keysOf(x: unknown): string[] {
  return x && typeof x === "object" && !Array.isArray(x) ? Object.keys(x).sort() : [];
}
function firstRow(data: unknown): unknown {
  return Array.isArray(data) ? data[0] : data;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const writeLock = argv.includes("--write-lock");
  const profile = process.env.ATK_READ_PROFILE || "tr-read";
  const modules = (process.env.ATK_READ_MODULES || "market,account,spot").split(",").map((s) => s.trim()).filter(Boolean);

  const allow = [
    "market_get_instruments",
    "market_get_ticker",
    "account_get_balance",
    "account_get_trade_fee",
    "account_get_config",
    "spot_get_orders",
  ];
  const atk = await AtkClient.start({ profile, modules, readOnly: true, allow }, { spawner: stdioSpawner, mode: "paper" });
  try {
    const tools = await atk.listTools();
    console.log(`okx-trade-mcp ${atk.version ?? "?"}  profile=${profile}  modules=${modules.join(",")}`);
    console.log("capabilities:", JSON.stringify(atk.capabilities));
    console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(", "));
    const writes = tools.filter((t) => isWriteToolName(t.name)).map((t) => t.name);
    console.log("write-pattern tools listed:", writes.length === 0 ? "none" : writes.join(", "));

    for (const instId of PROBE_INSTRUMENTS) {
      try {
        const spec = firstRow(await atk.callData("market_get_instruments", { instType: "SPOT", instId })) as Record<string, unknown> | undefined;
        const t = firstRow(await atk.callData("market_get_ticker", { instId })) as Record<string, unknown> | undefined;
        console.log(
          `${instId}: tickSz=${String(spec?.tickSz)} lotSz=${String(spec?.lotSz)} minSz=${String(spec?.minSz)} state=${String(spec?.state)}` +
            `  bid=${String(t?.bidPx)} ask=${String(t?.askPx)} last=${String(t?.last)}`,
        );
      } catch (e) {
        console.log(`${instId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (atk.capabilities.hasAuth) {
      const probes: [string, Record<string, unknown>][] = [
        ["account_get_balance", {}],
        ["account_get_config", {}],
        ["account_get_trade_fee", { instType: "SPOT", instId: "AVAX-TRY" }],
        ["spot_get_orders", { status: "history", instId: "AVAX-TRY", limit: 1 }],
      ];
      for (const [name, args] of probes) {
        try {
          const row = firstRow(await atk.callData(name, args));
          const out: Record<string, unknown> = { fields: keysOf(row) };
          if (name === "account_get_balance") {
            const details = (row as { details?: { ccy?: unknown }[] } | undefined)?.details;
            out.currencies = Array.isArray(details) ? details.map((d) => d.ccy) : [];
            out.detailFields = Array.isArray(details) ? keysOf(details[0]) : [];
          }
          if (name === "account_get_config") out.perm = (row as { perm?: unknown } | undefined)?.perm ?? null;
          if (name === "account_get_trade_fee") {
            const r = row as { taker?: unknown; maker?: unknown } | undefined;
            out.taker = r?.taker ?? null;
            out.maker = r?.maker ?? null;
          }
          console.log(`${name}:`, JSON.stringify(out));
        } catch (e) {
          console.log(`${name}: ${e instanceof AtkToolError ? e.message : String(e)}`);
        }
      }
    } else {
      console.log("hasAuth=false: account/spot probes skipped (create the profile in ~/.okx/config.toml, then re-run).");
    }

    if (writeLock) {
      const lock = buildLock(atk.version ?? "unknown", modules, tools);
      writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + "\n");
      console.log(`wrote ${LOCK_PATH}: ${lock.tools.length} tools, manifestHash ${lock.manifestHash}`);
    }
  } finally {
    await atk.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
