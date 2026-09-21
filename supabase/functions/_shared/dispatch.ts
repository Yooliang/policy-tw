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
    // 有效門檻（系統票已折進去）：池子回 effective_required 就用它；沒有（舊呼叫端）退回原門檻
    r.agree_count < (typeof r.effective_required === "number" ? r.effective_required : requiredAgree(r.contribution_type, r.payload, r.source_urls ?? []))
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
// 單一派工佇列（2026-09-21）
//
// 原本 /next 有兩套任務來源、兩套排序，而且程式無條件讓手動任務贏：
//   if (freeManual.length > 0) { 派手動 } else { 叫 contribution_auto_tasks }
// 裁決任務就是手動的、有 86 筆，所以自動缺口的優先序永遠輪不到。為了讓 2026 縣市長
// 排最前，前一版又加了 mayorFirst 特例去壓手動——用一個特例壓另一個特例。
//
// 使用者 2026-09-21 的裁示：
//   「手動任務那個一開始就做錯了。當一個手動任務被建立的時候，它應該被排在最前面，
//     而不是整個手動任務的列表都卡在最前面。任務一建立它就是最快會被進行的，
//     之後就照著流程走。」
//
// 所以兩邊排進同一個比較器：先比層級，同層比「最久沒派」（沒派過的算最久）。
//
// 為什麼不是全部混在一起只按 last_dispatched_at 排——這是實測數字擋下來的：
// 自動缺口 1,168 筆可派、其中 926 筆從沒派過；86 筆裁決全都派過了。混排會讓裁決
// 排在那 926 筆後面，以現在的速度是好幾週，等於把 2026-09-21 早上才救活的裁決線
// 再餓死一次。所以裁決與訪客觸發各留一層，其餘手動與自動全部平等。
// ============================================================

/** 2026 縣市長的基本資料（task_priority_tier 回 0） */
export const TIER_MAYOR_PROFILE = 0;
/** 2026 縣市長的政見（task_priority_tier 回 1） */
export const TIER_MAYOR_POLICY = 1;
/** 爭議裁決：卡著別人的貢獻不能收斂，時效性最強 */
export const TIER_ADJUDICATION = 2;
/** 網站「請 AI 幫忙查」按鈕：有訪客在等 */
export const TIER_WEB_REQUEST = 3;
/** 其餘全部同一池：手動的 manual／suggested ＋ 所有其他自動缺口 */
export const TIER_REST = 4;

export interface QueueKey {
  tier: number;
  /** 沒派過是 null，排在所有派過的前面 */
  lastDispatchedAt: string | null;
}

/** a 是否該排在 b 前面。先比層，同層比最久沒派（null＝沒派過＝最久）。 */
export function queueKeyBefore(a: QueueKey, b: QueueKey): boolean {
  if (a.tier !== b.tier) return a.tier < b.tier;
  if (a.lastDispatchedAt === b.lastDispatchedAt) return false;
  if (a.lastDispatchedAt === null) return true;
  if (b.lastDispatchedAt === null) return false;
  return a.lastDispatchedAt < b.lastDispatchedAt;
}

/**
 * 手動任務的層級由 source 決定。
 * 只有裁決與訪客觸發各自有層；維護者建的（manual）與外部提議通過的（suggested）
 * 都落到 TIER_REST，跟自動缺口平等——新建的那筆 last_dispatched_at 是 null，
 * 自然排最前；派過一次就跟大家一起輪。這就是使用者要的行為。
 */
export function manualTaskTier(source: string | null | undefined): number {
  if (source === "auto_dispute") return TIER_ADJUDICATION;
  if (source === "web_request") return TIER_WEB_REQUEST;
  return TIER_REST;
}

/** 自動缺口的層級：task_priority_tier 只有 0／1 有意義（縣市長），其餘一律進共同池。 */
export function autoTaskTier(priorityTier: unknown): number {
  return priorityTier === TIER_MAYOR_PROFILE || priorityTier === TIER_MAYOR_POLICY
    ? (priorityTier as number)
    : TIER_REST;
}

export interface ManualQueueTask {
  source?: string | null;
  last_dispatched_at?: string | null;
}

/**
 * 手動任務裡最該派的一筆，用的是跟自動缺口同一把尺。
 *
 * 不是嚴格取第一名，而是排序後在前 MANUAL_PICK_WINDOW 筆裡用 seed 挑——沿用
 * pickManualTask 原本的防撞設計（merge-queue 2026-09-21 指出的）：兩個代理同時打
 * /next 時，雙方都在對方寫入認領之前就撈完候選了，嚴格取第一名會讓它們固定撞同一筆。
 * 認領排除擋得住大部分情況，但擋不住這個競賽窗口。
 */
export function pickQueuedManual<T extends ManualQueueTask>(tasks: readonly T[], seed: string): T | null {
  if (tasks.length === 0) return null;
  const sorted = [...tasks].sort((a, b) => {
    const ka: QueueKey = { tier: manualTaskTier(a.source), lastDispatchedAt: a.last_dispatched_at ?? null };
    const kb: QueueKey = { tier: manualTaskTier(b.source), lastDispatchedAt: b.last_dispatched_at ?? null };
    if (queueKeyBefore(ka, kb)) return -1;
    if (queueKeyBefore(kb, ka)) return 1;
    return 0;
  });
  // 防撞只在「並列第一」之間做，不是固定取前 3 筆。
  // 固定窗口會弄丟裁示要的那個保證：唯一一筆剛建立的任務必須立刻被派出去，
  // 而不是三分之一的機率（單元測試抓到這件事）。並列時才有選擇餘地，也才需要防撞——
  // 而剛建立的任務全都是 last_dispatched_at = null，彼此並列，照樣散得開。
  const first: QueueKey = { tier: manualTaskTier(sorted[0].source), lastDispatchedAt: sorted[0].last_dispatched_at ?? null };
  const tied = sorted.filter((t) => {
    const k: QueueKey = { tier: manualTaskTier(t.source), lastDispatchedAt: t.last_dispatched_at ?? null };
    return !queueKeyBefore(first, k) && !queueKeyBefore(k, first);
  });
  return tied.length > 1 ? pickBySeed(tied.slice(0, MANUAL_PICK_WINDOW), seed) : sorted[0];
}
