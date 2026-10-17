// AtkClient: the only way VEKİL talks to okx-trade-mcp (SPEC §8.2, §8.3, §14.1).
// - The process is created by an injected spawner. Unit tests inject a fake and never spawn okx-trade-mcp.
// - A trade-capable instance (readOnly: false) starts only if isLiveArmed().
// - The cancel-only client needs no arming, but only for a live/demo data dir, and it refuses every tool but cancel.
// - Every call goes through an explicit allowlist; names outside it never reach the server.
// - A read-only instance must report capabilities.readOnly and list no write tools, or it is closed and refused.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { z } from "zod";
import { assertLiveArmed } from "../shared/arming.js";
import type { AtkReader } from "../shared/interfaces.js";
import { McpToolSchema, ModeSchema, type McpTool, type Mode } from "../shared/schemas.js";
import { isWriteToolName } from "./manifest.js";
import { AtkToolError, parseCapabilities, resultText, unwrap, type AtkCapabilities, type RawToolResult } from "./parse.js";

export const CAPABILITIES_TOOL = "system_get_capabilities";
/** Tools the cancel-only client may call (ATK_NOTES §6). */
export const CANCEL_ONLY_TOOLS: readonly string[] = ["spot_cancel_order"];
export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

export interface SpawnSpec {
  command: string;
  args: string[];
}
/** What a spawned server looks like to us. The real one wraps the MCP SDK stdio client. */
export interface AtkConnection {
  listTools(): Promise<unknown[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<RawToolResult>;
  close(): Promise<void>;
}
export type AtkSpawner = (spec: SpawnSpec) => Promise<AtkConnection>;

export interface AtkStartOpts {
  profile: string;
  modules: string[];
  readOnly: boolean;
  /** kill.ts last fallback only (§8.2). Requires readOnly: false. */
  cancelOnly?: boolean;
  demo?: boolean;
  /** Tool names this instance may call (system_get_capabilities is always allowed). Ignored for cancelOnly. */
  allow: readonly string[];
  site?: "tr";
  toolTimeoutMs?: number;
}
export interface AtkDeps {
  spawner: AtkSpawner;
  mode: Mode;
  env?: NodeJS.ProcessEnv;
  /** Needed for cancelOnly: the mode recorded in $DATA_DIR/state.json. */
  dataDir?: string;
  readStateMode?: (dataDir: string) => Mode | null;
}

export class AtkRefusedError extends Error {
  override name = "AtkRefusedError";
}

export function buildArgs(opts: AtkStartOpts): string[] {
  const args = ["--profile", opts.profile, "--modules", opts.modules.join(","), "--site", opts.site ?? "tr"];
  if (opts.readOnly) args.push("--read-only");
  if (opts.demo) args.push("--demo");
  return args;
}

/** state.json → mode, or null if missing/unreadable. Reads only our own data dir. */
export function readStateModeFromFile(dataDir: string): Mode | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8"));
    const r = z.looseObject({ mode: ModeSchema }).safeParse(raw);
    return r.success ? r.data.mode : null;
  } catch {
    return null;
  }
}

export class AtkClient implements AtkReader {
  private closed = false;
  private constructor(
    private readonly conn: AtkConnection,
    readonly opts: Readonly<AtkStartOpts>,
    readonly kind: "read" | "trade" | "cancel-only",
    readonly version: string | null,
    readonly capabilities: AtkCapabilities,
    private readonly tools: McpTool[],
    private readonly allowed: ReadonlySet<string>,
  ) {}

