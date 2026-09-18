/**
 * 手動任務（contribution_tasks 的一列）什麼時候算做完。
 *
 * 2026-09-18 查到：程式裡只有 no_change 會關任務。政見、人物資料、進度交上去而且已經上線，
 * 任務照樣開著、照樣被派——李四川那題被查了 21 次的根源就在這裡
 * （dispatch.ts 的註解寫「任務要等有貢獻上線才會關」，實際上根本不會關）。
 *
 * 規則：任務底下有一筆「補資料」的貢獻上線，就關掉這個任務（不再派）。
 * 其他還在等票的貢獻不受影響，照樣投票、照樣可以上線——關的只是派工。
 */

type Obj = Record<string, unknown>;

/**
 * 這些任務型別不照上面的規則關：
 * - question：一題最多收 3 份答案（single-answer-guard 管），第一份上線不代表問完了
 * - news_sweep：一次掃 RSS 會交出很多筆，任務本身是週期性的
 * - adjudicate：裁決流程自己關（closeAdjudicationTasks）
 * - roster_check：一個縣市的名單會交出很多筆 candidacy，由 roster_check 型別的貢獻收尾
 */
const KEEP_OPEN_TASK_TYPES: ReadonlySet<string> = new Set(["question", "news_sweep", "adjudicate", "roster_check"]);

/**
 * 這些貢獻型別有自己的收尾，不走這條：
 * no_change 自己會關；adjudication 走裁決；task_suggestion 是「建」任務不是「做」任務；
 * question_answer 歸 question 管；roster_check 自己處理名單任務。
 */
const SELF_CLOSING_CONTRIBUTION_TYPES: ReadonlySet<string> = new Set(["no_change", "adjudication", "task_suggestion", "question_answer", "roster_check"]);

/** 這筆貢獻上線後，它所屬的任務該不該關 */
export function shouldCloseOnApplied(taskType: string | null | undefined, contributionType: string): boolean {
  if (!taskType) return false;
  if (KEEP_OPEN_TASK_TYPES.has(taskType)) return false;
  if (SELF_CLOSING_CONTRIBUTION_TYPES.has(contributionType)) return false;
  return true;
}

/**
 * 貢獻所屬的手動任務 id。task_id 是 contributions 的欄位；舊資料或部分型別放在 payload 裡。
 * auto: 開頭的是即時算出來的缺口，不是資料表裡的一列，沒有東西可關。
 */
export function manualTaskIdOf(row: { task_id?: unknown; payload?: unknown }): string | null {
  const fromColumn = typeof row.task_id === "string" ? row.task_id : null;
  const payload = (row.payload && typeof row.payload === "object" ? row.payload : {}) as Obj;
  const fromPayload = typeof payload.task_id === "string" ? payload.task_id : null;
  const id = (fromColumn ?? fromPayload)?.trim() ?? "";
  if (!id || id.startsWith("auto:")) return null;
  return id;
}
