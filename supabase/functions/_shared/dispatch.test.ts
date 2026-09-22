import { assert, assertEquals } from "jsr:@std/assert@1";
import { pickQueueHead, filterAnsweredQuestionTasks, filterLeasedTasks, filterAdjudicateTasks, filterOwnSubmittedTasks, filterReportedDeadEnds, filterVerifyCandidates, MANUAL_PICK_WINDOW, pickBySeed, pickManualTask, sortQuestionTasksBySupport, taskTargetKey, excludeOwnAdjudications, filterSkippedTasks, fullQuestionIdsOf, QUESTION_ANSWER_CAP, filterSaturatedTasks , TASK_INFLIGHT_CAP } from "./dispatch.ts";

Deno.test("軟認領：別人 30 分鐘內領走的目標不派；自己的、過期的照派；同目標不同任務類型也算同一認領", () => {
  const now = new Date("2026-09-11T10:00:00Z");
  const tasks = [
    { task_id: "auto:policy_missing:P1", target: { politician_id: "P1" } },
    { task_id: "auto:profile_gap:P1", target: { politician_id: "P1" } },
    { task_id: "auto:policy_missing:P2", target: { politician_id: "P2" } },
    { task_id: "auto:progress_stale:X9", target: { policy_id: "X9", politician_id: "P3" } },
    { task_id: "manual-uuid", target: {} },
  ];
  const leases = [
    { task_id: "auto:policy_missing:P1", target_key: "politician:P1", agent_name: "other", leased_until: "2026-09-11T10:20:00Z" },
    { task_id: "auto:policy_missing:P2", target_key: "politician:P2", agent_name: "me", leased_until: "2026-09-11T10:20:00Z" },
    { task_id: "auto:progress_stale:X9", target_key: "policy:X9", agent_name: "other", leased_until: "2026-09-11T09:00:00Z" }, // 已過期
  ];
  assertEquals(taskTargetKey(tasks[3]), "policy:X9", "有 policy_id 以政見為單位");
  assertEquals(taskTargetKey(tasks[4]), "task:manual-uuid");
  const free = filterLeasedTasks(tasks, leases, "ME", now).map((t) => t.task_id);
  assertEquals(free, ["auto:policy_missing:P2", "auto:progress_stale:X9", "manual-uuid"]);
});

// 2026-09-22 單一佇列：驗證也是任務，3:1 退場。三個來源各出一個最前的，誰的 queue_at 最早誰先。
Deno.test("/next 單一佇列：誰的 queue_at 最早誰先，跨格式（+00:00 與 Z）也比得對", () => {
  assertEquals(pickQueueHead([
    { kind: "verify", queue_at: "2026-09-21T10:00:00+00:00" },
    { kind: "manual", queue_at: "2026-09-21T09:59:59.000Z" },
    { kind: "auto", queue_at: "2026-09-21T10:00:01+00:00" },
  ]), "manual");
  assertEquals(pickQueueHead([{ kind: "verify", queue_at: "1980-01-01T00:02:00+00:00" }, { kind: "auto", queue_at: "1980-01-01T00:01:00.000Z" }]), "auto", "插隊有先後：先插的分鐘數小");
});
Deno.test("/next 單一佇列：同一時刻驗證先、手動次之、自動最後；沒有候選回 null；壞時間排最後", () => {
  const t = "2026-09-21T10:00:00.000Z";
  assertEquals(pickQueueHead([{ kind: "auto", queue_at: t }, { kind: "verify", queue_at: t }, { kind: "manual", queue_at: t }]), "verify");
  assertEquals(pickQueueHead([{ kind: "auto", queue_at: t }, { kind: "manual", queue_at: t }]), "manual");
  assertEquals(pickQueueHead([null, null]), null);
  assertEquals(pickQueueHead([{ kind: "verify", queue_at: null }, { kind: "auto", queue_at: t }]), "auto");
});

