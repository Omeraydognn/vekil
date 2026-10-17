// Core HTTP server (SPEC §19): loopback only; the token lives in $DATA_DIR/server-token and is injected into the
// dashboard as <meta name="vekil-token">. Every POST requires x-vekil-token. No CORS. No resume/live/mainnet endpoints.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import type { z } from "zod";
import { BusyError, CoreError } from "../core/errors.js";
import type { Vekil } from "../core/vekil.js";
import { makeEvent } from "../shared/events.js";
import type { Clock, EventBus } from "../shared/interfaces.js";
import {
  ApplyBodySchema, AskBodySchema, CloseBodySchema, KillBodySchema, OwnerNoteBodySchema, ProposeBodySchema, RogueBodySchema, VerifyBodySchema,
  type Hex32,
} from "../shared/schemas.js";
import { sseHandler } from "./sse.js";

export const serverTokenPath = (dataDir: string): string => join(dataDir, "server-token");
export const WEB_DIR = resolve(process.cwd(), "web");

function tokenOk(given: unknown, token: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newServerToken(dataDir: string): string {
  const token = randomBytes(32).toString("hex");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(serverTokenPath(dataDir), token, { mode: 0o600 });
  return token;
}

/** index.html with the token meta tag. */
export function renderIndex(webDir: string, token: string): string {
  const html = readFileSync(join(webDir, "index.html"), "utf8");
  return html.replace("<!--VEKIL_TOKEN-->", `<meta name="vekil-token" content="${token}">`);
}

export function staticWeb(app: express.Express, webDir: string, token: string): void {
  app.get(["/", "/index.html"], (_req, res) => {
    res.type("html").send(renderIndex(webDir, token));
  });
  app.use(express.static(webDir, { index: false }));
}

/** DNS-rebinding hardening: only loopback Host headers. */
export function hostGuard() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = (req.header("host") ?? "").replace(/:\d+$/, "");
    if (host !== "127.0.0.1" && host !== "localhost") {
      res.status(403).json({ error: "host" });
      return;
    }
    next();
  };
}

export function postGuard(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === "POST" && !tokenOk(req.header("x-vekil-token"), token)) {
      res.status(401).json({ error: "yetkisiz" });
      return;
    }
    next();
  };
}

export interface CoreServerOpts {
  core: Vekil;
  bus: EventBus;
  clock: Clock;
  token: string;
  webDir?: string;
}

export function coreApp(o: CoreServerOpts): express.Express {
  const { core } = o;
  const app = express();
  app.disable("x-powered-by");
  app.use(hostGuard());
  app.use(express.json({ limit: "64kb" }));
  app.use(postGuard(o.token));

  const body = <T extends z.ZodType>(schema: T, req: Request, res: Response): z.infer<T> | null => {
    const r = schema.safeParse(req.body ?? {});
    if (!r.success) {
      res.status(400).json({ error: r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") });
      return null;
    }
    return r.data;
  };
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
    fn(req, res).catch((e: unknown) => {
      const status = e instanceof CoreError ? e.status : 500;
      res.status(status).json({ error: e instanceof Error ? e.message : String(e) });
    });
  };

  app.get("/api/state", (_req, res) => void res.json(core.getState()));
  app.get(
    "/api/events",
    sseHandler({
      initial: () => [makeEvent("state", o.clock.now(), core.getState() as unknown as Record<string, unknown>)],
      subscribe: (fn) => o.bus.subscribe(fn),
    }),
  );
  app.get("/api/ledger", (req, res) => {
    const n = Number(req.query.limit ?? 200);
    res.json(core.ledgerTail(Number.isSafeInteger(n) && n > 0 ? n : 200));
  });
  app.get("/api/policy", (_req, res) => void res.json(core.policyInfo()));
  app.post("/api/policy/propose", wrap(async (req, res) => {
    const b = body(ProposeBodySchema, req, res);
    if (b) res.json(await core.proposePolicy(b.text));
  }));
  app.post("/api/policy/apply", wrap(async (req, res) => {
    const b = body(ApplyBodySchema, req, res);
    if (!b) return;
    if (req.query.wallet === "1") res.json({ wallet: core.walletCall(b.id) });
    else res.json(await core.applyPolicy(b.id));
  }));
  app.post("/api/think", wrap(async (_req, res) => {
    if (core.getState().status !== "RUNNING") return void res.status(423).json({ error: "Vekil durduruldu" });
    try {
      res.json(await core.runCycle({ trigger: "manual" }));
    } catch (e) {
      if (e instanceof BusyError) return void res.status(409).json({ error: e.message });
      throw e;
    }
  }));
  app.post("/api/close", wrap(async (req, res) => {
    const b = body(CloseBodySchema, req, res);
    if (b) res.json(await core.ownerClose(b.entryOrderHash as Hex32));
  }));
  app.post("/api/kill", wrap(async (req, res) => {
    const b = body(KillBodySchema, req, res);
    if (b) res.json(await core.kill({ source: "dashboard", reason: b.flatten ? "Durdur ve kapat" : "DURDUR", flatten: b.flatten ?? false, pauseOnChain: b.pauseOnChain ?? true }));
  }));
  app.post("/api/verify", wrap(async (req, res) => {
    const b = body(VerifyBodySchema, req, res);
    if (b) res.json(await core.verify({ ...(b.tamperSeq !== undefined ? { tamperSeq: b.tamperSeq } : {}), ...(b.proveSeq !== undefined ? { proveSeq: b.proveSeq } : {}) }));
  }));
  app.post("/api/anchor", (_req, res) => {
    core.requestAnchor();
    res.json({ queued: true });
  });
  app.get("/api/audit", wrap(async (_req, res) => void res.json(await core.audit())));
  app.post("/api/redteam/injection", wrap(async (_req, res) => {
    try {
      res.json(await core.runInjectionTest());
    } catch (e) {
      if (e instanceof BusyError) return void res.status(409).json({ error: e.message });
      throw e;
    }
  }));
  app.post("/api/redteam/rogue", wrap(async (req, res) => {
    const b = body(RogueBodySchema, req, res);
    if (!b) return;
    try {
      res.json(await core.runRogue(b.id));
    } catch (e) {
      if (e instanceof BusyError) return void res.status(409).json({ error: e.message });
      throw e;
    }
  }));
  app.post("/api/owner-note", wrap(async (req, res) => {
    const b = body(OwnerNoteBodySchema, req, res);
    if (!b) return;
    core.setOwnerNote(b.text);
    res.json({ ok: true });
  }));
  app.post("/api/ask", wrap(async (req, res) => {
    const b = body(AskBodySchema, req, res);
    if (b) res.json({ answer: await core.ask(b.question) });
  }));
  staticWeb(app, o.webDir ?? WEB_DIR, o.token);
  return app;
}

export async function listen(app: express.Express, host: string, port: number): Promise<Server> {
  if (host !== "127.0.0.1") throw new Error("core binds 127.0.0.1 only");
  return new Promise((resolveP, reject) => {
    const srv = app.listen(port, host, () => resolveP(srv));
    srv.on("error", reject);
  });
}
