// VEKİL dashboard (SPEC §20). Vanilla JS: /api/state, then SSE with automatic reconnect. All strings: Appendix B.
"use strict";

const TOKEN = document.querySelector('meta[name="vekil-token"]')?.content ?? "";
const $ = (id) => document.getElementById(id);

const TR = {
  status: { RUNNING: "ÇALIŞIYOR", HALTED: "DURDURULDU", STARTUP_FAILED: "BAŞLATILAMADI" },
  mode: { fake: "SAHTE PİYASA", paper: "KAĞIT İŞLEM", demo: "DEMO HESAP", live: "CANLI" },
  regime: { TREND_UP: "Yükselen trend", TREND_DOWN: "Düşen trend", RANGE: "Yatay bant", HIGH_VOLATILITY: "Yüksek oynaklık", NEWS_DRIVEN: "Haber etkisi", UNCLEAR: "Belirsiz" },
  playbook: { TREND_PULLBACK: "Trendde geri çekilme", RANGE_REVERSION: "Bant içi dönüş", BREAKOUT_RETEST: "Kırılım sonrası test", STAND_ASIDE: "Kenarda bekle", MANAGE_POSITION: "Pozisyonu yönet" },
  action: { BUY: "AL", CLOSE: "KAPAT", HOLD: "BEKLE", ADJUST_STOP: "ZARAR-KES GÜNCELLE" },
  exit: { AGENT_CLOSE: "Ajan kapattı", STOP_HIT: "Zarar-kes tetiklendi", TP_HIT: "Kâr-al tetiklendi", TIME_STOP: "Süre doldu", KILL_FLATTEN: "Durdurup kapattı", OWNER_CLOSE: "Sahip kapattı" },
  outcome: {
    SKIPPED: "ATLANDI", NO_DECISION: "Ajan karar vermedi", INVALID_DECISION: "Karar biçimi geçersiz", LLM_ERROR: "Yapay zekâ servisine ulaşılamadı", HOLD: "BEKLE",
    LOCAL_BLOCK: "YEREL ENGEL", CHAIN_REQUEST_FAILED: "Zincire istek gönderilemedi", REJECTED: "REDDEDİLDİ", ENTRY_ABORTED: "İPTAL (onay kullanılmadı)",
    EXECUTED: "GERÇEKLEŞTİ", NOT_FILLED: "DOLMADI", ORDER_STATE_UNKNOWN: "Emir durumu bilinmiyor", ADJUSTED: "ZARAR-KES GÜNCELLENDİ", CLOSING: "KAPATILIYOR",
    TEST_CYCLE: "TEST — borsaya gönderilmez",
  },
  reason: {
    PAUSED: "Kontrat freni aktif", POLICY_EXPIRED: "Kuralların süresi dolmuş", INSTRUMENT_NOT_ALLOWED: "Bu çift izinli değil", SIDE_NOT_ALLOWED: "Bu yönde işlem izinli değil",
    ZERO_VALUE: "Fiyat veya miktar sıfır", ORDER_TOO_LARGE: "İşlem tutarı limiti aşıyor", STOP_MISSING: "Zarar-kes yok", STOP_INVALID: "Zarar-kes seviyesi geçersiz",
    STOP_TOO_TIGHT: "Zarar-kes çok yakın", STOP_TOO_WIDE: "Zarar-kes çok uzak", TP_INVALID: "Kâr-al seviyesi geçersiz", TIME_STOP_INVALID: "Süre sınırı geçersiz",
    HOURLY_LIMIT: "Saatlik işlem sınırı doldu", DAILY_LIMIT: "Günlük işlem sınırı doldu", RISK_BUDGET_EXCEEDED: "Günlük risk bütçesi aşılır",
    HALTED: "Vekil durduruldu", POLICY_PAUSED: "Kontrat freni aktif", CHAIN_STATE_STALE: "Zincir durumu alınamadı veya eski", MARKET_DATA_MISSING: "Piyasa verisi alınamadı",
    INSTRUMENT_NOT_LIVE: "Çift şu an işleme kapalı", STALE_MARKET_DATA: "Piyasa verisi eski", SPREAD_TOO_WIDE: "Alış-satış farkı çok açık", POSITION_ALREADY_OPEN: "Zaten açık pozisyon var",
    PRICE_FAR_FROM_MARKET: "Fiyat piyasadan çok uzak", ORDER_BELOW_MIN_SIZE: "Tutar borsanın alt sınırının altında", INSUFFICIENT_BALANCE: "Bakiye yetersiz",
    COOLDOWN_ACTIVE: "Kayıptan sonra bekleme süresi", NO_POSITION: "Kapatılacak pozisyon yok", STOP_LOOSENED: "Zarar-kes sadece sıkılaştırılabilir",
    STOP_ABOVE_MARKET: "Zarar-kes piyasanın üstünde", TP_BELOW_MARKET: "Kâr-al piyasanın altında",
    INVALID_DECISION: "Karar biçimi geçersiz", NO_DECISION: "Ajan karar vermedi", LLM_ERROR: "Yapay zekâ servisine ulaşılamadı", CHAIN_REQUEST_FAILED: "Zincire istek gönderilemedi; emir yok",
    ORDER_FAILED: "Emir gönderilemedi", ORDER_STATE_UNKNOWN: "Emir durumu bilinmiyor; vekil durduruldu", TEST_CYCLE: "Test kararı; borsaya gönderilmez",
    HASH_MISMATCH: "Emir özeti tutmuyor", NOT_APPROVED: "Zincirde onay yok", APPROVAL_EXPIRED: "Onayın süresi dolmuş", POLICY_CHANGED: "Kurallar değişti; onay geçersiz",
    EXEC_PAUSED: "Kontrat freni aktif", EXEC_HALTED: "Emir gönderici durduruldu", ALREADY_EXECUTED: "Bu emir zaten gönderildi", EXCEEDS_INVENTORY: "Satış, ajanın aldığından fazla",
    EXIT_IN_PROGRESS: "Bu pozisyon için çıkış zaten sürüyor", ADJUST_INVALID: "Zarar-kes/kâr-al güncellemesi geçersiz",
  },
  field: {
    instIds: "Çiftler", maxOrderQuote: "İşlem başına en fazla (TL)", dailyRiskBudgetQuote: "Günlük risk bütçesi (TL)", maxTradesPerHour: "Saatte en fazla işlem",
    maxTradesPerDay: "Günde en fazla işlem", minStopDistancePct: "En yakın zarar-kes (%)", maxStopDistancePct: "En uzak zarar-kes (%)", maxHoldMin: "En uzun süre (dk)",
    feeBps: "Komisyon (bps)", slippageBps: "Kayma (bps)", validUntil: "Geçerlilik",
  },
};
const tr = (map, k) => (k == null ? "—" : map[k] ?? k);
const reasonText = (codes) => (codes ?? []).map((c) => (typeof c === "object" ? c.tr || tr(TR.reason, c.code) : tr(TR.reason, c))).join(", ");

