// UI replay mode (PLAN M1-D acceptance): serves the dashboard and replays fixtures/ui-events.jsonl over SSE in a loop,
// with no core, chain, market or executor. POSTs answer 202 { replay: true }. Start: UI_REPLAY=fixtures/ui-events.jsonl pnpm dev
import { readFileSync } from "node:fs";
import express from "express";
import { z } from "zod";
import type { VekilEvent } from "../shared/events.js";
import { SSE_EVENT_TYPES } from "../shared/events.js";
import { postGuard, staticWeb, WEB_DIR } from "./server.js";
import { sseHandler } from "./sse.js";

const EventLine = z.object({ type: z.enum(SSE_EVENT_TYPES), ts: z.number().int(), cycleId: z.string().optional(), test: z.boolean().optional(), data: z.record(z.string(), z.unknown()) });

export function readReplay(path: string): VekilEvent[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => EventLine.parse(JSON.parse(l)) as VekilEvent);
}

export function replayApp(opts: { file: string; token: string; stepMs?: number; webDir?: string }): { app: express.Express; stop(): void } {
  const events = readReplay(opts.file);
  const states = events.filter((e) => e.type === "state");
  let current = states[0]?.data ?? {};
  const subs = new Set<(e: VekilEvent) => void>();
  let i = 0;
  const step = opts.stepMs ?? 900;
  const timer = setInterval(() => {
    const e = events[i % events.length];
    i++;
    if (!e) return;
    const live: VekilEvent = { ...e, ts: Date.now() };
    if (live.type === "state") current = live.data;
    for (const fn of subs) fn(live);
  }, step);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use(postGuard(opts.token));
  app.get("/api/state", (_req, res) => void res.json(current));
  app.get("/api/events", sseHandler({
    initial: () => [{ type: "state", ts: Date.now(), data: current }],
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  }));
  app.get(["/api/ledger", "/api/policy", "/api/audit"], (_req, res) => void res.status(202).json({ replay: true }));
  app.post(/^\/api\/.*/, (_req, res) => void res.status(202).json({ replay: true }));
  staticWeb(app, opts.webDir ?? WEB_DIR, opts.token);
  return { app, stop: () => clearInterval(timer) };
}
