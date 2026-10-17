// Executor HTTP API (SPEC §14.2–14.6). Binds 127.0.0.1 only; every endpoint requires x-executor-token.
import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { AdjustBodySchema, CancelAllBodySchema, ExecuteBodySchema, ExitBodySchema, type Hex32 } from "../shared/schemas.js";
import type { Executor } from "./executor.js";

function tokenOk(given: unknown, token: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function executorApp(ex: Executor, token: string): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!tokenOk(req.header("x-executor-token"), token)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });
  const body = <T extends z.ZodType>(schema: T, req: Request, res: Response): z.infer<T> | null => {
    const r = schema.safeParse(req.body);
    if (!r.success) {
      res.status(400).json({ error: r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") });
      return null;
    }
    return r.data;
  };
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
    fn(req, res).catch((e: unknown) => res.status(500).json({ error: e instanceof Error ? e.message : String(e) }));
  };

  app.get("/health", wrap(async (_req, res) => void res.json(await ex.health())));
  app.get("/account", wrap(async (req, res) => {
    const instId = z.string().min(1).safeParse(req.query.instId);
    if (!instId.success) return void res.status(400).json({ error: "instId" });
    res.json(await ex.account(instId.data));
  }));
  app.get("/orders", wrap(async (req, res) => {
    const q = z.object({ instIds: z.string().min(1), since: z.coerce.number().int().nonnegative() }).safeParse(req.query);
    if (!q.success) return void res.status(400).json({ error: "instIds, since" });
    res.json(await ex.orders(q.data.instIds.split(","), q.data.since));
  }));
  app.get("/events", wrap(async (req, res) => {
    const since = z.coerce.number().int().nonnegative().safeParse(req.query.since ?? 0);
    if (!since.success) return void res.status(400).json({ error: "since" });
    res.json(await ex.events(since.data));
  }));
  app.post("/execute", wrap(async (req, res) => {
    const b = body(ExecuteBodySchema, req, res);
    if (b) res.json(await ex.execute(b.req, b.orderHash));
  }));
  app.post("/exit", wrap(async (req, res) => {
    const b = body(ExitBodySchema, req, res);
    if (b) res.json(await ex.exit(b.entryOrderHash as Hex32, b.reason));
  }));
  app.post("/adjust", wrap(async (req, res) => {
    const b = body(AdjustBodySchema, req, res);
    if (b) res.json(await ex.adjust(b.entryOrderHash as Hex32, b.newStopPx, b.newTpPx));
  }));
  app.post("/halt", wrap(async (_req, res) => {
    await ex.halt();
    res.json({ ok: true });
  }));
  app.post("/cancel-all", wrap(async (req, res) => {
    const b = body(CancelAllBodySchema, req, res);
    if (b) res.json({ cancelled: await ex.cancelAll(b.by) });
  }));
  return app;
}

export async function listenExecutor(app: express.Express, host: string, port: number): Promise<Server> {
  if (host !== "127.0.0.1") throw new Error("executor binds 127.0.0.1 only");
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, host, () => resolve(srv));
    srv.on("error", reject);
  });
}