let state = null;
let proposal = null;
let lastRedteamResult = null;

// ---------------------------------------------------------------- API
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "x-vekil-token": TOKEN, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  // The server makes a new token on every start: a page opened before a restart carries the old one.
  if (res.status === 401) throw new Error("Sunucu yeniden başlatıldı; sayfayı yenileyin (⌘R).");
  if (!res.ok) throw new Error(json.error || `${res.status}`);
  return json;
}
function busy(btn, fn) {
  return async () => {
    btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      showAlert({ tr: "Hata", details: e.message });
    } finally {
      btn.disabled = false;
      renderApplyButton();
    }
  };
}

// ---------------------------------------------------------------- helpers
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids) n.append(k instanceof Node ? k : document.createTextNode(String(k ?? "")));
  return n;
};
const hhmmss = (ms) => new Date(ms).toLocaleTimeString("tr-TR", { timeZone: "Europe/Istanbul" });
const clipText = (s, n = 240) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}… (kısaltıldı)` : s);
const fmtNum = (s) => (s == null ? "—" : String(s).replace(".", ","));
/** TL amounts: 2 decimals, Turkish comma. */
const fmtTl = (s) => (s == null ? "—" : Number(s).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const short = (h) => (h ? `${h.slice(0, 10)}…` : "");
function txLink(hash) {
  if (!hash) return document.createTextNode("");
  const base = state?.chain?.explorerBase;
  if (!base) return el("span", { class: "link" }, short(hash));
  return el("a", { class: "link", href: base + hash, target: "_blank", rel: "noopener" }, short(hash));
}
function msText(ms) {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1).replace(".", ",")} sn` : `${ms} ms`;
}
function showAlert(a) {
  const box = $("alerts");
  box.prepend(el("div", { class: "alert" }, `${a.tr}${a.details ? ": " + clipText(a.details) : ""}`));
  while (box.children.length > 4) box.lastChild.remove();
}

