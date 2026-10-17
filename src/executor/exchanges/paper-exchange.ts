// PaperExchange (SPEC §14.7): FakeExchange logic with live prices; balances and the order log persist in
// $DATA_DIR/paper-account.json. It never touches the real account.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Clock, MarketData } from "../../shared/interfaces.js";
import { Dec, OrderStateSchema } from "../../shared/schemas.js";
import { FakeExchange, type PaperBook } from "./fake-exchange.js";

const PaperBookSchema = z.object({
  quote: Dec,
  base: z.record(z.string(), Dec),
  orders: z.array(OrderStateSchema),
  nextOrdId: z.number().int().positive(),
});

export const paperAccountPath = (dataDir: string): string => join(dataDir, "paper-account.json");

export class PaperExchange extends FakeExchange {
  constructor(
    market: MarketData,
    clock: Clock,
    private readonly path: string,
    opts: { startQuote: string; feeRate: string },
  ) {
    const initial = existsSync(path) ? (PaperBookSchema.parse(JSON.parse(readFileSync(path, "utf8"))) as PaperBook) : undefined;
    super(market, clock, { ...opts, ...(initial ? { initial } : {}) });
    if (!initial) this.changed();
  }

  protected override changed(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.book));
    renameSync(tmp, this.path);
  }
}