  static async start(opts: AtkStartOpts, deps: AtkDeps): Promise<AtkClient> {
    const env = deps.env ?? process.env;
    let kind: "read" | "trade" | "cancel-only";
    if (opts.cancelOnly) {
      if (opts.readOnly) throw new AtkRefusedError("cancelOnly requires readOnly: false");
      if (!deps.dataDir) throw new AtkRefusedError("cancelOnly needs DATA_DIR");
      const m = (deps.readStateMode ?? readStateModeFromFile)(deps.dataDir);
      if (m !== "live" && m !== "demo") throw new AtkRefusedError("cancelOnly is allowed only when state.json says live or demo");
      kind = "cancel-only";
    } else if (!opts.readOnly) {
      assertLiveArmed({ mode: deps.mode, env });
      kind = "trade";
    } else {
      kind = "read";
    }

    const conn = await deps.spawner({ command: process.execPath, args: [atkBinPath(), ...buildArgs(opts)] });
    try {
      const rawTools = await conn.listTools();
      const tools = z.array(McpToolSchema).parse(rawTools);
      const capText = resultText(await conn.callTool(CAPABILITIES_TOOL, {}, opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS));
      const { version, capabilities } = parseCapabilities(capText);

      if (capabilities.readOnly !== opts.readOnly) throw new AtkRefusedError(`capabilities.readOnly=${capabilities.readOnly}, expected ${opts.readOnly}`);
      if (capabilities.demo !== Boolean(opts.demo)) throw new AtkRefusedError(`capabilities.demo=${capabilities.demo}, expected ${Boolean(opts.demo)}`);
      if (opts.readOnly) {
        const w = tools.filter((t) => isWriteToolName(t.name));
        if (w.length > 0) throw new AtkRefusedError(`read-only instance lists write tools: ${w.map((t) => t.name).join(",")}`);
      }
      const names = new Set(tools.map((t) => t.name));
      const base = kind === "cancel-only" ? CANCEL_ONLY_TOOLS : opts.allow;
      const allowed = new Set<string>([CAPABILITIES_TOOL, ...base.filter((n) => names.has(n))]);
      return new AtkClient(conn, opts, kind, version, capabilities, tools, allowed);
    } catch (e) {
      await conn.close().catch(() => undefined);
      throw e;
    }
  }

  /** The full tool list as the server reported it (for the manifest hash and SC3/SC5). */
  async listTools(): Promise<McpTool[]> {
    return this.tools.map((t) => ({ ...t }));
  }

  /** Tools this instance is allowed to call. */
  allowedTools(): string[] {
    return [...this.allowed].sort();
  }

  /** Raw text of the tool result (AtkReader). An isError result is returned as text, not thrown. */
  async callTool(name: string, args: unknown): Promise<string> {
    const r = await this.callRaw(name, args);
    return resultText(r);
  }

  /** Parsed OKX `data` payload; throws AtkToolError on isError or a bad envelope. */
  async callData(name: string, args: Record<string, unknown>): Promise<unknown> {
    const r = await this.callRaw(name, args);
    return unwrap(name, resultText(r), r.isError === true);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.conn.close();
  }

  private async callRaw(name: string, args: unknown): Promise<RawToolResult> {
    if (this.closed) throw new AtkRefusedError("client closed");
    if (!this.allowed.has(name)) throw new AtkRefusedError(`tool not allowed on this ${this.kind} instance: ${name}`);
    const a = args ?? {};
    if (typeof a !== "object" || Array.isArray(a)) throw new AtkToolError(name, "BAD_ARGS", "arguments must be an object");
    return this.conn.callTool(name, a as Record<string, unknown>, this.opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
  }
}

/** Absolute path of the pinned package's bin JS (spawned with process.execPath, SPEC §26). */
export function atkBinPath(): string {
  const req = createRequire(import.meta.url);
  const pkgJson = req.resolve("@okx_ai/okx-trade-mcp/package.json");
  const pkg = z.looseObject({ bin: z.union([z.string(), z.record(z.string(), z.string())]) }).parse(JSON.parse(readFileSync(pkgJson, "utf8")));
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin["okx-trade-mcp"];
  if (!rel) throw new Error("okx-trade-mcp bin not found");
  return join(dirname(pkgJson), rel);
}

/** The real spawner (MCP SDK stdio). Only scripts and the processes started by `pnpm dev`/`pnpm live` use it. */
export const stdioSpawner: AtkSpawner = async (spec) => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  // No `env`: the SDK passes only its default safe variables (HOME, PATH, …), so our own secrets never reach the child.
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args, stderr: "ignore" });
  const client = new Client({ name: "vekil", version: "0.1.0" });
  await client.connect(transport);
  return {
    async listTools() {
      const out: unknown[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        out.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return out;
    },
    async callTool(name, args, timeoutMs) {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
      return { isError: r.isError === true, content: r.content };
    },
    async close() {
      await client.close();
    },
  };
};
