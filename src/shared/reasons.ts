// Reason codes (SPEC §9.4) with Turkish labels (Appendix B).

/** On-chain policy reasons. The array index is the bit in the uint32 mask. */
export const POLICY_REASONS = [
  "PAUSED",
  "POLICY_EXPIRED",
  "INSTRUMENT_NOT_ALLOWED",
  "SIDE_NOT_ALLOWED",
  "ZERO_VALUE",
  "ORDER_TOO_LARGE",
  "STOP_MISSING",
  "STOP_INVALID",
  "STOP_TOO_TIGHT",
  "STOP_TOO_WIDE",
  "TP_INVALID",
  "TIME_STOP_INVALID",
  "HOURLY_LIMIT",
  "DAILY_LIMIT",
  "RISK_BUDGET_EXCEEDED",
] as const;
export type PolicyReason = (typeof POLICY_REASONS)[number];

export const policyReasonBit = (r: PolicyReason): number => POLICY_REASONS.indexOf(r);

/** INSTRUMENT_NOT_ALLOWED | SIDE_NOT_ALLOWED | STOP_MISSING, plus the 2× notional rule. */
export const CRITICAL_MASK = (1 << 2) | (1 << 3) | (1 << 6);
const ALL_MASK = (1 << POLICY_REASONS.length) - 1;

export function reasonsToMask(reasons: readonly PolicyReason[]): number {
  let m = 0;
  for (const r of reasons) m |= 1 << policyReasonBit(r);
  return m;
}

/** Mask → reasons in bit order. Throws on unknown bits. */
export function maskToReasons(mask: number): PolicyReason[] {
  if (!Number.isSafeInteger(mask) || mask < 0 || (mask & ~ALL_MASK) !== 0) throw new Error(`unknown reason bits: ${mask}`);
  return POLICY_REASONS.filter((_, i) => (mask & (1 << i)) !== 0);
}

/**
 * Same rule as the contract: critical if any CRITICAL_MASK bit is set, or notional > 2 × maxOrderQuote.
 * Amounts are ×1e8 integers.
 */
export function isCritical(mask: number, notionalScaled?: bigint, maxOrderQuoteScaled?: bigint): boolean {
  if ((mask & CRITICAL_MASK) !== 0) return true;
  return notionalScaled !== undefined && maxOrderQuoteScaled !== undefined && notionalScaled > 2n * maxOrderQuoteScaled;
}

export const LOCAL_REASONS = [
  "HALTED",
  "POLICY_PAUSED",
  "CHAIN_STATE_STALE",
  "MARKET_DATA_MISSING",
  "INSTRUMENT_NOT_LIVE",
  "STALE_MARKET_DATA",
  "SPREAD_TOO_WIDE",
  "POSITION_ALREADY_OPEN",
  "PRICE_FAR_FROM_MARKET",
  "ORDER_BELOW_MIN_SIZE",
  "INSUFFICIENT_BALANCE",
  "COOLDOWN_ACTIVE",
  "NO_POSITION",
  "STOP_LOOSENED",
  "STOP_ABOVE_MARKET",
  "TP_BELOW_MARKET",
] as const;
export type LocalReason = (typeof LOCAL_REASONS)[number];

export const PIPELINE_CODES = [
  "INVALID_DECISION",
  "NO_DECISION",
  "LLM_ERROR",
  "CHAIN_REQUEST_FAILED",
  "ORDER_FAILED",
  "ORDER_STATE_UNKNOWN",
  "TEST_CYCLE",
] as const;
export type PipelineCode = (typeof PIPELINE_CODES)[number];

export const EXECUTOR_REFUSALS = [
  "HASH_MISMATCH",
  "NOT_APPROVED",
  "APPROVAL_EXPIRED",
  "POLICY_CHANGED",
  "EXEC_PAUSED",
  "EXEC_HALTED",
  "ALREADY_EXECUTED",
  "EXCEEDS_INVENTORY",
  "EXIT_IN_PROGRESS",
  "ADJUST_INVALID",
] as const;
export type ExecutorRefusal = (typeof EXECUTOR_REFUSALS)[number];

/** Exit reasons; the on-chain code is index + 1. */
export const EXIT_REASONS = ["AGENT_CLOSE", "STOP_HIT", "TP_HIT", "TIME_STOP", "KILL_FLATTEN", "OWNER_CLOSE"] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

export const exitReasonCode = (r: ExitReason): number => EXIT_REASONS.indexOf(r) + 1;
export function exitReasonFromCode(code: number): ExitReason {
  const r = EXIT_REASONS[code - 1];
  if (!Number.isInteger(code) || r === undefined) throw new Error(`bad exit reason code: ${code}`);
  return r;
}

export type ReasonCode = PolicyReason | LocalReason | PipelineCode | ExecutorRefusal;

