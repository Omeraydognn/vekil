// VEKİL Guard HTTP JSON API (docs/GUARD_PLAN.md). Read-only: no keys, no state changes.
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { errorText, hostGuard } from "../server/server.js";
import { AuditQueryError, AuditQuerySchema, auditClOrdId, checkOrder, CheckBodySchema, policySummary, type GuardDeps } from "./guard.js";
import { guardManifest } from "./manifest.js";

export const isLoopbackHost = (h: string): boolean => h === "127.0.0.1" || h === "::1" || h === "localhost";

export interface GuardServerOpts extends GuardDeps {
  baseUrl: string;
  /** Only accept loopback Host headers (DNS-rebinding hardening) when bound to 127.0.0.1. */
  loopbackOnly: boolean;
  /** Simulated per-check price; when set, /v1/check needs an x-payment header or answers 402. */
  pricePerCheck?: string | null;
  /** Requests per minute per client IP. */
  ratePerMin?: number;
  requestTimeoutMs?: number;
}

const ProposeSchema = z.object({ text: z.string().min(1).max(1000) }).strict();

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new HttpError(504, `zaman aşımı (${ms} ms)`)), ms);
    p.then((v) => resolve(v), (e: unknown) => reject(e)).finally(() => clearTimeout(t));
  });
}

/** Fixed-window limiter per client IP. Enough to keep one caller from exhausting the public RPC. */
function rateLimit(perMin: number, now: () => number) {
  const hits = new Map<string, { windowStart: number; n: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? "unknown";
    const t = now();
    const h = hits.get(key);
    if (!h || t - h.windowStart >= 60_000) hits.set(key, { windowStart: t, n: 1 });
    else if (++h.n > perMin) {
      res.status(429).json({ error: "çok fazla istek; bir dakika sonra tekrar deneyin" });
      return;
    }
    if (hits.size > 10_000) for (const [k, v] of hits) if (t - v.windowStart >= 60_000) hits.delete(k);
    next();
  };
}

export function guardApp(o: GuardServerOpts): express.Express {
  const app = express();
  const timeoutMs = o.requestTimeoutMs ?? 20_000;
  app.disable("x-powered-by");
  if (o.loopbackOnly) app.use(hostGuard());
  app.use(rateLimit(o.ratePerMin ?? 60, o.now));
  app.use(express.json({ limit: "16kb" }));

  const run = (fn: (req: Request) => Promise<unknown>) => (req: Request, res: Response) => {
    withTimeout(fn(req), timeoutMs)
      .then((body) => void res.json(body))
      .catch((e: unknown) => {
        if (e instanceof HttpError) return void res.status(e.status).json({ error: e.message });
        if (e instanceof AuditQueryError) return void res.status(400).json({ error: e.message });
        if (e instanceof z.ZodError) return void res.status(400).json({ error: e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
        res.status(502).json({ error: errorText(e) });
      });
  };

  app.get("/.well-known/vekil-guard.json", (_req, res) => {
    res.json(guardManifest({ baseUrl: o.baseUrl, chainId: o.chain.chainId, contract: o.chain.address, pricePerCheck: o.pricePerCheck ?? null }));
  });
  app.get("/v1/policy", run(() => policySummary(o)));
  app.post(
    "/v1/check",
    run(async (req) => {
      if (o.pricePerCheck && !req.header("x-payment")) {
        throw new HttpError(402, `Onay başına ücret: ${o.pricePerCheck} USDC (simülasyon). x-payment başlığıyla tekrar deneyin.`);
      }
      return checkOrder(o, CheckBodySchema.parse(req.body ?? {}));
    }),
  );
  app.get(
    "/v1/audit/:clOrdId",
    run((req) => {
      const id = String(req.params.clOrdId ?? "");
      if (id.length < 1 || id.length > 64) throw new HttpError(400, "clOrdId 1–64 karakter olmalı");
      return auditClOrdId(o, id, AuditQuerySchema.parse(req.query));
    }),
  );
  app.post(
    "/v1/policy/propose",
    run(async (req) => {
      if (!o.propose) throw new HttpError(503, "Text-to-Policy bu sunucuda kapalı (LLM yapılandırılmadı)");
      return { ...(await o.propose(ProposeSchema.parse(req.body ?? {}).text)), applied: false, note: "Taslak: zincire yalnızca sahip setPolicy ile yazar." };
    }),
  );
  app.use((_req, res) => void res.status(404).json({ error: "bulunamadı; uç noktalar için /.well-known/vekil-guard.json" }));
  return app;
}
