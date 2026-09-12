/**
 * GET /next 的派工決策（純函式，可測）。
 *
 * 比例：待驗證 > 0 時約 3 verify：1 task 輪替，用「該 agent_name 今天已做的驗證數／任務數」決定下一步
 *   → verify 當 verifies_done < (tasks_done + 1) * 3，否則 task。（3 驗、1 任、3 驗、1 任…）
 * 待驗證 = 0 時只派 task。
 * 派 verify 時排除：自己提交（agent_name 或 ip_hash 相同）、已投過、agree_count 已達門檻（不用再派）。
 * 隨機化：候選清單取最早的一批，再用 seed 隨機挑一筆，避免所有代理拿到同一筆。
 */

import { requiredAgree } from "./consensus.ts";

export const VERIFY_TASK_RATIO = 3;

export type NextKind = "verify" | "task" | "none";

export interface AgentProgress {
  verifies_done: number;
  tasks_done: number;
}

export function chooseKind(totalPending: number, progress: AgentProgress): NextKind {
  if (totalPending <= 0) return "task";
  return progress.verifies_done < (progress.tasks_done + 1) * VERIFY_TASK_RATIO ? "verify" : "task";
}

export interface VerifyCandidate {
  id: string;
  contribution_type: string;
  payload: unknown;
  agent_name: string;
  contributor_ip_hash: string;
  agree_count: number;
  status: string;
  source_urls?: string[] | null;
}

export interface Requester {
  agent_name: string;
  ip_hash: string;
  voted_ids: ReadonlySet<string>;
}

export function filterVerifyCandidates<T extends VerifyCandidate>(rows: readonly T[], me: Requester): T[] {
  const mine = me.agent_name.toLowerCase();
  return rows.filter((r) =>
    r.status === "pending" &&
    r.agent_name.toLowerCase() !== mine &&
    r.contributor_ip_hash !== me.ip_hash &&
    !me.voted_ids.has(r.id) &&
    r.agree_count < requiredAgree(r.contribution_type, r.payload, r.source_urls ?? [])
  );
}

/** 軟認領：派出後幾分鐘內不派給其他代理 */
export const LEASE_MINUTES = 30;

export interface TaskLike {
  task_id: string;
  target?: unknown;
}

export interface LeaseLike {
  task_id: string;
  target_key: string;
  agent_name: string;
  leased_until: string;
}

/** 認領以目標為單位：politician_id 或 policy_id；沒有就用 task_id 本身 */
/**
 * 排掉這個代理自己已經提交、還在等票的任務。
 *
 * 認領期只擋別人，好讓中途斷掉的代理能接回自己的任務；但代理提交之後，
 * 資料庫還沒變（貢獻要等票才落庫），缺口任務就會被重新算出來再派一次，
 * 代理只能白跑一輪。伺服器知道誰交過什麼，該由伺服器擋掉。
 */
/**
 * 排掉「已經有人回報是死路、正在等票」的任務。
 *
 * no_change 的冷卻紀錄只在落庫時才寫，而落庫要等票。在參與人數還少的時候，
 * 那筆回報可能等很久，期間同一條死路會繼續派給每一個代理，大家輪流白查。
 *
 * 所以待審中的 no_change 也要擋——它是一個還沒被確認、但已經有人花時間查過的
 * 訊號。擋錯的代價很小：那筆 no_change 若被投反對，任務就回到池子裡。
 * 這跟落庫後的 14 天冷卻是兩層，不是取代關係。
 */
export function filterReportedDeadEnds<T extends TaskLike>(tasks: readonly T[], deadEndTaskIds: ReadonlySet<string>): T[] {
  if (deadEndTaskIds.size === 0) return [...tasks];
  return tasks.filter((t) => !deadEndTaskIds.has(t.task_id));
}

export function filterOwnSubmittedTasks<T extends TaskLike>(tasks: readonly T[], submittedTaskIds: ReadonlySet<string>): T[] {
  if (submittedTaskIds.size === 0) return [...tasks];
  return tasks.filter((t) => !submittedTaskIds.has(t.task_id));
}

export function taskTargetKey(task: TaskLike): string {
  const t = (task.target && typeof task.target === "object" ? task.target : {}) as Record<string, unknown>;
  if (typeof t.policy_id === "string") return `policy:${t.policy_id}`;
  if (typeof t.politician_id === "string") return `politician:${t.politician_id}`;
  return `task:${task.task_id}`;
}

/** 排掉「別人」未過期的認領；自己認領中的可以再拿到（會延長） */
export function filterLeasedTasks<T extends TaskLike>(tasks: readonly T[], leases: readonly LeaseLike[], agentName: string, now: Date = new Date()): T[] {
  const mine = agentName.toLowerCase();
  const heldByOthers = new Set(
    leases.filter((l) => new Date(l.leased_until) > now && l.agent_name.toLowerCase() !== mine).map((l) => l.target_key),
  );
  return tasks.filter((t) => !heldByOthers.has(taskTargetKey(t)));
}