Deno.test("/next 排除自己提交的（同名或同機）、已投過的、agree 已達門檻的", () => {
  const base = { contribution_type: "policy", payload: {}, source_urls: ["https://www.cna.com.tw/x"] }; // 媒體來源：門檻 2
  const rows = [
    { ...base, id: "a", agent_name: "xiaoliang", contributor_ip_hash: "ip-1", agree_count: 0, status: "pending" },
    { ...base, id: "b", agent_name: "someone", contributor_ip_hash: "ip-1", agree_count: 0, status: "pending" },
    { ...base, id: "c", agent_name: "someone", contributor_ip_hash: "ip-2", agree_count: 0, status: "pending" },
    { ...base, id: "d", agent_name: "other", contributor_ip_hash: "ip-3", agree_count: 2, status: "pending" },
    { ...base, id: "e", agent_name: "other", contributor_ip_hash: "ip-3", agree_count: 0, status: "pending" },
    { ...base, id: "f", agent_name: "other", contributor_ip_hash: "ip-3", agree_count: 0, status: "verified" },
    // candidacy 媒體來源門檻 6：2 票還要繼續派
    { id: "g", contribution_type: "candidacy", payload: { candidate_status: "registered" }, source_urls: ["https://www.cna.com.tw/x"], agent_name: "other", contributor_ip_hash: "ip-3", agree_count: 2, status: "pending" },
    { id: "h", contribution_type: "candidacy", payload: { candidate_status: "registered" }, source_urls: ["https://www.cna.com.tw/x"], agent_name: "other", contributor_ip_hash: "ip-3", agree_count: 6, status: "pending" },
  ];
  const me = { agent_name: "XiaoLiang", ip_hash: "ip-1", voted_ids: new Set(["e"]) };
  assertEquals(filterVerifyCandidates(rows, me).map((r) => r.id), ["c", "d", "g"], "目標一律 3：agree 2 的 d／g 還沒達標，h（6）已達標");
});

// 2026-09-21 票數→分數：池子回 score／target_score 就照它們排除已達標的，不再看 agree_count／effective_required。
Deno.test("/next 排除已達標的：score／target_score 存在時取代 agree_count／effective_required", () => {
  const base = { contribution_type: "policy", payload: {}, source_urls: ["https://www.cna.com.tw/x"], status: "pending" };
  const rows = [
    // agree_count 還沒到舊門檻（2），但 score 已達 target_score → 排除
    { ...base, id: "a", agent_name: "other", contributor_ip_hash: "ip-2", agree_count: 0, effective_required: 2, score: 3, target_score: 3 },
    // agree_count 已達舊門檻（2），但 score 還沒到 target_score → 繼續派
    { ...base, id: "b", agent_name: "other", contributor_ip_hash: "ip-2", agree_count: 2, effective_required: 2, score: 1, target_score: 3 },
    // 沒有 score／target_score（舊池子）→ 退回 agree_count／effective_required，跟原本行為一樣
    { ...base, id: "c", agent_name: "other", contributor_ip_hash: "ip-2", agree_count: 2, effective_required: 2 },
  ];
  const me = { agent_name: "XiaoLiang", ip_hash: "ip-1", voted_ids: new Set<string>() };
  assertEquals(filterVerifyCandidates(rows, me).map((r) => r.id), ["b"]);
});

Deno.test("pickBySeed：同 seed 同結果、不同 seed 會分散", () => {
  const list = ["a", "b", "c", "d", "e", "f", "g", "h"];
  assertEquals(pickBySeed(list, "agent-1"), pickBySeed(list, "agent-1"));
  const picks = new Set(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((s) => pickBySeed(list, s)));
  assert(picks.size > 1);
  assertEquals(pickBySeed([], "x"), null);
});

Deno.test("提問任務：已答過的代理與已滿 3 份的題目不再派；非提問任務不受影響", () => {
  const tasks = [
    { task_id: "q1", task_type: "question", target: { question_id: "Q1" } },
    { task_id: "q2", task_type: "question", target: { question_id: "Q2" } },
    { task_id: "q3", task_type: "question", target: { question_id: "Q3" } },
    { task_id: "audit1", task_type: "audit", target: { source_url: "https://x" } },
  ];
  // Q1 這個代理答過、Q2 已滿 3 份 → 都不派；Q3 與非提問任務照派
  const left = filterAnsweredQuestionTasks(tasks, new Set(["Q1"]), new Set(["Q2"]));
  assertEquals(left.map((t) => t.task_id), ["q3", "audit1"]);
  // 沒有任何要排除的 → 全部照派（含空 Set 的快速路徑）
  assertEquals(filterAnsweredQuestionTasks(tasks, new Set(), new Set()).length, 4);
});