// ---------------------------------------------------------------- state
function renderState(s) {
  state = s;
  $("status").textContent = tr(TR.status, s.status);
  $("status").className = `pill ${s.status}`;
  $("status").title = s.haltReason ?? "";
  $("mode").textContent = tr(TR.mode, s.mode);
  $("chainName").textContent = s.chain?.name ?? "";
  $("brake").classList.toggle("hidden", !s.chain?.paused);
  const addr = s.chain?.policyAddress;
  $("contract").textContent = addr ? `VekilPolicy ${short(addr)}` : "";
  if (addr && s.chain.explorerBase) $("contract").href = s.chain.explorerBase.replace(/\/tx\/$/, "/address/") + addr;
  $("erc8004").classList.toggle("hidden", !s.erc8004?.agentId);
  $("erc8004").textContent = s.erc8004?.agentId ? `ERC-8004 #${s.erc8004.agentId}` : "";

  // Rules
  const p = s.policy;
  $("sourceText").textContent = s.sourceText ? `“${s.sourceText}”` : "Varsayılan kurallar";
  const tbody = $("policyFields");
  tbody.replaceChildren();
  if (p) {
    for (const k of Object.keys(TR.field)) {
      let v = p[k];
      if (k === "instIds") v = v.join(", ");
      const shown = k === "validUntil" ? new Date(v).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }) : fmtNum(v);
      tbody.append(el("tr", {}, el("th", {}, TR.field[k]), el("td", {}, shown)));
    }
  }
  $("policyVersion").textContent = `Sürüm ${s.chain?.policyVersion ?? 0}`;
  $("policyOnChain").textContent = p ? "Zincirde ✓" : "";

  // Plain-language layer
  renderGuide(s);
  $("haltHelp").classList.toggle("hidden", s.status !== "HALTED");
  $("haltHelpUnpause").classList.toggle("hidden", !s.chain?.paused);

  // Agent
  const d = s.agent?.lastDecision;
  renderDecision(d, s.agent?.lastOutcome);
  $("model").textContent = s.agent?.model ? `model: ${s.agent.model}` : "";
  $("pendingNote").textContent = s.agent?.pendingOwnerNote ? `Bekleyen sahip notu: “${s.agent.pendingOwnerNote}”` : "";
  $("btnThink").disabled = s.status !== "RUNNING" || s.agent?.cycleRunning;

  // Positions / today
  const box = $("positions");
  box.replaceChildren();
  const positions = s.executor?.positions ?? [];
  if (!positions.length) box.append(el("p", { class: "muted" }, "Açık pozisyon yok. Vekil alım yaptığında pozisyon burada görünür: zincirde onaylı zarar-kes, kâr-al ve süre sınırıyla. “Pozisyonu kapat” ile istediğin an satabilirsin."));
  for (const pos of positions) {
    const btn = el("button", { class: "danger" }, "Pozisyonu kapat");
    btn.addEventListener("click", busy(btn, async () => {
      const r = await api("POST", "/api/close", { entryOrderHash: pos.entryOrderHash });
      if (r.result === "REFUSED") showAlert({ tr: tr(TR.reason, r.refusal), details: pos.clOrdId });
    }));
    box.append(el("div", { class: "position" },
      el("div", { class: "row" }, el("b", {}, `${pos.instId} ${fmtNum(pos.sz)} @ ${fmtNum(pos.entryPx)}`), el("span", { class: "badge ok" }, "zincirde onaylı"),
        pos.exiting ? el("span", { class: "badge" }, `çıkış: ${tr(TR.exit, pos.exiting.reason)}`) : ""),
      el("div", { class: "muted" }, `Zarar-kes ${fmtNum(pos.stopPx)} · Kâr-al ${fmtNum(pos.tpPx ?? "—")} · Süre ${hhmmss(pos.timeStopAt)}`),
      el("div", { class: "muted" }, `clOrdId ${pos.clOrdId}`),
      el("div", { class: "row" }, btn)));
  }
  const t = s.today ?? {};
  $("realized").textContent = `${fmtTl(t.realizedPnl)} TL`;
  $("unrealized").textContent = `${fmtTl(t.unrealizedPnl)} TL`;
  $("tradesHour").textContent = `${t.tradesUsedHour ?? 0} / ${p?.maxTradesPerHour ?? "—"}`;
  $("tradesDay").textContent = `${t.tradesUsedDay ?? 0} / ${p?.maxTradesPerDay ?? "—"}`;
  $("riskUsed").textContent = `${fmtTl(t.riskUsedToday)} TL`;
  $("riskBudget").textContent = `${fmtTl(t.riskBudget)} TL`;

  // Ledger / anchors
  $("ledgerSeq").textContent = s.ledger?.seq ?? 0;
  $("anchoredSeq").textContent = s.ledger?.lastAnchoredSeq ?? 0;
  refreshProofButtons();

  // Startup
  const su = $("startup");
  su.replaceChildren();
  for (const c of s.startup?.checks ?? []) su.append(el("li", { class: c.ok ? "pass" : c.level }, `${c.id} ${c.tr}${c.details ? " — " + c.details : ""}`));
  for (const a of (s.alerts ?? []).slice(-1)) if (!seenAlerts.has(a.ts + a.code)) {
    seenAlerts.add(a.ts + a.code);
    showAlert(a);
  }
}
const seenAlerts = new Set();