const POLICY_TR: Record<PolicyReason, string> = {
  PAUSED: "Kontrat freni aktif",
  POLICY_EXPIRED: "Kuralların süresi dolmuş",
  INSTRUMENT_NOT_ALLOWED: "Bu çift izinli değil",
  SIDE_NOT_ALLOWED: "Bu yönde işlem izinli değil",
  ZERO_VALUE: "Fiyat veya miktar sıfır",
  ORDER_TOO_LARGE: "İşlem tutarı limiti aşıyor",
  STOP_MISSING: "Zarar-kes yok",
  STOP_INVALID: "Zarar-kes seviyesi geçersiz",
  STOP_TOO_TIGHT: "Zarar-kes çok yakın",
  STOP_TOO_WIDE: "Zarar-kes çok uzak",
  TP_INVALID: "Kâr-al seviyesi geçersiz",
  TIME_STOP_INVALID: "Süre sınırı geçersiz",
  HOURLY_LIMIT: "Saatlik işlem sınırı doldu",
  DAILY_LIMIT: "Günlük işlem sınırı doldu",
  RISK_BUDGET_EXCEEDED: "Günlük risk bütçesi aşılır",
};

const LOCAL_TR: Record<LocalReason, string> = {
  HALTED: "Vekil durduruldu",
  POLICY_PAUSED: "Kontrat freni aktif",
  CHAIN_STATE_STALE: "Zincir durumu alınamadı veya eski",
  MARKET_DATA_MISSING: "Piyasa verisi alınamadı",
  INSTRUMENT_NOT_LIVE: "Çift şu an işleme kapalı",
  STALE_MARKET_DATA: "Piyasa verisi eski",
  SPREAD_TOO_WIDE: "Alış-satış farkı çok açık",
  POSITION_ALREADY_OPEN: "Zaten açık pozisyon var",
  PRICE_FAR_FROM_MARKET: "Fiyat piyasadan çok uzak",
  ORDER_BELOW_MIN_SIZE: "Tutar borsanın alt sınırının altında",
  INSUFFICIENT_BALANCE: "Bakiye yetersiz",
  COOLDOWN_ACTIVE: "Kayıptan sonra bekleme süresi",
  NO_POSITION: "Kapatılacak pozisyon yok",
  STOP_LOOSENED: "Zarar-kes sadece sıkılaştırılabilir",
  STOP_ABOVE_MARKET: "Zarar-kes piyasanın üstünde",
  TP_BELOW_MARKET: "Kâr-al piyasanın altında",
};

const PIPELINE_TR: Record<PipelineCode, string> = {
  INVALID_DECISION: "Karar biçimi geçersiz",
  NO_DECISION: "Ajan karar vermedi",
  LLM_ERROR: "Yapay zekâ servisine ulaşılamadı",
  CHAIN_REQUEST_FAILED: "Zincire istek gönderilemedi; emir yok",
  ORDER_FAILED: "Emir gönderilemedi",
  ORDER_STATE_UNKNOWN: "Emir durumu bilinmiyor; vekil durduruldu",
  TEST_CYCLE: "Test kararı; borsaya gönderilmez",
};

const EXECUTOR_TR: Record<ExecutorRefusal, string> = {
  HASH_MISMATCH: "Emir özeti tutmuyor",
  NOT_APPROVED: "Zincirde onay yok",
  APPROVAL_EXPIRED: "Onayın süresi dolmuş",
  POLICY_CHANGED: "Kurallar değişti; onay geçersiz",
  EXEC_PAUSED: "Kontrat freni aktif",
  EXEC_HALTED: "Emir gönderici durduruldu",
  ALREADY_EXECUTED: "Bu emir zaten gönderildi",
  EXCEEDS_INVENTORY: "Satış, ajanın aldığından fazla",
  EXIT_IN_PROGRESS: "Bu pozisyon için çıkış zaten sürüyor",
  ADJUST_INVALID: "Zarar-kes/kâr-al güncellemesi geçersiz",
};

export const EXIT_REASON_TR: Record<ExitReason, string> = {
  AGENT_CLOSE: "Ajan kapattı",
  STOP_HIT: "Zarar-kes tetiklendi",
  TP_HIT: "Kâr-al tetiklendi",
  TIME_STOP: "Süre doldu",
  KILL_FLATTEN: "Durdurup kapattı",
  OWNER_CLOSE: "Sahip kapattı",
};

export const REASON_TR: Record<ReasonCode, string> = { ...POLICY_TR, ...LOCAL_TR, ...PIPELINE_TR, ...EXECUTOR_TR };

export function reasonTr(code: string): string {
  return (REASON_TR as Record<string, string>)[code] ?? code;
}

/** Reasons are sent to the UI as { code, tr } pairs (SPEC §19). */
export function withTr(codes: readonly string[]): { code: string; tr: string }[] {
  return codes.map((code) => ({ code, tr: reasonTr(code) }));
}
