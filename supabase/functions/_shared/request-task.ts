/**
 * 網站「請 AI 幫忙查」（request-task）的規則：純函式部分可測。
 * kind → task_type／標題／說明；同目標已有同型別 open 任務或對應自動缺口 → already_queued；每 IP 每日 20 次。
 * kind=audit（政見深度分析頁貼文件網址）：同一網址＋同一目標 24 小時內只建一筆。
 *
 * 政見頁與人物頁的按鈕（查進度／查兌現情形／查政見／查簡介／這不是政見？）都走這裡：
 * 按下去就建任務、出現在任務頁（2026-09-18 起是 /tasks），不再跳去公民提問填文字。
 * 2026-09-15：「這些因該出現在 ai-assistant?tab=tasks，我之前提出的講錯了」「不用人填文字」。
 * 公民提問（/community）只留民眾自己打字問的題目。
 */

/**
 * 每個來源 IP 每日幾次。沿用公民提問放寬後的 20：按鈕原本在 ask 端點上就是 20 次，
 * 搬回這條路不該反而變緊；同目標同型別已有任務會回 already_queued、不佔新的一筆。
 */
export const REQUEST_DAILY_LIMIT_PER_IP = 20;
export const REQUEST_KINDS = ["policy", "profile", "progress", "validity", "audit"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export const AUDIT_URL_MAX = 500;
export const AUDIT_NOTE_MAX = 500;

export const KIND_TO_TASK_TYPE: Record<RequestKind, string> = {
  policy: "policy_missing",
  profile: "profile_gap",
  progress: "progress_stale",
  validity: "policy_validity",
  audit: "audit",
};

/** 這些 kind 一定要帶 policy_id（其餘的 policy／profile 要帶 politician_id） */
export const POLICY_KINDS: readonly RequestKind[] = ["progress", "validity"];

export function isRequestKind(v: unknown): v is RequestKind {
  return typeof v === "string" && (REQUEST_KINDS as readonly string[]).includes(v);
}

/** 訪客貼的文件網址：只收 http(s)、可被 URL 解析、長度上限 */
export function isAuditUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.length > AUDIT_URL_MAX) return false;
  try {
    const u = new URL(v.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export interface RequestTarget {
  kind: RequestKind;
  politician_id: string | null;
  policy_id: string | null;
  politician_name?: string | null;
  region?: string | null;
  policy_title?: string | null;
  source_url?: string | null;
  note?: string | null;
}

/** 組給代理看的標題與說明（人話） */
export function buildRequestTaskText(t: RequestTarget): { title: string; description: string; hint_sources: string[] } {
  const who = t.politician_name ? `「${t.politician_name}」` : "這位政治人物";
  switch (t.kind) {
    case "policy":
      return {
        title: `補${who}的政見（網站訪客請求）`,
        description: `有人在網站上按了「請 AI 幫忙查政見」。請找${who}任何有出處的具體政見：2026 選舉政見優先，找得到現任任期或過去選舉的承諾也可提交，election_id 填該政見所屬選舉並在 note 說明。`,
        hint_sources: ["候選人官網／官方社群的政見頁", "cec.gov.tw 選舉公報", "cna.com.tw", "pts.org.tw"],
      };
    case "profile":
      return {
        title: `補${who}的基本資料（網站訪客請求）`,
        description: `有人在網站上按了「請 AI 幫忙查資料」。請補${who}的出生年、現職、學歷、官方照片網址（只補查得到的），用 politician 型別提交。`,
        hint_sources: ["db.cec.gov.tw 候選人資料", "所屬機關官網", "ly.gov.tw 立委個人頁"],
      };
    case "progress":
      return {
        title: `追蹤政見「${t.policy_title ?? "（見 target）"}」的進度（網站訪客請求）`,
        description: `有人在網站上按了「請 AI 追進度」。請查${who}政見「${t.policy_title ?? ""}」的最新執行狀況（施政報告、議會／立法院紀錄、新聞），用 policy_progress 型別回報，附日期與出處。`,
        hint_sources: ["縣市政府施政報告（*.gov.tw）", "ly.gov.tw 議事錄", "議會官網", "cna.com.tw"],
      };
    case "validity":
      return {
        title: `查證「${t.policy_title ?? "（見 target）"}」是不是政見（網站訪客請求）`,
        description: `有人在網站上按了「這不是政見？」，覺得${who}的「${t.policy_title ?? ""}」不像政見（比較像個人表態、行程或活動紀錄）。請查證原始出處後三選一：整筆不該存在用 removal／分類或狀態標錯用 correction／其實是有效的承諾用 no_change 並在 note 說明查到什麼。`,
        hint_sources: ["這筆政見自己的 source_url", "候選人官網／官方社群", "cna.com.tw"],
      };
    case "audit": {
      const url = t.source_url ?? "";
      const context = t.policy_title
        ? `，頁面情境是${who}的政見「${t.policy_title}」`
        : t.politician_name ? `，頁面情境是${who}` : "";
      const note = t.note ? `訪客備註：${t.note}。` : "";
      return {
        title: `核對這份文件與相關政見的落差（網站訪客請求）`,
        description: `有人在政見深度分析頁貼了文件網址 ${url}${context}。${note}請打開這份文件，核對其內容與我們資料庫既有的相關政見／進度是否一致；不一致就提 correction 或 policy_progress，一致就用 no_change 回報無異動。`,
        hint_sources: url ? [url] : [],
      };
    }
  }
}

export interface RequestDecisionInput {
  usedToday: number;
  existingOpenTask: { id: string } | null;
  autoGapTaskId: string | null;
  /** kind=audit：24 小時內同網址＋同目標已建過的任務 */
  duplicateAuditTask?: { id: string } | null;
}

export type RequestDecision =
  | { action: "rate_limited" }
  | { action: "already_queued"; task_id: string; reason: "open_task" | "auto_gap" | "duplicate_url" }
  | { action: "create" };

/** 純函式：限額 → 已有 open 手動任務 → 已有對應自動缺口 → 同網址重複 → 建立 */
export function decideRequest(input: RequestDecisionInput): RequestDecision {
  if (input.usedToday >= REQUEST_DAILY_LIMIT_PER_IP) return { action: "rate_limited" };
  if (input.existingOpenTask) return { action: "already_queued", task_id: input.existingOpenTask.id, reason: "open_task" };
  if (input.autoGapTaskId) return { action: "already_queued", task_id: input.autoGapTaskId, reason: "auto_gap" };
  if (input.duplicateAuditTask) return { action: "already_queued", task_id: input.duplicateAuditTask.id, reason: "duplicate_url" };
  return { action: "create" };
}