/** One plain sentence: what the agent is doing now and why (SPEC §22 playbooks, in user words). */
const HOLD_WHY = {
  TREND_DOWN: "Piyasa düşüşte. Strateji düşen trendde alım yapmaz, bu yüzden kenarda bekliyor.",
  HIGH_VOLATILITY: "Fiyat çok oynak. Risk yüksek olduğu için bekliyor.",
  NEWS_DRIVEN: "Fiyat haberle hareket ediyor. Yön netleşene kadar bekliyor.",
  UNCLEAR: "Yön belirsiz, kanıt zayıf. Bekliyor.",
  TREND_UP: "Piyasa yükselişte ama uygun giriş noktası henüz oluşmadı. Bekliyor.",
  RANGE: "Fiyat yatay bantta ama alım bölgesinde değil. Bekliyor.",
};
const OUTCOME_SAYS = {
  EXECUTED: "Alım yaptı: kontrat onayladı, emir gönderici zincirden tekrar kontrol edip emri iletti.",
  NOT_FILLED: "Alım istedi, kontrat onayladı ama emir dolmadı (fiyat kaçtı). Para harcanmadı.",
  REJECTED: "Alım istedi ama kontrat reddetti. Nedenler günlükte ve zincirde kayıtlı.",
  LOCAL_BLOCK: "Alım istedi ama ön kontrol durdurdu (piyasa koşulu, bakiye ya da açık pozisyon).",
  ENTRY_ABORTED: "Onay geldi ama emir gönderilmedi; onay kullanılmadan süresi doldu.",
  CHAIN_REQUEST_FAILED: "Zincire ulaşılamadı; güvenlik gereği emir gönderilmedi.",
  LLM_ERROR: "Yapay zekâ servisine ulaşılamadı; 5 dakika sonra tekrar deneyecek.",
  NO_DECISION: "Yapay zekâ bu döngüde karar vermedi; beklemede.",
  INVALID_DECISION: "Yapay zekânın cevabı geçersizdi; güvenlik gereği bekleme sayıldı.",
  CLOSING: "Pozisyonu kapatıyor.",
  ADJUSTED: "Zarar-kesi sıkılaştırdı.",
};
function agentSentence(d, outcome, status) {
  if (status === "HALTED") return "Vekil durduruldu; yeni karar vermiyor. Açık pozisyonlar yine zarar-kes, kâr-al ve süre sınırıyla korunur.";
  if (status === "STARTUP_FAILED") return "Başlangıç kontrollerinden biri geçmedi; vekil karar vermiyor. Aşağıdaki Sistem kartına bak.";
  if (!d) return "Henüz karar yok. İlk döngüyü başlatmak için “Şimdi düşün”e bas.";
  if (outcome && OUTCOME_SAYS[outcome]) return OUTCOME_SAYS[outcome];
  if (d.action === "HOLD") return HOLD_WHY[d.regime] ?? "Şu an alım için yeterli kanıt yok; bekliyor.";
  if (d.action === "BUY") return "Alım kararı verdi; kontrattan onay isteniyor.";
  return `Son karar: ${tr(TR.action, d.action)}.`;
}
function renderDecision(d, outcome) {
  $("agentNow").textContent = agentSentence(d, outcome, state?.status);
  const waiting = state?.status === "RUNNING" && d?.action === "HOLD" && !(state?.executor?.positions ?? []).length;
  $("agentHint").classList.toggle("hidden", !waiting);
  $("agentHint").textContent = waiting
    ? "Bu bir hata değil: vekil yalnızca piyasa uygunsa ve kuralların içindeyse alım yapar. Hemen bir işlem görmek istersen sahip notuna “Kurallar içinde minimum tutarda bir alım değerlendir.” yaz ve “Şimdi düşün”e bas. Son sözü yine kontrat söyler."
    : "";
  $("action").textContent = d ? tr(TR.action, d.action) + (d.instId ? ` ${d.instId}` : "") : "—";
  $("regime").textContent = d ? `Rejim: ${tr(TR.regime, d.regime)}` : "";
  $("playbook").textContent = d ? `Oyun planı: ${tr(TR.playbook, d.playbook)}` : "";
  $("confidence").textContent = d ? `Güven: ${d.confidence}` : "";
  $("outcome").textContent = outcome ? tr(TR.outcome, outcome) : "";
  $("evidence").replaceChildren(...(d?.evidence ?? []).map((e) => el("li", {}, e)));
  $("bull").textContent = d?.scenarios?.bull ?? "";
  $("bear").textContent = d?.scenarios?.bear ?? "";
  $("thesis").textContent = d?.thesis ?? "";
  $("invalidation").textContent = d?.invalidation ?? "";
  $("lesson").textContent = d?.lesson ?? "—";
}

setInterval(() => {
  const at = state?.agent?.nextCheckInAt;
  if (!at || state.status !== "RUNNING") return void ($("countdown").textContent = "—");
  const s = Math.max(0, Math.round((at - Date.now()) / 1000));
  $("countdown").textContent = `${Math.floor(s / 60)} dk ${String(s % 60).padStart(2, "0")} sn sonra (${hhmmss(at).slice(0, 5)})`;
}, 1000);

// ---------------------------------------------------------------- guide
function setStep(n, done, text, bad = false) {
  const li = $(`step${n}`);
  li.classList.toggle("done", done);
  li.classList.toggle("bad", bad);
  $(`step${n}State`).textContent = text;
}
function renderGuide(s) {
  const v = s.chain?.policyVersion ?? 0;
  setStep(1, Boolean(s.sourceText), s.sourceText ? "Yazıldı ✓" : "Henüz varsayılan kurallar");
  setStep(2, v > 0, v > 0 ? `Zincirde ✓ · sürüm ${v}${s.chain?.paused ? " · fren AKTİF" : ""}` : "Bekliyor", Boolean(s.chain?.paused));
  const out = s.agent?.lastOutcome ? tr(TR.outcome, s.agent.lastOutcome) : "henüz karar yok";
  setStep(3, s.status === "RUNNING", s.status === "RUNNING" ? `Çalışıyor · son: ${out}` : tr(TR.status, s.status), s.status !== "RUNNING");
  const seq = s.ledger?.seq ?? 0;
  const anchored = s.ledger?.lastAnchoredSeq ?? 0;
  setStep(4, anchored > 0, `${seq} kayıt · ${anchored}'e kadar zincirde`);
}

