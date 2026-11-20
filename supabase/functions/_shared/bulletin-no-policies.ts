/**
 * 公報未填政見（2026-11-20，小良哥）。
 *
 * 起因：2026 台南市長 1 號蕭燐洪，選舉公報政見欄是一張「我都八十四歲了，只求正寢，沒有政見」的圖，
 * 沒有任何政策條目。站上他 0 條政見，補政見的任務永遠派不完、「已抄／應有」永遠少 1。
 *
 * 做法：no_change 交件帶 `finding_kind: "bulletin_no_policies"`（只在 outcome=confirmed、checked_urls
 * 有中選會公報網址時收），任務是補政見卡（auto:policy_missing／auto:term_policy_missing）時，
 * 通過後把 politician_elections.no_policies_at／no_policies_source_url 寫起來：
 *   派工不再重派這個人這一屆、報表算「已抄」、人物頁顯示一句「公報未填政見」。
 * 不是補政見卡的 no_change 照舊只關任務；驗證門檻沿用 no_change 既有規則（confirmed 要同儕驗證）。
 * 回滾與還原：欄位寫入走 edit_history，可整筆還原；migration 檔頭有 DROP 欄的回滾。
 */

export const BULLETIN_NO_POLICIES = "bulletin_no_policies";

/** 中選會選舉公報站（地方 eebulletin、中央 bulletin） */
const BULLETIN_HOSTS = new Set(["eebulletin.cec.gov.tw", "bulletin.cec.gov.tw"]);

export function isBulletinUrl(url: string): boolean {
  try {
    return BULLETIN_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** checked_urls 裡第一個公報網址；沒有就 null（出處＝它） */
export function firstBulletinUrl(urls: unknown): string | null {
  if (!Array.isArray(urls)) return null;
  for (const u of urls) if (typeof u === "string" && isBulletinUrl(u)) return u;
  return null;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export interface BulletinCard {
  politician_id: string;
  /** auto:term_policy_missing 的 task_id 自帶屆別；auto:policy_missing 是當屆，由呼叫端查 campaign_election_id() */
  election_id: number | null;
}

/** 是不是補政見的自動缺口卡（公報抄錄卡）；不是就 null */
export function parseBulletinCard(taskId: string): BulletinCard | null {
  const term = new RegExp(`^auto:term_policy_missing:(${UUID}):([0-9]{1,6})$`, "i").exec(taskId);
  if (term) return { politician_id: term[1].toLowerCase(), election_id: Number(term[2]) };
  const cur = new RegExp(`^auto:policy_missing:(${UUID})$`, "i").exec(taskId);
  if (cur) return { politician_id: cur[1].toLowerCase(), election_id: null };
  return null;
}
