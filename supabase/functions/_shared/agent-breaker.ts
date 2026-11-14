/**
 * /next 的兩條派工規則（migration 20261114080000，docs/decisions/2026-11-14-代理斷路器與skip冷卻.md）：
 *   ② 代理斷路器：視窗內領走多件、一件都沒回報 → 暫停派工（SQL agent_breaker_state 現算）
 *   ③ 同一代理重派冷卻：被派過、之後沒回報（含 skip）的件，冷卻期內不再派給同一個代理；所有可派的件都在冷卻中時，告訴代理最早幾秒後解凍
 * 這支只放「把 SQL 結果變成回應欄位」的純函式；判斷本身都在資料庫。
 * 函式還沒上線或查詢失敗時一律當成「沒事」（不擋派工）：呼叫端記 log 後照常派。
 */

export type BreakerState = {
  paused: boolean;
  retry_after_seconds: number;
  paused_until: string | null;
  leases: number;
  reports: number;
  window_seconds: number;
  min_leases: number;
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

/** rpc("agent_breaker_state") 回的是一列（TABLE 回傳）；不是預期的形狀就回 null（當成沒暫停） */
export function parseBreakerState(data: unknown): BreakerState | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (typeof r.paused !== "boolean") return null;
  return {
    paused: r.paused,
    retry_after_seconds: Math.max(0, num(r.retry_after_seconds)),
    paused_until: typeof r.paused_until === "string" ? r.paused_until : null,
    leases: num(r.leases),
    reports: num(r.reports),
    window_seconds: num(r.window_seconds),
    min_leases: num(r.min_leases),
  };
}

const hoursOrMinutes = (sec: number): string => (sec >= 5400 ? `${Math.round(sec / 3600)} 小時` : `${Math.max(1, Math.round(sec / 60))} 分鐘`);

/** 暫停中的 /next 回應欄位（接在 base 後面）：kind:"none" 沿用既有的空回應，加 paused 與 retry_after_seconds */
export function pausedFields(s: BreakerState): Record<string, unknown> {
  const wait = hoursOrMinutes(s.retry_after_seconds);
  return {
    kind: "none",
    paused: true,
    reason: `你已暫停領任務：最近 ${hoursOrMinutes(s.window_seconds)}內領走了 ${s.leases} 件，沒有任何回報（交件、投票、skip 都算回報）。請先把手上領的做完並回報，${wait}後再來`,
    retry_after_min: Math.max(1, Math.ceil(s.retry_after_seconds / 60)),
    retry_after_seconds: s.retry_after_seconds,
    paused_until: s.paused_until,
    breaker: { window_seconds: s.window_seconds, leases: s.leases, reports: s.reports, min_leases: s.min_leases },
  };
}

/** 所有可派的件都在這個代理的重派冷卻中（被派過沒回報、skip 過）：回 kind:"none" 並給最早解凍的秒數；thaw 不是正整數（沒有冷卻中的件）回 null */
export function redispatchCooldownFields(thawSeconds: unknown): Record<string, unknown> | null {
  const sec = typeof thawSeconds === "number" ? thawSeconds : Number(thawSeconds);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const s = Math.ceil(sec);
  return {
    kind: "none",
    reason: `目前沒有適合你的任務（你領過或跳過的件還在冷卻中）；最早 ${hoursOrMinutes(s)}後解凍，到時再來`,
    retry_after_min: Math.max(1, Math.ceil(s / 60)),
    retry_after_seconds: s,
    redispatch_cooldown: true,
  };
}