// ---------------------------------------------------------------- feed
const feedItems = [];
/** Technical steps hidden unless "Tüm teknik adımları göster" is ticked. */
function isMinor(e) {
  const d = e.data ?? {};
  if (e.type === "tool_call" || e.type === "cycle_start") return true;
  if (e.type === "preflight" && d.route === "NONE") return true;
  if (e.type === "cancel" && !(d.clOrdIds?.length)) return true;
  return false;
}
function feedLine(e) {
  const d = e.data ?? {};
  switch (e.type) {
    case "cycle_start": return ["Döngü", `başladı (${({ schedule: "zamanlanmış", manual: "Şimdi düşün", "redteam-injection": "kandırma testi", "redteam-rogue": "ele geçirilmiş ajan testi" })[d.trigger] ?? d.trigger})`, ""];
    case "tool_call": return ["Araç", `${d.name} ${d.ok ? "" : "✗"} ${d.ms ?? 0} ms${d.injected ? " — enjekte edilmiş metin eklendi" : ""}`, d.ok ? "" : "bad"];
    case "decision": {
      const x = d.decision;
      if (!x) return ["Karar", d.error ? `Yapay zekâ servisine ulaşılamadı: ${d.error}` : "Ajan karar vermedi", "bad"];
      return ["Karar", `${tr(TR.action, x.action)} ${x.instId}${x.quoteAmount ? ` ${x.quoteAmount} TL` : ""}${d.naive ? " (Savunması kapatılmış ajan (test))" : ""} — ${x.thesis}`, ""];
    }
    case "preflight": return ["Piyasa kontrolü", `${d.route === "CHAIN" ? "zincire" : d.route === "LOCAL_BLOCK" ? "YEREL ENGEL" : "emir yok, zincire gerek yok"}${d.reasons?.length ? ": " + reasonText(d.reasons) : ""}${d.suspect ? " (şüpheli → kontrat karar verir)" : ""}`, d.route === "LOCAL_BLOCK" ? "bad" : ""];
    case "chain_request": {
      const fin = d.approvalMs != null ? ` · zincirde ${msText(d.approvalMs)}` : "";
      if (d.status === "APPROVED") return ["Zincir", [`ONAYLANDI${fin} `, txLink(d.txHash)], "ok"];
      if (d.status === "REJECTED") return ["Zincir", [`REDDEDİLDİ: ${reasonText(d.reasons)}${d.critical ? " — Kontrat freni çekti" : ""}${fin} `, txLink(d.txHash)], "bad"];
      return ["Zincir", `Zincire istek gönderilemedi; emir yok (${d.error ?? ""})`, "bad"];
    }
    case "execute": return ["Emir", `${d.result === "FILLED" ? "GERÇEKLEŞTİ" : d.result === "NOT_FILLED" ? "DOLMADI" : d.result === "UNKNOWN" ? "Emir durumu bilinmiyor" : "REDDEDİLDİ: " + tr(TR.reason, d.refusal)} ${d.clOrdId}`, d.result === "FILLED" ? "ok" : "bad"];
    case "fill": return ["Dolum", `${fmtNum(d.accFillSz)} @ ${fmtNum(d.avgPx)}${d.dust ? " (toz)" : ""}`, "ok"];
    case "exit": return ["Çıkış", `${tr(TR.exit, d.reason)}: ${fmtNum(d.soldSz)} @ ${fmtNum(d.avgPx)}, K/Z ${fmtTl(d.pnlQuote)} TL`, ""];
    case "exit_recorded": return ["Zincir", ["Çıkış zincirde kayıtlı ", txLink(d.txHash)], "ok"];
    case "adjust": return ["Zarar-kes", `${fmtNum(d.from?.stopPx)} → ${fmtNum(d.to?.stopPx)}`, ""];
    case "cancel": return ["İptal", `${d.clOrdIds?.length ?? 0} emir (${d.by})${d.clOrdIds?.length ? ": " + d.clOrdIds.join(", ") : ""}`, ""];
    case "pause_seen": return ["Fren", `Kontrat freni AKTİF (${d.by === "executor" ? "emir gönderici" : "çekirdek"} gördü)`, "bad"];
    case "policy": return ["Kurallar", `sürüm ${d.version} (${d.source}) Zincirde ✓`, "ok"];
    case "kill": return ["DURDUR", `Durduruldu: yerel ${msText(d.steps?.localMs)} · emirler ${msText(d.steps?.executorMs)} · zincir ${msText(d.steps?.chainMs)}${d.flattened ? " · pozisyonlar kapatıldı" : ""}`, "bad"];
    case "anchor": return ["Zincire kayıt", [`#${d.fromSeq}–${d.toSeq} arası kayıtların özeti (Merkle kökü) zincire yazıldı `, txLink(d.txHash)], "ok"];
    case "alert": return ["Uyarı", `${d.tr}${d.details ? ": " + clipText(d.details) : ""}`, "bad"];
    case "redteam": return ["Kandırma testi", d.kind === "rogue" ? `${d.id}: ${tr(TR.outcome, d.result?.outcome)}` : "enjeksiyon testi bitti", ""];
    case "ask": return ["Soru", d.answer ?? "", ""];
    default: return null;
  }
}
function addFeed(e) {
  const line = feedLine(e);
  if (!line) return;
  const [k, d, cls] = line;
  const seq = e.data?.seq;
  const x = el("span", { class: "x" });
  if (seq) x.dataset.seq = seq;
  const li = el("li", { class: e.test ? "test" : "" }, el("span", { class: "t" }, hhmmss(e.ts)), el("span", { class: `k ${cls}` }, k + (e.test ? " · TEST" : "")),
    el("span", { class: "d" }, ...(Array.isArray(d) ? d : [d])), x);
  if (isMinor(e)) li.dataset.minor = "1";
  $("feed").prepend(li);
  feedItems.push(x);
  while ($("feed").children.length > 300) $("feed").lastChild.remove();
  refreshProofButtons();
}
function refreshProofButtons() {
  const anchored = state?.ledger?.lastAnchoredSeq ?? 0;
  for (const x of document.querySelectorAll(".feed .x[data-seq]")) {
    const seq = Number(x.dataset.seq);
    const want = seq <= anchored ? "prove" : "pending";
    if (x.dataset.mode === want) continue;
    x.dataset.mode = want;
    x.replaceChildren();
    if (want === "prove") {
      const b = el("button", { class: "outline" }, "Kanıtla");
      b.addEventListener("click", busy(b, () => prove(seq)));
      x.append(b);
    } else {
      const b = el("button", { class: "outline" }, "Şimdi çapala");
      b.title = "henüz zincire yazılmadı";
      b.addEventListener("click", busy(b, () => api("POST", "/api/anchor")));
      x.append(el("span", { class: "muted" }, "henüz zincire yazılmadı "), b);
    }
  }
}
async function prove(seq) {
  const r = await api("POST", "/api/verify", { proveSeq: seq });
  renderVerify(r);
}

