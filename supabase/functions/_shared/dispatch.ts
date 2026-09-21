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
  /** contribution_verify_pool 回的有效門檻（2026-09-20）；沒有就用 requiredAgree */
  effective_required?: number | null;
  /** contribution_verify_pool 回的目前分數／目標分數（2026-09-21 票數→分數）；沒有就退回 agree_count／effective_required */
  score?: number | null;
  target_score?: number | null;
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
  return rows.filter((r) => {
    // 分數（2026-09-21 票數→分數）：池子回 score／target_score 就用它們；
    // 沒有（舊池子還沒上這兩欄）退回舊的 agree_count／effective_required（票＝分，語意不變）
    const current = typeof r.score === "number" ? r.score : r.agree_count;
    const target = typeof r.target_score === "number"
      ? r.target_score
      : (typeof r.effective_required === "number" ? r.effective_required : requiredAgree(r.contribution_type, r.payload, r.source_urls ?? []));
    return r.status === "pending" &&
      r.agent_name.toLowerCase() !== mine &&
      r.contributor_ip_hash !== me.ip_hash &&
      !me.voted_ids.has(r.id) &&
      current < target;
  });
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

/**
 * submittedTaskIds 由呼叫端依「同代號或同來源 IP」撈：同一台機器換個代號，
 * 仍然是同一個人在做，不該再派一次（跟每日額度、計票都按 IP 算是同一個道理）。
 */
export function filterOwnSubmittedTasks<T extends TaskLike>(tasks: readonly T[], submittedTaskIds: ReadonlySet<string>): T[] {
  if (submittedTaskIds.size === 0) return [...tasks];
  return tasks.filter((t) => !submittedTaskIds.has(t.task_id));
}

/** @deprecated 2026-09-20：skip 不再按 IP 記 24 小時排除，改成「跟派過一樣排到後面」；常數留給舊測試 */
export const SKIP_MEMORY_HOURS = 24;
/**
 * 一個任務底下最多同時有幾筆還在等票的貢獻；超過就先不要再派這個任務。
 *
 * 2026-09-17：「李四川這個任務怎麼好像跑 n 多次了」。實查：
 * `policy_missing`／李四川（網站訪客按「請 AI 幫忙查政見」）底下堆了 21 筆待驗證，
 * 14 筆是 0～1 票。任務要等「有貢獻上線」才會關，那 21 筆卡在票數不夠 → 任務不關
 * → 它又是最高優先層裡最舊的幾筆之一（pickManualTask 只從前 3 筆挑）→ 每個代理都抽到它。
 * 結果是同一件事被查了十幾次：「居住新五箭」三份、醫療那包兩份、運動幣兩份。
 *
 * 力氣該花在還沒人碰的 777 個缺口上，不是同一題的第 22 份答案。
 *
 * 2026-09-18 從 3 改成跟「一題最多交幾筆政見」同一個數字：任務文字叫代理最多交 5 筆，
 * 上限卻是 3 的話，一個代理交完 3 筆這題就不再派、剩下的機會也沒了。
 * 而且任務現在有一筆上線就會關（task-fulfilment.ts），不會再像李四川那樣越堆越多。
 */
export const MAX_POLICIES_PER_TASK = 5;
export const TASK_INFLIGHT_CAP = MAX_POLICIES_PER_TASK;

/**
 * 排掉「底下已經有夠多筆在等票」的任務。
 *
 * 只看還沒定案的（pending／verified 等在途狀態），已退件或已上線的不算——
 * 前者代表那個方向行不通、後者代表任務本來就該關了。
 */
export function filterSaturatedTasks<T extends TaskLike>(
  tasks: readonly T[],
  inFlightByTask: ReadonlyMap<string, number>,
  cap: number = TASK_INFLIGHT_CAP,
): T[] {
  if (inFlightByTask.size === 0) return [...tasks];
  return tasks.filter((t) => (inFlightByTask.get(t.task_id) ?? 0) < cap);
}
/** 一題公民提問最多收幾份答案（已上線＋還在等票的都算） */
export const QUESTION_ANSWER_CAP = 3;

