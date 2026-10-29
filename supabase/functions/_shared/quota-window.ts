/**
 * 交件與驗證額度的「時段」（2026-10-29，維護者裁示：額度由每天一份改成每天 6 個時段、各自一份）。
 *
 * 時段＝台北時間（Asia/Taipei，UTC+8，無夏令時間）00／04／08／12／16／20 點起每 4 小時一段；
 * 用量查詢的下限是「現在所在時段的起點」，到了新時段自然歸零。
 * 台北 00:00＝UTC 16:00，8 小時是 4 小時的整數倍，所以時段起點剛好落在 UTC 的 0／4／8／12／16／20 點。
 * 這裡仍明寫「先換成台北時間再切」，不靠這個巧合，測試用獨立的台北日期算法逐案對。
 * 正見（next／contribute／verify）與日本站（jp-next／jp 的 contribute／verify）共用這一個函式。
 * 端點的用量都是對 contributions／contribution_votes 數 created_at。唯讀的 SQL 版（主控台 VM 頁用）是 quota_window_start()／quota_limits()／console_quota_now()
 * （migration 20261029060000），console-quota-now.test.ts 逐案比對這裡的時段與四個上限，改這裡要一起改那邊。
 */

/** 一個時段的長度（小時） */
export const QUOTA_WINDOW_HOURS = 4;
const HOUR_MS = 3_600_000;
const TAIPEI_OFFSET_MS = 8 * HOUR_MS;
const WINDOW_MS = QUOTA_WINDOW_HOURS * HOUR_MS;

/** now 所在時段的起點（含）。 */
export function quotaWindowStart(now: Date = new Date()): Date {
  const taipeiMs = now.getTime() + TAIPEI_OFFSET_MS; // 把台北牆上時間當 UTC 看
  const startTaipei = Math.floor(taipeiMs / WINDOW_MS) * WINDOW_MS;
  return new Date(startTaipei - TAIPEI_OFFSET_MS);
}

/** now 所在時段的終點（不含）＝下一個時段的起點＝額度重置時間。 */
export function quotaWindowEnd(now: Date = new Date()): Date {
  return new Date(quotaWindowStart(now).getTime() + WINDOW_MS);
}

/** 給回應用的兩個欄位：這個時段的起點與重置時間（ISO 8601，UTC）。 */
export function quotaWindowFields(now: Date = new Date()): { window_start: string; window_resets_at: string } {
  return { window_start: quotaWindowStart(now).toISOString(), window_resets_at: quotaWindowEnd(now).toISOString() };
}

/** 台北時間的「HH:MM」，給給人看的說明用（例：重置時間 20:00）。 */
export function taipeiClock(d: Date): string {
  const t = new Date(d.getTime() + TAIPEI_OFFSET_MS);
  return `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
}

/** 距離下次重置還有幾分鐘（無條件進位，至少 1）。 */
export function minutesUntilReset(now: Date = new Date()): number {
  return Math.max(1, Math.ceil((quotaWindowEnd(now).getTime() - now.getTime()) / 60000));
}

export const QUOTA_WINDOW_NOTE = "額度每 4 小時一個時段（台北時間 00／04／08／12／16／20 點起），新時段自動重置";