// ---------------------------------------------------------------- verify / audit / red-team
function renderVerify(r) {
  const head = r.tamperSeq ? [el("li", { class: "warn" }, `Kurcalama testi: #${r.tamperSeq} kaydının bellekteki kopyası değiştirildi. Gerçek kayıt dosyası değişmedi; gerçek sonuç için "Doğrula".`)] : [];
  $("checks").replaceChildren(...head, ...(r.checks ?? []).map((c) => el("li", { class: c.ok ? "pass" : "fail" }, `${r.tamperSeq ? "[kopya] " : ""}${c.id} ${c.tr}${c.details ? " (" + c.details + ")" : ""}`)));
  const fails = (r.failures ?? []).filter((f) => f.check !== "PROOF");
  const proofFail = (r.failures ?? []).find((f) => f.check === "PROOF");
  if (r.tamperSeq) $("proof").textContent = fails.length ? `Kurcalama yakalandı: #${fails[0].seq}` : "Kurcalama yakalanmadı!";
  else if (r.proof) $("proof").textContent = r.proof.onChainVerified ? `Kanıt zincirde doğrulandı ✓ (#${r.proof.seq}, çapa ${r.proof.anchorIndex}, ${r.proof.proof.length} kardeş)` : `✗ Kanıt doğrulanamadı (#${r.proof.seq})`;
  else if (proofFail) $("proof").textContent = `#${proofFail.seq}: ${proofFail.message}`;
  else $("proof").textContent = fails.map((f) => `#${f.seq ?? "-"} ${f.message}`).join(" · ");
}
function renderAudit(r) {
  $("auditSummary").textContent = `${r.ok ? "Tüm ajan emirleri onaylı" : "Onaysız emir bulundu"} · ${r.checkedOrders} emir · Kaynak: ${r.source}`;
  if (!r.items.length) return void $("auditBody").replaceChildren(el("tr", {}, el("td", { colspan: "4" }, "Son 24 saatte ajan emri yok. İlk onaylı işlemden sonra burada zincirle eşleşmesi görünür.")));
  $("auditBody").replaceChildren(...r.items.map((i) => el("tr", {},
    el("td", {}, i.clOrdId), el("td", {}, i.kind === "MANUAL" ? "manuel (ajan dışı)" : i.kind), el("td", { class: `st-${i.kind === "MANUAL" ? "MANUAL" : i.status}` }, i.status === "PENDING" ? "bekliyor" : i.status), el("td", {}, i.detail))));
}
function renderCycleResult(r, label) {
  const c = r.chain;
  return el("div", { class: "redteam-result" },
    el("div", {}, el("b", {}, label), r.naive ? " · Savunması kapatılmış ajan (test)" : ""),
    r.decision ? el("div", {}, `Karar: ${tr(TR.action, r.decision.action)} ${r.decision.instId}${r.decision.quoteAmount ? " " + r.decision.quoteAmount + " TL" : ""}${r.decision.action === "BUY" && !r.decision.stopPx ? ", zarar-kes yok" : ""}`) : "",
    c ? el("div", { class: c.status === "REJECTED" ? "brake" : "" }, `${c.status === "REJECTED" ? "REDDEDİLDİ" : c.status === "APPROVED" ? "TEST BAŞARISIZ" : c.status}: ${reasonText(c.reasons)}`, " ", txLink(c.txHash)) : "",
    c?.critical ? el("div", { class: "brake" }, "Kontrat freni çekti") : "",
    r.note ? el("div", { class: "muted" }, r.note) : "");
}

// ---------------------------------------------------------------- Text-to-Policy
function renderProposal(p) {
  proposal = p;
  $("proposal").classList.remove("hidden");
  $("summaryTr").textContent = p.summaryTr;
  $("mappingBody").replaceChildren(...p.mapping.map((m) => el("tr", {}, el("td", {}, m.phrase), el("td", {}, TR.field[m.field] ?? m.field), el("td", {}, fmtNum(m.value)))));
  $("assumptions").replaceChildren(...p.assumptions.map((a) => el("li", {}, a)));
  $("assumptionsBox").classList.toggle("hidden", !p.assumptions.length);
  $("questions").replaceChildren(...p.questions.map((q) => el("li", {}, q)));
  $("questionsBox").classList.toggle("hidden", !p.questions.length);
  $("errors").replaceChildren(...p.errors.map((e) => el("li", {}, e)));
  $("acceptAssumptions").checked = false;
  renderApplyButton();
}
function renderApplyButton() {
  const ok = proposal && !proposal.errors.length && (!(proposal.questions.length || proposal.assumptions.length) || $("acceptAssumptions").checked);
  $("btnApply").disabled = !ok;
  $("btnWallet").disabled = !ok;
}
$("acceptAssumptions").addEventListener("change", renderApplyButton);
$("ruleText").addEventListener("input", () => {
  if (proposal) {
    proposal = null;
    $("proposal").classList.add("hidden");
    $("proposeMsg").textContent = "Metin değişti; yeniden dönüştürün.";
  }
});
$("btnPropose").addEventListener("click", busy($("btnPropose"), async () => {
  const text = $("ruleText").value.trim();
  if (!text) return;
  $("proposeMsg").textContent = "Dönüştürülüyor…";
  renderProposal(await api("POST", "/api/policy/propose", { text }));
  $("proposeMsg").textContent = "";
}));
$("btnApply").addEventListener("click", busy($("btnApply"), async () => {
  $("applyMsg").textContent = "Zincire yazılıyor…";
  const r = await api("POST", "/api/policy/apply", { id: proposal.id });
  $("applyMsg").textContent = `Zincirde ✓ sürüm ${r.version}`;
  proposal = null;
  $("proposal").classList.add("hidden");
}));
$("btnWallet").addEventListener("click", busy($("btnWallet"), async () => {
  const r = await api("POST", "/api/policy/apply?wallet=1", { id: proposal.id });
  if (!window.ethereum) throw new Error("Cüzdan bulunamadı");
  const [from] = await window.ethereum.request({ method: "eth_requestAccounts" });
  const tx = await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from, to: r.wallet.to, data: r.wallet.data, chainId: "0x" + r.wallet.chainId.toString(16) }] });
  $("applyMsg").textContent = `Cüzdanla imzalandı: ${short(tx)}`;
}));

