// Startup checks (SPEC §18). M1: SC1, SC2, SC3, SC5, SC7, SC8, SC11, SC13. SC4, SC6, SC9, SC10, SC12, SC14 land in M3.
import type { ChainView } from "../shared/interfaces.js";
import { ChainPolicySchema, type AgentState, type StartupReport } from "../shared/schemas.js";
import type { CoreDeps } from "./deps.js";
import { dataDirMismatch } from "./state-store.js";

export const WRITE_TOOL_RE = /(^|[_.-])(place|cancel|amend|transfer|withdraw|set)([_.-]|$)/i;
const FORBIDDEN_TRADE_TOOL_RE = /withdraw|transfer/i;
const LIVE_TRADE_TOOL_RE = /^(market|spot|system)_/;
const LIVE_PORTS = { port: 8787, executorPort: 8789 };

type Check = StartupReport["checks"][number];

export interface StartupInput {
  /** state.json as loaded (null = fresh data dir); loadError when it could not be read. */
  state: AgentState | null;
  loadError: string | null;
}

export interface StartupOutcome {
  report: StartupReport;
  view: ChainView | null;
  /** Start HALTED (contract paused or state.json HALTED). */
  halted: boolean;
  haltReason: string | null;
  /** SC13 failed: the data dir must not be written. */
  foreignDataDir: boolean;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runStartupChecks(d: CoreDeps, input: StartupInput): Promise<StartupOutcome> {
  const { cfg } = d;
  const checks: Check[] = [];
  const add = (id: string, ok: boolean, level: Check["level"], tr: string, details: string): void => {
    checks.push({ id, ok, level, tr, details });
  };
  const fakeMode = cfg.mode === "fake";
  const fakeChain = cfg.chain === "fake";
  let halted = false;
  let haltReason: string | null = null;

  // SC1: config (loadConfig already refused bad combinations); loopback only.
  const sc1 = cfg.host === "127.0.0.1" && cfg.port !== cfg.executorPort;
  add("SC1", sc1, "fail", "Ayarlar geçerli", sc1 ? `${cfg.mode}/${cfg.chain}, ${cfg.host}:${cfg.port}` : "HOST loopback değil veya portlar çakışıyor");

  // SC2: mode allowed.
  const sc2: string[] = [];
  const liveLike = cfg.mode === "live" || cfg.mode === "demo";
  if (liveLike && !d.liveArmed) sc2.push("Canlı mod sadece `pnpm live` ile başlatılır");
  if (liveLike && (cfg.port !== LIVE_PORTS.port || cfg.executorPort !== LIVE_PORTS.executorPort)) sc2.push("canlı mod 8787/8789 portlarını ister");
  if (!liveLike && (cfg.port === LIVE_PORTS.port || cfg.executorPort === LIVE_PORTS.executorPort)) sc2.push("8787/8789 canlıya ayrılmış; geliştirmede 8788/8790");
  if (cfg.chain === "mainnet" && !(liveLike && d.liveArmed)) sc2.push("ana ağ sadece `pnpm live` ile");
  add("SC2", sc2.length === 0, "fail", "Mod izinli", sc2.join("; ") || cfg.mode);

  // SC3: core read instance is read-only.
  if (fakeMode) add("SC3", true, "fail", "Okuma anahtarı salt-okunur", "fake");
  else if (!d.atkRead) add("SC3", false, "fail", "Okuma anahtarı salt-okunur", "okuma örneği yok");
  else {
    try {
      const caps = await d.atkRead.capabilities();
      const writeTools = (await d.atkRead.listTools()).map((t) => t.name).filter((n) => WRITE_TOOL_RE.test(n));
      if (caps?.readOnly === true) add("SC3", true, "fail", "Okuma anahtarı salt-okunur", writeTools.length ? `capabilities readOnly; listed but refused: ${writeTools.join(", ")}` : "capabilities readOnly");
      else add("SC3", false, "fail", "Okuma anahtarı salt-okunur", caps ? "capabilities: readOnly değil" : writeTools.length ? `yazma araçları: ${writeTools.join(", ")}` : "capabilities okunamadı");
    } catch (e) {
      add("SC3", false, "fail", "Okuma anahtarı salt-okunur", errMsg(e));
    }
  }

  // SC5: executor health, binding and isolation.
  try {
    const h = await d.executor.health();
    const issues: string[] = [];
    if (!h.ok) issues.push("health ok değil");
    if (h.mode !== cfg.mode) issues.push(`mode ${h.mode} ≠ ${cfg.mode}`);
    if (h.chainId !== d.chain.chainId) issues.push(`chainId ${h.chainId} ≠ ${d.chain.chainId}`);
    if (h.policy !== d.chain.address) issues.push("kontrat adresi farklı");
    if (cfg.mode === "fake" && h.atk.kind !== "fake") issues.push("fake modda gerçek ATK");
    if (cfg.mode === "paper" && !h.atk.readOnly) issues.push("paper emir gönderici salt-okunur değil");
    if (liveLike) {
      if (h.atk.kind !== "trade") issues.push("işlem örneği yok");
      const bad = h.atk.tools.filter((t) => FORBIDDEN_TRADE_TOOL_RE.test(t) || !LIVE_TRADE_TOOL_RE.test(t));
      if (bad.length) issues.push(`izin dışı araçlar: ${bad.join(", ")}`);
    }
    add("SC5", issues.length === 0, "fail", "Emir gönderici hazır ve izole", issues.join("; ") || `${h.atk.kind}, ${h.positions.length} pozisyon`);
  } catch (e) {
    add("SC5", false, "fail", "Emir gönderici hazır ve izole", errMsg(e));
  }

  // SC7: INST_ID spec loaded and live.
  try {
    const spec = await d.market.getInstrument(cfg.instId);
    add("SC7", spec.state === "live", "fail", "Çift işleme açık", `${spec.instId} ${spec.state}`);
  } catch (e) {
    add("SC7", false, "fail", "Çift işleme açık", errMsg(e));
  }

  // SC8: contract readable, ours, policy valid and not expired; paused → HALTED.
  let view: ChainView | null = null;
  try {
    view = await d.chain.readView();
    const issues: string[] = [];
    if (!fakeChain && d.agentAddress && view.agent !== d.agentAddress) issues.push("agent() bizim adresimiz değil");
    if (!ChainPolicySchema.safeParse(view.policy).success) issues.push("kurallar okunamadı");
    if (view.policy.validUntil <= d.clock.now()) issues.push("Kuralların süresi dolmuş");
    if (issues.length) add("SC8", false, "fail", "Kontrat erişilebilir", issues.join("; "));
    else if (view.paused) {
      halted = true;
      haltReason = "PAUSED";
      add("SC8", false, "warn", "Kontrat erişilebilir", "Kontrat freni AKTİF; DURDURULDU olarak başlıyor");
    } else add("SC8", true, "fail", "Kontrat erişilebilir", `${d.chain.address} v${view.policyVersion}${fakeChain ? " (fake)" : ""}`);
  } catch (e) {
    add("SC8", false, "fail", "Kontrat erişilebilir", errMsg(e));
  }

  // SC13 before SC11: a foreign state.json must not decide anything.
  let foreign = false;
  if (input.loadError) {
    foreign = true;
    add("SC13", false, "fail", "Veri klasörü bu çalıştırmaya ait", input.loadError);
  } else if (input.state) {
    const mism = dataDirMismatch(input.state, { mode: cfg.mode, chainId: d.chain.chainId, policy: d.chain.address });
    foreign = mism !== null;
    add("SC13", !foreign, "fail", foreign ? "Bu veri klasörü başka bir çalıştırmaya ait" : "Veri klasörü bu çalıştırmaya ait", mism ?? d.dataDir);
  } else add("SC13", true, "fail", "Veri klasörü bu çalıştırmaya ait", "yeni veri klasörü");

  // SC11: state.json not HALTED.
  if (!foreign && input.state?.status === "HALTED") {
    halted = true;
    haltReason = input.state.haltReason ?? "HALTED";
    add("SC11", false, "warn", "Durdurma kaydı yok", `önceki durdurma: ${haltReason}; devam için \`pnpm resume\``);
  } else add("SC11", true, "warn", "Durdurma kaydı yok", "");

  const ok = checks.every((c) => c.ok || c.level === "warn");
  return { report: { ok, checks }, view, halted, haltReason, foreignDataDir: foreign };
}
