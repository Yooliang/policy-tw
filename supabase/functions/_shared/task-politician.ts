/**
 * 從任務編號拿出「這個任務是關於哪一位」（2026-09-23 W-Policy 回報 d5059957）。
 *
 * profile_gap（補基本資料）的任務編號本身就帶人物 id：`auto:profile_gap:<uuid>`。代理交 politician 補欄位時
 * 常常只帶 name、不帶 politician_id（30 天內 39 筆），落庫就改用姓名去猜身份——同名者存在時會猜成 new，
 * 走 INSERT 建一筆只有學歷經歷的新人物（這次是撞 position NOT NULL 才沒建成）。任務已經說了是誰，就不要再猜。
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PROFILE_GAP_RE = new RegExp(`^auto:profile_gap:(${UUID})$`, "i");

export function politicianIdFromTask(taskId: unknown): string | null {
  if (typeof taskId !== "string") return null;
  const m = PROFILE_GAP_RE.exec(taskId.trim());
  return m ? m[1].toLowerCase() : null;
}

/** politician 型別、沒帶 politician_id、任務是 profile_gap → 補上任務指的那位；其餘原樣回傳 */
export function withTaskPolitician(contributionType: string, payload: unknown, taskId: unknown): unknown {
  if (contributionType !== "politician" || !payload || typeof payload !== "object") return payload;
  const p = payload as Record<string, unknown>;
  if (typeof p.politician_id === "string" && p.politician_id) return payload;
  const pid = politicianIdFromTask(taskId);
  return pid ? { ...p, politician_id: pid } : payload;
}