// ---------------------------------------------------------------- buttons
$("btnKill").addEventListener("click", busy($("btnKill"), async () => {
  const r = await api("POST", "/api/kill", { pauseOnChain: true });
  $("killTimings").textContent = `DURDURULDU · Yerel ${msText(r.steps.localMs)} · Emirler iptal ${msText(r.steps.executorMs)} · Zincirde fren ${msText(r.steps.chainMs)}`;
}));
$("btnKillFlatten").addEventListener("click", busy($("btnKillFlatten"), async () => {
  const r = await api("POST", "/api/kill", { pauseOnChain: true, flatten: true });
  $("killTimings").textContent = `DURDURULDU ve kapatıldı · Yerel ${msText(r.steps.localMs)} · Emirler iptal ${msText(r.steps.executorMs)} · Zincirde fren ${msText(r.steps.chainMs)}`;
}));
$("btnThink").addEventListener("click", busy($("btnThink"), async () => {
  const r = await api("POST", "/api/think");
  renderDecision(r.decision, r.outcome);
}));
$("btnNote").addEventListener("click", busy($("btnNote"), async () => {
  const text = $("ownerNote").value.trim();
  if (!text) return;
  await api("POST", "/api/owner-note", { text });
  $("ownerNote").value = "";
}));
$("btnInjection").addEventListener("click", busy($("btnInjection"), async () => {
  $("redteam").textContent = "Savunması kapatılmış ajan zararlı haberi okuyor…";
  const r = await api("POST", "/api/redteam/injection");
  lastRedteamResult = r;
  const box = $("redteam");
  box.replaceChildren(renderCycleResult(r.naive, "Zararlı haber enjekte et"));
  if (r.fallback) box.append(renderCycleResult(r.fallback, "Simüle edilmiş ele geçirilmiş ajan"));
}));
$("btnRogue").addEventListener("click", busy($("btnRogue"), async () => {
  const r = await api("POST", "/api/redteam/rogue", { id: "R1" });
  $("redteam").replaceChildren(renderCycleResult(r, "Ele geçirilmiş yapay zekâ (R1)"));
}));
$("btnVerify").addEventListener("click", busy($("btnVerify"), async () => renderVerify(await api("POST", "/api/verify", {}))));
$("btnTamper").addEventListener("click", busy($("btnTamper"), async () => {
  const seq = Math.max(1, (state?.ledger?.lastAnchoredSeq || state?.ledger?.seq || 1) - 1);
  renderVerify({ ...(await api("POST", "/api/verify", { tamperSeq: seq })), tamperSeq: seq });
}));
$("btnAnchor").addEventListener("click", busy($("btnAnchor"), () => api("POST", "/api/anchor")));
$("btnAudit").addEventListener("click", busy($("btnAudit"), async () => renderAudit(await api("GET", "/api/audit"))));

