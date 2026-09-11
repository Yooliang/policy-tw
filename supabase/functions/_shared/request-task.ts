/**
 * 網站「請 AI 幫忙查」（request-task）的規則：純函式部分可測。
 * kind → task_type／標題／說明；同目標已有 open 任務或對應自動缺口 → already_queued；每 IP 每日 10 次。
 */

export const REQUEST_DAILY_LIMIT_PER_IP = 10;
export const REQUEST_KINDS = ["policy", "profile", "progress"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const KIND_TO_TASK_TYPE: Record<RequestKind, string> = {
  policy: "policy_missing",
  profile: "profile_gap",
  progress: "progress_stale",
};

export function isRequestKind(v: unknown): v is RequestKind {
  return typeof v === "string" && (REQUEST_KINDS as readonly string[]).includes(v);
}

export interface RequestTarget {
  kind: RequestKind;
  politician_id: string | null;
  policy_id: string | null;
  politician_name?: string | null;
  region?: string | null;
  policy_title?: string | null;
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
  }
}

export interface RequestDecisionInput {
  usedToday: number;
  existingOpenTask: { id: string } | null;
  autoGapTaskId: string | null;
}

export type RequestDecision =
  | { action: "rate_limited" }
  | { action: "already_queued"; task_id: string; reason: "open_task" | "auto_gap" }
  | { action: "create" };

/** 純函式：限額 → 已有 open 手動任務 → 已有對應自動缺口 → 建立 */
export function decideRequest(input: RequestDecisionInput): RequestDecision {
  if (input.usedToday >= REQUEST_DAILY_LIMIT_PER_IP) return { action: "rate_limited" };
  if (input.existingOpenTask) return { action: "already_queued", task_id: input.existingOpenTask.id, reason: "open_task" };
  if (input.autoGapTaskId) return { action: "already_queued", task_id: input.autoGapTaskId, reason: "auto_gap" };
  return { action: "create" };
}
