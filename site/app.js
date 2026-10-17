// VEKİL public page. Reads the contract straight from the browser (keyless) and asks the Guard API to simulate orders.
import * as viem from "https://esm.sh/viem@2.57.7";
import { DEFAULTS, makeVekil, withTr } from "./lib/vekil.js";

const v = makeVekil(viem);
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, val] of Object.entries(attrs)) k === "class" ? (n.className = val) : n.setAttribute(k, val);
  for (const k of kids) n.append(k instanceof Node ? k : document.createTextNode(String(k ?? "")));
  return n;
};
const tl = (s) => Number(s).toLocaleString("tr-TR", { maximumFractionDigits: 2 });
const num = (s) => String(s).replace(".", ",");
const link = (href, text) => el("a", { href, target: "_blank", rel: "noopener" }, text);
const short = (h) => `${h.slice(0, 10)}…`;

$("contractLink").href = `${DEFAULTS.explorer}/address/${DEFAULTS.address}`;

let policy = null;
async function loadPolicy() {
  try {
    const r = await fetch("/api/policy");
    const p = r.ok ? await r.json() : { ...(await v.policy()), sourceText: null };
    policy = p;
    $("live").textContent = p.paused ? "Kontrat freni AKTİF" : "canlı · zincirde";
    $("live").className = `pill ${p.paused ? "bad" : "ok"}`;
    $("sourceText").textContent = p.sourceText ? `“${p.sourceText.replace(/^[“"]+|[”"]+$/g, "")}”` : "Sahibin Türkçe metni PolicySet olayında saklanır.";
    const q = p.policy;
    const rows = [
      ["Çiftler", q.instIds.join(", ")],
      ["İşlem başına en fazla", `${tl(q.maxOrderQuote)} TL`],
      ["Günlük risk bütçesi", `${tl(q.dailyRiskBudgetQuote)} TL`],
      ["Zarar-kes aralığı", `%${num(q.minStopDistancePct)} – %${num(q.maxStopDistancePct)}`],
      ["Saatte / günde en fazla işlem", `${q.maxTradesPerHour} / ${q.maxTradesPerDay}`],
      ["En uzun süre", `${q.maxHoldMin} dk`],
      ["Geçerlilik", new Date(q.validUntil).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })],
    ];
    $("rules").replaceChildren(el("caption", {}, `Kurallar · sürüm ${p.policyVersion}`), ...rows.map(([k, val]) => el("tr", {}, el("th", {}, k), el("td", {}, val))));
    const c = p.counters;
    $("today").replaceChildren(el("caption", {}, "Bugün (zincirdeki sayaçlar)"),
      el("tr", {}, el("th", {}, "Bu saat işlem"), el("td", {}, `${c.tradesInHour} / ${q.maxTradesPerHour}`)),
      el("tr", {}, el("th", {}, "Bugün işlem"), el("td", {}, `${c.tradesInDay} / ${q.maxTradesPerDay}`)),
      el("tr", {}, el("th", {}, "Kullanılan risk"), el("td", {}, `${tl(c.riskUsedToday)} / ${tl(q.dailyRiskBudgetQuote)} TL`)),
      el("tr", {}, el("th", {}, "Kontrat freni"), el("td", {}, p.paused ? "AKTİF" : "kapalı")),
      el("tr", {}, el("th", {}, "Zincire mühürlenen kayıt"), el("td", {}, `#${p.lastAnchoredSeq}'e kadar`)));
    $("chainMeta").replaceChildren("Avalanche Fuji · kontrat ", link(`${DEFAULTS.explorer}/address/${p.contract}`, short(p.contract)),
      " · ajan cüzdanı ", link(`${DEFAULTS.explorer}/address/${p.agent}`, short(p.agent)),
      ...(p.policySetTx ? [" · ", link(p.policySetTx, "kuralın zincirdeki işlemi ↗")] : []), ` · blok ${p.blockNumber}`);
    $("erc").textContent = p.erc8004AgentId > 0 ? `ERC-8004 ajan kimliği #${p.erc8004AgentId}` : "";
  } catch (e) {
    $("live").textContent = "zincire ulaşılamadı";
    $("live").className = "pill bad";
    console.error(e);
  }
}