Deno.test("提問任務排序：彼此依 stance_up 高、建立時間早排序；其他任務位置完全不動", () => {
  const tasks = [
    { task_id: "audit1", task_type: "audit", created_at: "2026-09-01T00:00:00Z", target: {} },
    { task_id: "q-low", task_type: "question", created_at: "2026-09-05T00:00:00Z", target: { question_id: "Q1", stance_up: 1 } },
    { task_id: "manual1", task_type: "other", created_at: "2026-09-02T00:00:00Z", target: {} },
    { task_id: "q-high", task_type: "question", created_at: "2026-09-06T00:00:00Z", target: { question_id: "Q2", stance_up: 9 } },
    { task_id: "q-tie-early", task_type: "question", created_at: "2026-09-03T00:00:00Z", target: { question_id: "Q3", stance_up: 1 } },
  ];
  const sorted = sortQuestionTasksBySupport(tasks);
  // 非提問任務原地不動（第 0、2 個位置還是 audit1、manual1）
  assertEquals(sorted[0].task_id, "audit1");
  assertEquals(sorted[2].task_id, "manual1");
  // 提問任務只在彼此原本佔的位置（1、3、4）內重排：stance_up 高的優先，同分依建立時間早的優先
  assertEquals([sorted[1].task_id, sorted[3].task_id, sorted[4].task_id], ["q-high", "q-tie-early", "q-low"]);
  assertEquals(sortQuestionTasksBySupport([tasks[0]]).map((t) => t.task_id), ["audit1"], "只有一筆或沒有提問任務時原樣返回");
});

Deno.test("不重複派自己交過的任務：認領期只擋別人，但已提交的任務要由伺服器擋掉", () => {
  const tasks = [
    { task_id: "auto:profile_gap:aaa", target: { politician_id: "p1" } },
    { task_id: "auto:policy_source_missing:bbb", target: { policy_id: "y1" } },
  ];

  // 沒交過任何東西時照派
  assertEquals(filterOwnSubmittedTasks(tasks, new Set<string>()).length, 2);

  // 交過第一筆、還在等票 → 只剩第二筆
  const left = filterOwnSubmittedTasks(tasks, new Set(["auto:profile_gap:aaa"]));
  assertEquals(left.map((t) => t.task_id), ["auto:policy_source_missing:bbb"]);

  // 兩筆都交過 → 一筆都不派，代理該去驗別人的
  assertEquals(filterOwnSubmittedTasks(tasks, new Set(["auto:profile_gap:aaa", "auto:policy_source_missing:bbb"])).length, 0);

  // 認領期的行為不變：自己認領中的仍然派回給自己（中斷可續做），別人認領中的排掉
  const future = new Date(Date.now() + 10 * 60_000).toISOString();
  const leases = [{ task_id: "auto:profile_gap:aaa", target_key: "politician:p1", agent_name: "alice", leased_until: future }];
  assertEquals(filterLeasedTasks(tasks, leases, "alice").length, 2);
  assertEquals(filterLeasedTasks(tasks, leases, "bob").map((t) => t.task_id), ["auto:policy_source_missing:bbb"]);
});

Deno.test("裁決不派給對原貢獻投過票的人：投完反對票讓它轉成爭議的人，不該再去裁決同一件", () => {
  const tasks = [
    { task_id: "adj-1", task_type: "adjudicate", target: { contribution_id: "c-1", contributor: "alice" } },
    { task_id: "adj-2", task_type: "adjudicate", target: { contribution_id: "c-2", contributor: "alice" } },
    { task_id: "gap-1", task_type: "profile_gap", target: { politician_id: "p-1" } },
  ];
  const none = new Set<string>();

  // bob 對 c-1 投過票 → adj-1 不該派給他；adj-2 可以
  const forBob = filterAdjudicateTasks(tasks, "bob", none, new Set(["c-1"]));
  assertEquals(forBob.map((t) => t.task_id), ["adj-2", "gap-1"]);

  // alice 是原提交者 → 兩筆裁決都不該派給她
  assertEquals(filterAdjudicateTasks(tasks, "alice", none, none).map((t) => t.task_id), ["gap-1"]);

  // 沒投過票也不是提交者 → 兩筆都派得
  assertEquals(filterAdjudicateTasks(tasks, "carol", none, none).length, 3);

  // 已經有人提交裁決在等票 → 不再派同一筆
  assertEquals(filterAdjudicateTasks(tasks, "carol", new Set(["c-2"]), none).map((t) => t.task_id), ["adj-1", "gap-1"]);

  // 非裁決任務不受投票紀錄影響
  assertEquals(filterAdjudicateTasks(tasks, "bob", none, new Set(["c-1", "c-2"])).map((t) => t.task_id), ["gap-1"]);
});

