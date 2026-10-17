// Server-sent events (SPEC §19): state on connect, every bus event, a 15 s heartbeat.
import type { Request, Response } from "express";
import type { VekilEvent } from "../shared/events.js";

export const HEARTBEAT_MS = 15_000;

export interface SseSource {
  /** Sent right after the connection opens. */
  initial(): VekilEvent[];
  subscribe(fn: (e: VekilEvent) => void): () => void;
}

export function sseHandler(src: SseSource) {
  return (req: Request, res: Response): void => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (e: VekilEvent): void => {
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    for (const e of src.initial()) send(e);
    const unsub = src.subscribe(send);
    const hb = setInterval(() => res.write(`: hb ${Date.now()}\n\n`), HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(hb);
      unsub();
    });
  };
}
