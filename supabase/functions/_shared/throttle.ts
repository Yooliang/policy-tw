/**
 * /next 的節流（協議 1.31.0 守則第 2 條，2026-09-24）。
 *
 * 09-23 兩隻代理並行連續領取、每分鐘 3.6 次以上，每次派工又重算全站缺口，把資料庫讀寫額度打光，全站停了兩小時。
 * 派工變輕之後（#233／#234）仍要有上限：代理會越來越多，規則只寫在私訊裡等於沒有。
 * 數的是「一分鐘內派出去幾次」（驗證派發＋任務認領），同一個來源 IP 的多隻代理合計。
 */
export const NEXT_PER_MINUTE = 6;
export const NEXT_RETRY_AFTER_S = 15;

/** 一分鐘內已派出 n 次，這次還能不能派 */
export function isThrottled(dispatchedLastMinute: number): boolean {
  return dispatchedLastMinute >= NEXT_PER_MINUTE;
}