Deno.test("裁決的驗證也要排掉對原貢獻投過票的人", () => {
  const candidates = [
    { id: "v-1", contribution_type: "adjudication", payload: { contribution_id: "c-1" }, agent_name: "dave", contributor_ip_hash: "ip-d", source_urls: [] },
    { id: "v-2", contribution_type: "policy", payload: {}, agent_name: "dave", contributor_ip_hash: "ip-d", source_urls: [] },
  ];
  const originals = [{ id: "c-1", agent_name: "alice", contributor_ip_hash: "ip-a" }];
  const me = { agent_name: "bob", ip_hash: "ip-b", voted_ids: new Set<string>() };

  // bob 沒碰過 c-1 → 兩筆都可驗
  assertEquals(excludeOwnAdjudications(candidates as never, originals, me).length, 2);
  // bob 對 c-1 投過票 → 那筆裁決不給他驗
  assertEquals(excludeOwnAdjudications(candidates as never, originals, me, new Set(["c-1"])).map((c) => c.id), ["v-2"]);
});

Deno.test("已被回報是死路、正在等票的任務不再派給別人", () => {
  const tasks = [
    { task_id: "auto:progress_stale:a", target: { policy_id: "a" } },
    { task_id: "auto:progress_stale:b", target: { policy_id: "b" } },
    { task_id: "auto:profile_gap:c", target: { politician_id: "c" } },
  ];

  assertEquals(filterReportedDeadEnds(tasks, new Set<string>()).length, 3);

  // 有人回報 a 查了沒東西、還在等票 → 期間不要再派給別人重查
  assertEquals(
    filterReportedDeadEnds(tasks, new Set(["auto:progress_stale:a"])).map((t) => t.task_id),
    ["auto:progress_stale:b", "auto:profile_gap:c"],
  );

  // 全部都被回報過 → 一筆都不派，代理該去做別的事
  assertEquals(filterReportedDeadEnds(tasks, new Set(tasks.map((t) => t.task_id))).length, 0);

  // 這一層跟落庫後的 14 天冷卻是兩層：這裡擋的是「還在等票」的回報
  assertEquals(filterReportedDeadEnds([], new Set(["x"])).length, 0);
});

Deno.test("手動任務：priority 高的那一層才會被派，不是整池隨機", () => {
  // 2026-09-13 實測的形狀：手動池 17 筆，裁決 8 筆在 priority 2，網站訪客請求全是 0。
  // 改之前是 pickBySeed(整池)，所以民眾提問是 1/17 的機率被抽中——回饋：
  // 「這種提問 不會優先被領走嗎，有人問，提早解決啊」。
  const pool = [
    { task_id: "q1", priority: 3 },
    { task_id: "q2", priority: 3 },
    { task_id: "adj1", priority: 2 },
    { task_id: "adj2", priority: 2 },
    { task_id: "news", priority: 1 },
    { task_id: "sugg", priority: 0 },
  ];
  // 不管哪個代理的 seed，挑出來的一定是 priority 3 那一層
  for (const seed of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
    const picked = pickManualTask(pool, seed)!;
    assert(["q1", "q2"].includes(picked.task_id), `seed=${seed} 挑到 ${picked.task_id}，應該只從 priority 3 那層挑`);
  }
});

Deno.test("手動任務：同一層裡順序有效，但不是固定挑第一筆", () => {
  // 順序要有效（否則 sortQuestionTasksBySupport 的表態排序又白做了），
  // 但不能固定挑第一筆——兩個代理同時打 /next、任一方還沒寫下軟認領時會撞在一起。
  const band = Array.from({ length: 8 }, (_, i) => ({ task_id: `t${i}`, priority: 3 }));
  const picked = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((s) => pickManualTask(band, s)!.task_id));
  for (const id of picked) {
    const rank = Number(id.slice(1));
    assert(rank < MANUAL_PICK_WINDOW, `挑到排在第 ${rank + 1} 的 ${id}，超出前 ${MANUAL_PICK_WINDOW} 筆的範圍`);
  }
  assert(picked.size > 1, "不同代理應該散得開，不是所有人都拿到同一筆");
});