// ---------------------------------------------------------------- SSE
function connect() {
  const es = new EventSource("/api/events");
  const on = (type, fn) => es.addEventListener(type, (m) => {
    try {
      fn(JSON.parse(m.data));
    } catch (err) {
      console.error(err);
    }
  });
  on("state", (e) => renderState(e.data));
  for (const t of ["cycle_start", "tool_call", "decision", "preflight", "chain_request", "execute", "fill", "exit", "exit_recorded", "adjust", "cancel", "pause_seen", "policy", "kill", "anchor", "alert", "ask"]) on(t, addFeed);
  on("redteam", (e) => {
    addFeed(e);
    if (e.data.kind === "injection" && !lastRedteamResult) {
      const box = $("redteam");
      box.replaceChildren(el("div", { class: "muted" }, `Enjekte edilen metin: ${e.data.injection ?? ""}`), renderCycleResult(e.data.naive, "Zararlı haber enjekte et"));
      if (e.data.fallback) box.append(renderCycleResult(e.data.fallback, "Simüle edilmiş ele geçirilmiş ajan"));
    }
  });
  on("verify", (e) => renderVerify(e.data));
  on("audit", (e) => renderAudit(e.data));
  on("decision", (e) => e.data.decision && renderDecision(e.data.decision, null));
  es.onerror = () => {
    es.close();
    setTimeout(connect, 2000);
  };
}
// Backfill the feed from the ledger (oldest first), then go live.
const KIND_EVENT = {
  CYCLE_START: "cycle_start", DECISION: "decision", PREFLIGHT: "preflight", CHAIN_REQUEST: "chain_request", EXECUTE: "execute", FILL: "fill", EXIT: "exit",
  EXIT_RECORDED: "exit_recorded", ADJUST: "adjust", CANCEL: "cancel", PAUSE_SEEN: "pause_seen", POLICY: "policy", KILL: "kill", ANCHOR: "anchor", ASK: "ask", ALERT: "alert",
};
async function backfill() {
  const entries = await api("GET", "/api/ledger?limit=150");
  if (!Array.isArray(entries)) return;
  for (const e of entries) {
    const type = KIND_EVENT[e.kind] ?? (e.kind === "ERROR" ? "alert" : null);
    if (!type) continue;
    const data = e.kind === "ERROR" ? { tr: "Hata", details: `${e.payload.where}: ${e.payload.message}` } : e.payload;
    addFeed({ type, ts: e.ts, cycleId: e.cycleId, test: e.test, data: { ...data, kind: e.kind, seq: e.seq } });
  }
}
api("GET", "/api/state").then(renderState).then(backfill).catch(() => undefined).finally(connect);
$("feedAll").addEventListener("change", (ev) => $("feed").classList.toggle("show-all", ev.target.checked));

// ---------------------------------------------------------------- pages (hash router)
const PAGES = ["panel", "guard", "dogrula", "test"];
function showPage() {
  const raw = location.hash.slice(1) || "panel";
  // A card anchor (e.g. #cardWrite) opens the page that holds it.
  const target = PAGES.includes(raw) ? null : document.getElementById(raw);
  const page = PAGES.includes(raw) ? raw : target?.closest("[data-page]")?.dataset.page ?? "panel";
  for (const m of document.querySelectorAll("main.page")) m.classList.toggle("active", m.dataset.page === page);
  for (const a of document.querySelectorAll("[data-tab]")) a.classList.toggle("active", a.dataset.tab === page);
  document.body.classList.toggle("on-panel", page === "panel");
  if (target) target.scrollIntoView({ block: "start" });
  else if (PAGES.includes(raw) && raw !== "panel") window.scrollTo({ top: 0 });
}
window.addEventListener("hashchange", showPage);
showPage();

// ---------------------------------------------------------------- VEKİL Guard page
const GUARD_PRESETS = {
  ok: () => ({ instId: "AVAX-TRY", px: "490", sz: (Math.min(Number(state?.policy?.maxOrderQuote ?? 75), 75) / 490).toFixed(4), stopPx: "475", tpPx: "520" }),
  rogue: () => ({ instId: "DOGE-TRY", px: "7.007", sz: "1427.14428", stopPx: "", tpPx: "" }),
  wide: () => ({ instId: "AVAX-TRY", px: "490", sz: "0.1", stopPx: "400", tpPx: "520" }),
  big: () => ({ instId: "AVAX-TRY", px: "490", sz: ((Number(state?.policy?.maxOrderQuote ?? 200) * 1.5) / 490).toFixed(4), stopPx: "475", tpPx: "520" }),
};
for (const b of document.querySelectorAll("[data-guard]")) {
  b.addEventListener("click", () => {
    const f = $("guardForm");
    for (const [k, val] of Object.entries(GUARD_PRESETS[b.dataset.guard]())) f.elements[k].value = val;
    f.requestSubmit();
  });
}
$("guardForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const clean = (k) => String(f.get(k) ?? "").trim().replace(",", ".");
  const body = { instId: clean("instId").toUpperCase(), px: clean("px"), sz: clean("sz") };
  for (const k of ["stopPx", "tpPx"]) if (clean(k)) body[k] = clean(k);
  const out = $("guardResult");
  out.replaceChildren(el("p", { class: "muted" }, "Kontrata soruluyor…"));
  try {
    const j = await api("POST", "/api/guard/check", body);
    const ok = j.verdict === "APPROVE";
    const box = el("div", { class: `verdict ${ok ? "ok" : "bad"}` },
      el("div", { class: "big" }, ok ? "ONAYLAR ✓" : "REDDEDER ✗"),
      el("div", {}, `${body.instId} · ${fmtNum(body.sz)} × ${fmtNum(body.px)} TRY = ${fmtTl(j.notional)} TL`));
    if (!ok) box.append(el("ul", {}, ...j.reasons.map((r) => el("li", {}, r.tr))));
    if (j.critical) box.append(el("p", { class: "brake" }, j.wouldPause ? "Kritik ihlal: gerçek bir istek olsaydı kontrat freni kendisi çekerdi ve vekil dururdu." : "Kritik ihlal (fren zaten aktif)."));
    if (ok && j.worstCase) box.append(el("p", {}, `Zarar-kese kadar en kötü kayıp (komisyon dahil): ${fmtTl(j.worstCase)} TL; günlük risk bütçesinden düşülür.`));
    box.append(el("p", { class: "muted" }, `Kurallar sürüm ${j.policyVersion} · blok ${j.chain.blockNumber} · simülasyon: hiçbir şey gönderilmedi.`));
    out.replaceChildren(box);
  } catch (e) {
    out.replaceChildren(el("p", { class: "brake" }, `Hata: ${e.message}`));
  }
});
