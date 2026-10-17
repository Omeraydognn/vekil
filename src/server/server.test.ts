import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRuntime, type Runtime } from "../core/wiring.js";
import { loadConfig } from "../shared/config.js";
import { coreApp, listen, newServerToken } from "./server.js";

let rt: Runtime | null = null;
let srv: Server | null = null;
let dir = "";
afterEach(async () => {
  srv?.close();
  await rt?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("core server", () => {
  it("binds loopback, injects the token, guards POSTs, answers 423 while halted, kill works", async () => {
    dir = mkdtempSync(join(tmpdir(), "vekil-srv-"));
    const cfg = loadConfig({ dotenv: false, env: { EXECUTION_MODE: "fake", LLM_PROVIDER: "scripted", CHAIN: "fake", DATA_DIR: dir } });
    rt = await buildRuntime(cfg, { executorLoops: false, wipeEphemeral: false });
    await rt.core.startup();
    const token = newServerToken(dir);
    const app = coreApp({ core: rt.core, bus: rt.bus, clock: rt.clock, token });
    await expect(listen(app, "0.0.0.0", 0)).rejects.toThrow(/127\.0\.0\.1/);
    srv = await listen(app, "127.0.0.1", 0);
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain(`<meta name="vekil-token" content="${token}">`);
    expect((await fetch(`${base}/api/state`)).status).toBe(200);
    expect((await fetch(`${base}/api/kill`, { method: "POST" })).status).toBe(401);
    const post = (path: string, body: unknown = {}) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "x-vekil-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/api/owner-note", { text: "" })).status).toBe(400);
    const kill = (await (await post("/api/kill", { pauseOnChain: true })).json()) as { alreadyHalted: boolean };
    expect(kill.alreadyHalted).toBe(false);
    expect((await post("/api/think")).status).toBe(423);
    expect((await post("/api/anchor")).status).toBe(200);
  });
});

describe("errorText", () => {
  it("shortens a viem error and names a 429 from the RPC", async () => {
    const { errorText } = await import("./server.js");
    const http = Object.assign(new Error("HTTP request failed.\nDetails: <!doctype html>..."), { status: 429 });
    const wrapped = Object.assign(new Error("outer\n<html>"), { shortMessage: "HTTP request failed.", cause: { cause: http } });
    expect(errorText(wrapped)).toMatch(/429/);
    expect(errorText(wrapped)).not.toMatch(/html/);
    expect(errorText(Object.assign(new Error("long\nbody"), { shortMessage: "kısa" }))).toBe("kısa");
    expect(errorText(new Error("first\nsecond"))).toBe("first");
  });
});