// ---- Kontrata sor
const PRESETS = {
  ok: () => ({ instId: "AVAX-TRY", px: "490", sz: (Math.min(Number(policy?.policy.maxOrderQuote ?? 75), 75) / 490).toFixed(4), stopPx: "475", tpPx: "520" }),
  rogue: () => ({ instId: "DOGE-TRY", px: "7.007", sz: "1427.14428", stopPx: "", tpPx: "" }),
  wide: () => ({ instId: "AVAX-TRY", px: "490", sz: "0.1", stopPx: "400", tpPx: "520" }),
  big: () => ({ instId: "AVAX-TRY", px: "490", sz: ((Number(policy?.policy.maxOrderQuote ?? 200) * 1.5) / 490).toFixed(4), stopPx: "475", tpPx: "520" }),
};
for (const b of document.querySelectorAll("[data-preset]")) {
  b.addEventListener("click", () => {
    const f = $("checkForm");
    for (const [k, val] of Object.entries(PRESETS[b.dataset.preset]())) f.elements[k].value = val;
    f.requestSubmit();
  });
}
$("checkForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const body = { instId: String(f.get("instId")).trim().toUpperCase(), px: String(f.get("px")).trim().replace(",", "."), sz: String(f.get("sz")).trim().replace(",", ".") };
  for (const k of ["stopPx", "tpPx"]) {
    const val = String(f.get(k)).trim().replace(",", ".");
    if (val) body[k] = val;
  }
  const out = $("result");
  out.replaceChildren(el("p", { class: "muted" }, "Kontrata soruluyor…"));
  try {
    const r = await fetch("/api/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = r.ok || r.status === 400 ? await r.json() : await v.check(body);
    if (j.error) throw new Error(j.error);
    renderCheck(j, body);
  } catch (e) {
    out.replaceChildren(el("p", { class: "bad" }, `Hata: ${e.message}`));
  }
});
function renderCheck(j, body) {
  const ok = j.verdict === "APPROVE";
  const box = el("div", { class: `verdict ${ok ? "ok" : "bad"}` },
    el("div", { class: "big" }, ok ? "ONAYLAR ✓" : "REDDEDER ✗"),
    el("div", {}, `${body.instId} · ${num(body.sz)} × ${num(body.px)} TRY = ${tl(j.notional)} TL`));
  if (!ok) box.append(el("ul", {}, ...withTr(j.reasons.map((x) => x.code)).map((x) => el("li", {}, x.tr))));
  if (j.critical) box.append(el("p", { class: "brake" }, j.wouldPause ? "Kritik ihlal: gerçek bir istek olsaydı kontrat freni kendisi çekerdi ve ajan dururdu." : "Kritik ihlal (fren zaten aktif)."));
  if (ok && j.worstCase) box.append(el("p", {}, `Zarar-kese kadar en kötü kayıp (komisyon dahil): ${tl(j.worstCase)} TL. Günlük risk bütçesinden düşülür.`));
  box.append(el("p", { class: "muted small" }, `Kurallar sürüm ${j.policyVersion} · blok ${j.chain.blockNumber} · simülasyon: hiçbir şey gönderilmedi.`));
  $("result").replaceChildren(box);
}

// ---- Kanıtlar
async function loadProofs() {
  try {
    const data = await (await fetch("proofs.json")).json();
    // Proofs belong to one contract: verify against that one, whatever the page default is.
    const pv = data.contract && data.contract !== v.address ? makeVekil(viem, { address: data.contract }) : v;
    const rows = data.items.slice().reverse().map((it) => {
      const btn = el("button", {}, "Zincirde doğrula");
      const cell = el("td", {}, btn);
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "soruluyor…";
        try {
          const ok = await pv.verifyProof(it.anchorIndex, it.entryHash, it.proof);
          cell.replaceChildren(el("span", { class: ok ? "ok" : "bad" }, ok ? `✓ Kontrat doğruladı (mühür #${it.anchorIndex})` : "✗ doğrulanamadı"));
        } catch (e) {
          cell.replaceChildren(el("span", { class: "bad" }, `Hata: ${e.message}`));
        }
      });
      const when = new Date(it.ts).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
      return el("tr", {}, el("td", {}, `#${it.seq} · ${when}`), el("td", {}, `${it.test ? "TEST · " : ""}${it.summary}`),
        el("td", {}, it.txHash ? link(`${DEFAULTS.explorer}/tx/${it.txHash}`, short(it.txHash)) : "—"), cell);
    });
    $("proofs").replaceChildren(...rows);
  } catch {
    $("proofs").replaceChildren(el("tr", {}, el("td", { colspan: "4" }, "Kanıt listesi yüklenemedi.")));
  }
}

$("auditForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const id = String(new FormData(ev.target).get("clOrdId")).trim();
  const out = $("auditResult");
  out.replaceChildren(el("p", { class: "muted" }, "Zincirde aranıyor…"));
  try {
    const r = await fetch(`/api/audit?clOrdId=${encodeURIComponent(id)}`);
    const j = r.ok ? await r.json() : await v.audit(id);
    if (j.error) throw new Error(j.error);
    const good = j.approved === true || j.recorded === true;
    out.replaceChildren(el("div", { class: `verdict ${good ? "ok" : j.kind === "MANUAL" ? "" : "bad"}` },
      el("div", { class: "big" }, good ? "Zincirde onaylı ✓" : j.kind === "MANUAL" ? "Ajan emri değil" : "Zincirde onay YOK ✗"),
      el("div", {}, j.detail), j.orderHash ? el("p", { class: "muted small" }, `onay özeti ${j.orderHash}`) : ""));
  } catch (e) {
    out.replaceChildren(el("p", { class: "bad" }, `Hata: ${e.message}`));
  }
});

loadPolicy();
loadProofs();
setInterval(loadPolicy, 30_000);