/** 裁決任務不派給：原貢獻的提交者；已有未定案裁決（pending／verified 的 adjudication）的那筆（等它的票就好） */
/**
 * 排掉不該給這個代理的裁決任務。
 *
 * 三種都要排：
 *   1. 原貢獻是他自己交的
 *   2. 他已經對原貢獻投過票——裁決是要重新判斷這件爭議，投過票的人再來裁決，
 *      等於自己先投反對票再裁決自己的判斷，那不是第三方裁決
 *   3. 這筆爭議已經有人提交裁決在等票了
 *
 * 第 2 點原本漏了，外部代理實測踩到：投完 disagree 讓貢獻轉成爭議之後，
 * /next 就一直把那筆裁決派回給他，而且沒有 skip 可以跳過，主流程整個卡住。
 */
export function filterAdjudicateTasks<T extends TaskLike & { task_type?: string }>(
  tasks: readonly T[],
  agentName: string,
  pendingAdjudicatedIds: ReadonlySet<string>,
  votedOriginalIds: ReadonlySet<string> = new Set(),
): T[] {
  const mine = agentName.toLowerCase();
  return tasks.filter((t) => {
    if (t.task_type !== "adjudicate") return true;
    const target = (t.target && typeof t.target === "object" ? t.target : {}) as Record<string, unknown>;
    if (typeof target.contributor === "string" && target.contributor.toLowerCase() === mine) return false;
    if (typeof target.contribution_id === "string" && pendingAdjudicatedIds.has(target.contribution_id)) return false;
    if (typeof target.contribution_id === "string" && votedOriginalIds.has(target.contribution_id)) return false;
    return true;
  });
}

/**
 * 提問任務（task_type="question"）不重派給已經答過那一題的代理、也不再派已滿 3 份答案的題目——
 * DB 的 UNIQUE 與 trigger 是最後防線，這裡先擋掉，別讓代理白跑一趟才在 /report 撞牆。
 */
export function filterAnsweredQuestionTasks<T extends TaskLike & { task_type?: string }>(
  tasks: readonly T[],
  answeredQuestionIds: ReadonlySet<string>,
  fullQuestionIds: ReadonlySet<string>,
): T[] {
  if (answeredQuestionIds.size === 0 && fullQuestionIds.size === 0) return [...tasks];
  return tasks.filter((t) => {
    if (t.task_type !== "question") return true;
    const target = (t.target && typeof t.target === "object" ? t.target : {}) as Record<string, unknown>;
    const qid = typeof target.question_id === "string" ? target.question_id : null;
    if (!qid) return true;
    return !answeredQuestionIds.has(qid) && !fullQuestionIds.has(qid);
  });
}

/**
 * 提問任務彼此之間依 stance_up 高、建立時間早排序（讓比較多人想知道答案的題目優先派出）；
 * 只調整提問任務彼此佔的位置，其他任務的順序與位置完全不動——不讓提問任務整體插到前面，
 * 維持既有的派工比例與隨機分散（pickBySeed 仍在整個候選清單上挑）。
 */
export function sortQuestionTasksBySupport<T extends TaskLike & { task_type?: string; created_at?: string; target?: unknown }>(tasks: readonly T[]): T[] {
  const stanceUpOf = (t: T): number => {
    const target = (t.target && typeof t.target === "object" ? t.target : {}) as Record<string, unknown>;
    return typeof target.stance_up === "number" ? target.stance_up : 0;
  };
  const slots = tasks.map((t, index) => ({ t, index })).filter(({ t }) => t.task_type === "question");
  if (slots.length <= 1) return [...tasks];
  const sorted = [...slots].sort((a, b) => stanceUpOf(b.t) - stanceUpOf(a.t) || Date.parse(a.t.created_at ?? "") - Date.parse(b.t.created_at ?? ""));
  const out = [...tasks];
  slots.forEach(({ index }, i) => { out[index] = sorted[i].t; });
  return out;
}

export interface OriginalIdentity { id: string; agent_name: string; contributor_ip_hash: string }

/** 裁決（adjudication）的驗證不派給原貢獻的提交者（同名或同 IP） */
/**
 * 別把「對某筆爭議的裁決」派給跟那筆原貢獻有關係的人去驗證。
 * 有關係＝原貢獻是他交的，或他對原貢獻投過票（後者原本漏了，理由同
 * filterAdjudicateTasks 的第 2 點）。
 */
export function excludeOwnAdjudications<T extends VerifyCandidate>(
  candidates: readonly T[],
  originals: readonly OriginalIdentity[],
  me: Requester,
  votedOriginalIds: ReadonlySet<string> = new Set(),
): T[] {
  const mine = me.agent_name.toLowerCase();
  const own = new Set(originals.filter((o) => o.agent_name.toLowerCase() === mine || o.contributor_ip_hash === me.ip_hash).map((o) => o.id));
  return candidates.filter((c) => {
    if (c.contribution_type !== "adjudication") return true;
    const target = (c.payload && typeof c.payload === "object" ? (c.payload as Record<string, unknown>).contribution_id : null);
    if (typeof target !== "string") return true;
    return !own.has(target) && !votedOriginalIds.has(target);
  });
}

/** 確定性的偽隨機挑選：同 seed 同結果，不同代理（不同 seed）拿到不同筆。 */
export function pickBySeed<T>(list: readonly T[], seed: string): T | null {
  if (list.length === 0) return null;
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return list[h % list.length];
}
