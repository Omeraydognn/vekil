import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { FakePolicyChain } from "../chain/fake-policy-chain.js";
import { FakeMarket } from "../market/fake-market.js";
import { keccakUtf8 } from "../shared/hash.js";
import { ceilToTick, decMul, floorToTick } from "../shared/money.js";
import type { ExecutorState, OrderRequest } from "../shared/schemas.js";
import { SystemClock } from "../shared/time.js";
import { HttpExecutorClient } from "./client.js";
import { FakeExchange } from "./exchanges/fake-exchange.js";
import { Executor } from "./executor.js";
import { executorApp, listenExecutor } from "./server.js";
import { MemoryStateStore } from "./store.js";

let srv: Server | null = null;
afterEach(() => {
  srv?.close();
  srv = null;
});

describe("executor HTTP server + client", () => {
  it("requires the token, binds loopback, and round-trips execute/events/exit/halt", async () => {
    const clock = new SystemClock();
    const chain = new FakePolicyChain({ clock });
    const market = new FakeMarket(clock);
    const exchange = new FakeExchange(market, clock, { startQuote: "1000", feeRate: "0.002" });
    const ex = new Executor({
      mode: "fake", chainId: chain.chainId, policy: chain.address, chain, exchange, market, clock, store: new MemoryStateStore<ExecutorState>(),
      atk: { kind: "fake", modules: [], readOnly: true, demo: false, tools: [] }, pollMs: 5,
    });
    const token = "t".repeat(64);
    await expect(listenExecutor(executorApp(ex, token), "0.0.0.0", 0)).rejects.toThrow(/127\.0\.0\.1/);
    srv = await listenExecutor(executorApp(ex, token), "127.0.0.1", 0);
    const port = (srv.address() as { port: number }).port;
    const bad = new HttpExecutorClient(`http://127.0.0.1:${port}`, "wrong");
    await expect(bad.health()).rejects.toThrow(/401/);
    const c = new HttpExecutorClient(`http://127.0.0.1:${port}`, token);
    expect((await c.health()).mode).toBe("fake");

    const s = await market.getSnapshot("AVAX-TRY");
    const px = ceilToTick(decMul(s.ask, "1.001"), "0.1");
    const req: OrderRequest = {
      instId: "AVAX-TRY", side: "buy", px, sz: "0.4", stopPx: floorToTick(decMul(px, "0.99"), "0.1"), tpPx: "0", timeStopMin: 240,
      decisionHash: keccakUtf8("d"), nonce: keccakUtf8("n"),
    };
    const a = await chain.requestApproval(req, { timeoutMs: 1 });
    expect((await c.execute(req, a.orderHash)).result).toBe("FILLED");
    expect((await c.events(0)).map((e) => e.type)).toEqual(["FILL"]);
    expect((await c.orders(["AVAX-TRY"], 0))).toHaveLength(1);
    await c.halt();
    expect((await c.health()).halted).toBe(true);
    expect((await c.exit(a.orderHash, "OWNER_CLOSE")).result).toBe("FILLED");
    expect(await c.cancelAll("api")).toEqual([]);
    await expect(c.adjust(a.orderHash)).rejects.toThrow(/400/);
  });
});