/**
 * 排掉這個來源 IP 最近按過 skip 的任務。
 *
 * 2026-09-15 萬大捷運那題：代理按 skip 只釋放了當下的認領，那題又在最高優先層、
 * 只從前 3 筆裡挑，下一次 /next 馬上又抽回同一題，代理回報「反覆出現、一直 skip」。
 */
export function filterSkippedTasks<T extends TaskLike>(tasks: readonly T[], skippedTaskIds: ReadonlySet<string>): T[] {
  if (skippedTaskIds.size === 0) return [...tasks];
  return tasks.filter((t) => !skippedTaskIds.has(t.task_id));
}

/**
 * 已滿額的提問：已上線的答案（citizen_questions.answer_count）＋還在等票的 question_answer 貢獻 ≥ 上限。
 *
 * 只看已上線的話，萬大捷運那題 1 份上線、5 份在排隊，系統仍以為「還差 2 份」一直派——
 * 大家重複寫同一題，排隊的答案又互相搶票，沒有一份通過得了。
 */
export function fullQuestionIdsOf(
  questions: ReadonlyArray<{ id: string; answer_count: number }>,
  tasks: ReadonlyArray<TaskLike & { task_type?: string }>,
  inFlightByTaskId: ReadonlyMap<string, number>,
): Set<string> {
  const inFlightByQuestion = new Map<string, number>();
  for (const t of tasks) {
    if (t.task_type !== "question") continue;
    const target = (t.target && typeof t.target === "object" ? t.target : {}) as Record<string, unknown>;
    if (typeof target.question_id !== "string") continue;
    inFlightByQuestion.set(target.question_id, (inFlightByQuestion.get(target.question_id) ?? 0) + (inFlightByTaskId.get(t.task_id) ?? 0));
  }
  return new Set(questions
    .filter((q) => q.answer_count + (inFlightByQuestion.get(q.id) ?? 0) >= QUESTION_ANSWER_CAP)
    .map((q) => q.id));
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

/**
 * 手動池最多從排序後的前幾筆裡挑。
 *
 * 為什麼不是固定挑第一筆：兩個代理同時打 /next，在任何一方寫下軟認領之前
 * 兩邊讀到的是同一份清單，固定挑第一筆會讓他們撞在同一個任務上。
 * 為什麼不是整池隨機（改之前的做法）：那會讓 priority 與提問的表態數完全失效。
 * 所以取「排序後的前 N 筆」再用代理自己的 seed 挑一筆——順序有效，又散得開。
 */
export const MANUAL_PICK_WINDOW = 3;

/**
 * 手動任務的挑選：先取 priority 最高的那一層，再從那一層排序後的前幾筆裡用 seed 挑。
 *
 * 改之前是 `pickBySeed(freeManual, seed)`——整池隨機。那讓兩個機制默默失效：
 *   1. 撈任務時的 `.order("priority")`（註解寫著「手動任務優先（priority 高者）」，程式卻沒照做）
 *   2. sortQuestionTasksBySupport（把提問依表態數排序，排完就被隨機洗掉，只有單元測試看得到效果）
 * 實測 2026-09-13：手動池 17 筆，裁決 8 筆佔 priority 2，網站訪客請求全是 0，
 * 所以民眾提了問題之後，那筆是 1/17 的機率被抽中。
 *
 * 傳進來的清單必須已經排好（撈的時候 priority DESC、created_at ASC，再套
 * sortQuestionTasksBySupport），這個函式只負責分層與挑選。
 */
export function pickManualTask<T extends { priority?: number | null }>(tasks: readonly T[], seed: string): T | null {
  if (tasks.length === 0) return null;
  const top = Math.max(...tasks.map((t) => t.priority ?? 0));
  const band = tasks.filter((t) => (t.priority ?? 0) === top);
  return pickBySeed(band.slice(0, MANUAL_PICK_WINDOW), seed);
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

// ============================================================
// 單一派工佇列：一個時間軸，沒有第二個維度（使用者 2026-09-21）
//
// 使用者：
//   「像裁決在被建立的時候，就應該使用最舊的時間排入任務裡，這樣它就會被優先派發
//     出去。新的任務出來（比如說明確定義新缺口出來的那些任務），用的都是現在的
//     時間，所以會被排在比較後面…加進任務佇列裡面，就有一個參數決定它要放在最
//     前面還是最後面。最前面就是最舊的，最舊的那一些會被最先領走。」
//
// 而且要這樣排，理由是覆蓋率：
//   「我們要的是盡可能覆蓋任務數量，而不是把一個任務做到完成，所以『領完就走』
//     這件事情是優先的。輪了 900 次之後，我們就有可能出現 300 筆上線的資料；
//     可是你如果把一筆複雜的任務卡在前面，900 筆過後可能只有 50 筆上線資料。」
//
// 所以：派出去就蓋成 now() 回到隊尾。簡單的當場結案離開池子，複雜的自然被推到
// 下一輪、下下輪，不會卡住前面。
//
// 這一版之前試過兩種都錯：
//   1. 用 `last_dispatched_at ASC NULLS FIRST`——NULL 等於無限舊，1,168 筆缺口
//      全部並列最前，實際順序由 task_id 字典序決定，是隨機不是設計。
//   2. 再加一個「層級」維度去壓它們（縣市長 0／1、裁決 2、訪客 3、其餘 4）——
//      裁決拿到永久特權，而裁決正是最貴、最可能做不完的工作，直接違反覆蓋率。
// 現在只有一個鍵：queue_at。想排最前就給它 1980，想排最後就給它現在。
// ============================================================

/** 想排在最前面就用這個時間（使用者指定：「調到 1980 年這樣子好不好」） */
export const QUEUE_FRONT = "1980-01-01T00:00:00.000Z";

/**
 * 這些手動任務是「有人明確要求要做的」，進佇列就排最前：
 * 維護者手建的、爭議裁決、訪客按按鈕要求的。
 * 派出去一次之後就蓋成 now()、回到隊尾——它們拿到的是一次立刻被領走的機會，
 * 不是永久特權。這就是使用者說的「裁決一出來就會被領走做完，然後繼續跑我們
 * 原本缺口的任務」。
 *
 * 不在這裡面的（suggested）屬於累積下來的待辦，照進佇列的時間排。
 */
const FRONT_SOURCES = new Set(["manual", "auto_dispute", "web_request"]);

export interface QueuedTask {
  source?: string | null;
  last_dispatched_at?: string | null;
  created_at?: string | null;
}

/**
 * 手動任務在佇列裡的時間。
 * 派過就用派出的時間（隊尾）；沒派過的看它是不是「有人明確要求」——是就 1980，
 * 不是就用它進佇列的時間（created_at）。
 */
export function manualQueueAt(task: QueuedTask): string {
  if (task.last_dispatched_at) return task.last_dispatched_at;
  if (FRONT_SOURCES.has(task.source ?? "")) return QUEUE_FRONT;
  return task.created_at ?? QUEUE_FRONT;
}

/**
 * 手動任務裡最該派的一筆。
 *
 * 不是嚴格取第一名，而是在「並列第一」之間用 seed 挑——兩個代理同時打 /next 時，
 * 雙方都在對方寫入認領之前就撈完候選了，嚴格取第一名會讓它們固定撞同一筆
 * （merge-queue 2026-09-21 指出；認領排除擋不住這個競賽窗口）。
 * 只在並列時散開，是因為唯一一筆剛建立的任務必須每次都被派出去，不能變成機率。
 */
export function pickQueuedManual<T extends QueuedTask>(tasks: readonly T[], seed: string): T | null {
  if (tasks.length === 0) return null;
  const sorted = [...tasks].sort((a, b) => {
    const ka = manualQueueAt(a), kb = manualQueueAt(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const first = manualQueueAt(sorted[0]);
  const tied = sorted.filter((t) => manualQueueAt(t) === first);
  return tied.length > 1 ? pickBySeed(tied.slice(0, MANUAL_PICK_WINDOW), seed) : sorted[0];
}
