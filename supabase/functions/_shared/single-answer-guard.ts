/**
 * 收件端擋重複：「只該有一個答案」的任務，同一個來源 IP 已經有一份在排隊，就不再收第二份。
 *
 * 2026-09-15：「同一個 IP 不應該一直發自己的任務，對吧？」
 * #27 已經讓 /next 不再派回同 IP 交過的任務，但代理可以不經 /next 直接打 /report、/contribute。
 * 萬大捷運站那題就被同一個 a-zhen 用兩個工具各答一次。
 *
 * 只擋單一答案型：補政見、名單清查、掃新聞本來就是一次交很多條（李四川那 9 條、新竹市議員那 41 位都是正常的），
 * 那種任務的內容重疊只能靠投票判斷，不是這裡的事。
 */

export const SINGLE_ANSWER_TASK_TYPES: ReadonlySet<string> = new Set([
  "question",        // 公民提問：一個 IP 一份答案
  "progress_stale",  // 查進度：一次回報
  "policy_validity", // 疑似不是政見：移除／更正／無異動三選一
  "profile_gap",     // 補人物資料：一次補齊
]);

/** 在排隊中的狀態（已上線或被退件的不算：上線後缺口本來就會消失，退件後應該讓人重交） */
export const IN_FLIGHT_STATUSES = ["pending", "verified", "disputed"] as const;

/** 自動缺口的 task_id 長這樣：auto:<task_type>:<目標>；手動任務是 uuid，型別要查表 */
export function taskTypeOf(taskId: string, manualTypes: ReadonlyMap<string, string>): string | null {
  if (taskId.startsWith("auto:")) return taskId.split(":")[1] ?? null;
  return manualTypes.get(taskId) ?? null;
}

/**
 * 純函式：這一批裡哪幾筆要擋（回傳被擋的索引）。
 * 已經在排隊的算一份；同一批裡對同一個單一答案型任務交兩份，也只收第一份。
 */
export function blockedSingleAnswerIndexes(
  items: ReadonlyArray<{ task_id?: string | null }>,
  manualTypes: ReadonlyMap<string, string>,
  inFlightTaskIdsFromThisIp: ReadonlySet<string>,
): Set<number> {
  const taken = new Set(inFlightTaskIdsFromThisIp);
  const blocked = new Set<number>();
  items.forEach((item, i) => {
    const taskId = item.task_id;
    if (!taskId) return;
    const type = taskTypeOf(taskId, manualTypes);
    if (!type || !SINGLE_ANSWER_TASK_TYPES.has(type)) return;
    if (taken.has(taskId)) blocked.add(i);
    else taken.add(taskId);
  });
  return blocked;
}
