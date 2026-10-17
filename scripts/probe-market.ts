// pnpm probe:market [instId]
// Read-only: starts the core read instance (--read-only --site tr) and prints the spec, snapshot, recent candles,
// order-book imbalance (top 20) and trade flow (last 200 trades). No account data. Does not load .env.
import { AtkClient, stdioSpawner } from "../src/atk/client.js";
import { readAllowlist } from "../src/atk/manifest.js";
import { AtkMarket } from "../src/market/atk-market.js";
import { D, toDecString } from "../src/shared/money.js";
import { SystemClock } from "../src/shared/time.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const instId = argv[0] ?? process.env.INST_ID ?? "AVAX-TRY";
  const profile = process.env.ATK_READ_PROFILE || "tr-read";
  const modules = (process.env.ATK_READ_MODULES || "market,account,spot").split(",").map((s) => s.trim()).filter(Boolean);
  const allow = readAllowlist("config/atk-allowlist.json").core.filter((n) => n.startsWith("market_"));

  const atk = await AtkClient.start({ profile, modules, readOnly: true, allow }, { spawner: stdioSpawner, mode: "paper" });
  try {
    const m = new AtkMarket(atk, new SystemClock());
    const spec = await m.getInstrument(instId);
    console.log("spec:", JSON.stringify(spec));
    const s = await m.getSnapshot(instId);
    const mid = D(s.bid).add(D(s.ask)).div(2);
    console.log("snapshot:", JSON.stringify(s), `spread=${toDecString(D(s.ask).sub(D(s.bid)).div(mid).mul(100).toDecimalPlaces(4))}%`);
    for (const bar of ["5m", "15m", "1H"] as const) {
      const cs = await m.getCandles(instId, bar, 100);
      const last = cs.slice(-3).map((c) => `${new Date(c.ts).toISOString().slice(11, 16)} o=${c.o} h=${c.h} l=${c.l} c=${c.c} v=${c.vol}`);
      console.log(`candles ${bar}: ${cs.length} confirmed; last 3: ${last.join(" | ")}`);
    }
    const book = await m.getBook(instId, 20);
    const bidVol = book.bids.reduce((a, l) => a.add(D(l[1])), D("0"));
    const askVol = book.asks.reduce((a, l) => a.add(D(l[1])), D("0"));
    console.log(`book top 20: bidVol=${toDecString(bidVol)} askVol=${toDecString(askVol)} imbalance(bid/ask)=${askVol.isZero() ? "∞" : toDecString(bidVol.div(askVol).toDecimalPlaces(3))}`);
    const trades = await m.getTrades(instId, 200);
    const buy = trades.filter((t) => t.side === "buy").reduce((a, t) => a.add(D(t.sz)), D("0"));
    const sell = trades.filter((t) => t.side === "sell").reduce((a, t) => a.add(D(t.sz)), D("0"));
    const span = trades.length > 0 ? `${new Date(trades[trades.length - 1]!.ts).toISOString()} → ${new Date(trades[0]!.ts).toISOString()}` : "-";
    console.log(`trades: ${trades.length} (${span}) buyVol=${toDecString(buy)} sellVol=${toDecString(sell)} flow(buy/sell)=${sell.isZero() ? "∞" : toDecString(buy.div(sell).toDecimalPlaces(3))}`);
  } finally {
    await atk.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