Deno.test("手動任務：priority 沒填當 0，空池回 null", () => {
  assertEquals(pickManualTask([], "seed"), null);
  const mixed = [{ task_id: "none" }, { task_id: "low", priority: -1 }];
  assertEquals(pickManualTask(mixed, "seed")!.task_id, "none", "沒填 priority 要當 0，比 -1 高");
});

// 2026-09-15 萬大捷運站那題：1 份已上線、5 份在排隊，還被派給第 7 個代理；
// 代理 skip 之後下一次 /next 又抽回同一題。
const Q_TASK = { task_id: "t-wanda", task_type: "question", target: { question_id: "q-wanda" } };
const OTHER = { task_id: "t-other", task_type: "policy_missing", target: { politician_id: "p1" } };

Deno.test("提問滿額：已上線＋還在等票的答案合計達上限就不再派", () => {
  const questions = [{ id: "q-wanda", answer_count: 1 }];
  assertEquals(QUESTION_ANSWER_CAP, 3);
  // 萬大實況：1 份上線、5 份在排隊
  const full = fullQuestionIdsOf(questions, [Q_TASK, OTHER], new Map([["t-wanda", 5]]));
  assert(full.has("q-wanda"), "排隊中的答案也要佔名額，否則只看上線數會一直以為還差 2 份");
  assertEquals(filterAnsweredQuestionTasks([Q_TASK, OTHER], new Set(), full).map((t) => t.task_id), ["t-other"]);
  // 1 上線＋1 排隊＝2，還沒滿
  assert(!fullQuestionIdsOf(questions, [Q_TASK], new Map([["t-wanda", 1]])).has("q-wanda"));
  // 剛好 1＋2＝3 就滿
  assert(fullQuestionIdsOf(questions, [Q_TASK], new Map([["t-wanda", 2]])).has("q-wanda"));
  // 排隊數掛在別的任務上不能算到這題
  assert(!fullQuestionIdsOf(questions, [Q_TASK, OTHER], new Map([["t-other", 9]])).has("q-wanda"));
});

Deno.test("skip 有記憶：同 IP 跳過的任務不再派回來，其他任務照派", () => {
  assertEquals(filterSkippedTasks([Q_TASK, OTHER], new Set(["t-wanda"])).map((t) => t.task_id), ["t-other"]);
  assertEquals(filterSkippedTasks([Q_TASK, OTHER], new Set()).length, 2);
});

// 2026-09-17 李四川：任務底下 21 筆等票、任務不關、又在最高優先層的前 3 筆裡 → 每個代理都抽到它
// 上限原本寫死 3；2026-09-18 改成跟「一題最多交 5 筆政見」同一個常數，這裡改用常數，
// 守的是「達上限就不派、差一筆還會派」這條規則本身，不是某個數字。
Deno.test("底下在途筆數達上限的任務不再派", () => {
  const tasks = [{ task_id: "t1" }, { task_id: "t2" }, { task_id: "t3" }];
  const counts = new Map([["t1", TASK_INFLIGHT_CAP], ["t2", 21], ["t3", TASK_INFLIGHT_CAP - 1]]);
  assertEquals(filterSaturatedTasks(tasks, counts).map((t) => t.task_id), ["t3"]);
});

Deno.test("沒有在途資料時不擋任何任務；上限可調", () => {
  const tasks = [{ task_id: "t1" }, { task_id: "t2" }];
  assertEquals(filterSaturatedTasks(tasks, new Map()).length, 2);
  assertEquals(filterSaturatedTasks(tasks, new Map([["t1", 1]]), 1).map((t) => t.task_id), ["t2"]);
});

Deno.test("/next 不再有 3:1：沒有 chooseKind；驗證派出去也要蓋章回隊尾", async () => {
  // 2026-09-22 單一佇列。驗證派出去若不蓋 task_dispatched('verify:…')，同一筆會一直是「等最久的」，全站都拿到它。
  const src = await Deno.readTextFile(new URL("../next/index.ts", import.meta.url));
  assert(!/chooseKind\(/.test(src), "3:1 已退場，/next 不該再呼叫 chooseKind");
  assert(/task_dispatched", \{ p_task_id: `verify:\$\{pick\.id\}` \}/.test(src), "驗證派出去要蓋 task_dispatched('verify:<id>')");
  assert(/pickQueueHead\(\[/.test(src), "三個來源要用 pickQueueHead 合成");
});
