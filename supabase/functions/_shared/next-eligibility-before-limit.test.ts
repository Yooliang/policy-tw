/**
 * /next 的合格條件必須在 SQL、LIMIT 之前（2026-10-17，policy-ops docs/work/2026-10-17-派工隊頭堵塞.md；migration 20261017000301）。
 *
 * 事故：/next 呼叫 contribution_queue_tasks(…, p_limit 30, …) 之後才在程式裡套 filterReportedDeadEnds 等過濾器。
 * 前 30 筆全是「有查無回報在等票」的任務，程式把 30 筆全剔掉 → 沒有任務可派、這些頭永遠不被派出、佇列頭被釘死（2026-09-20 同一類事故，窗口 12 筆）。
 *
 * 三層守門：
 *   A. 登記表：/next 裡每一個 filter*／exclude* 呼叫，都必須登記「對應 SQL 定義裡的哪個標記」（-- >>> 合格：… / -- <<< 合格：…），
 *      或明寫為「只留程式」並附理由；新加過濾器不登記就紅、SQL 的標記不見就紅、登記了卻不再被呼叫（過期）也紅。
 *   B. 行為（PGlite 真的跑 contribution_queue_tasks 的最新定義）：每個標記底下的每個條件各有劇本；另有「35 筆死路排在最前面 + 1 筆好的，取 30 筆要拿到好的」。
 *   C. 還原驗證：A 的偵測器對「拿掉標記」「/next 新增未登記過濾器」要報錯；B 的每個劇本在「把該標記整段拿掉」之後要翻面（被排除的任務又出現）。
 *      不做這一層，標記可能只是裝飾（留著標記、條件被改成永遠為真，A 看不出來，B 會紅）。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { latestFn, mutate, readMig } from "./arms-pglite.ts";

const NEXT_SRC = (await Deno.readTextFile(new URL("../next/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
const MIG = "20261017000301_queue_tasks_eligibility_before_limit.sql";
const QUEUE_SQL = await latestFn("contribution_queue_tasks");

type Entry = { markers: string[]; tsOnly?: undefined } | { markers?: undefined; tsOnly: string };

/** /next 套在佇列列（contribution_queue_tasks 的結果）上的每個過濾器 → SQL 標記；只留程式的要寫理由 */
const REGISTRY: Record<string, Entry> = {
  filterAdjudicateTasks: { markers: ["合格：裁決任務"] },
  filterLeasedTasks: { markers: ["合格：認領中"] },
  filterOwnSubmittedTasks: { markers: ["合格：同機器交過"] },
  filterReportedDeadEnds: { markers: ["合格：查無回報在等票"] },
  filterSaturatedTasks: { markers: ["合格：在途未額滿"] },
  filterAnsweredQuestionTasks: { markers: ["合格：提問未滿額", "合格：提問這台答過"] },
  filterSkippedTasks: { tsOnly: "skip 是這一次請求帶進來的單一一筆 skip_task_id，SQL 沒有這個輸入；一次最多剔一筆，不會把窗口清空" },
};
/** 不是套在佇列列上的（驗證池／裁決驗證候選），不需要 SQL 對應 */
const EXEMPT: Record<string, string> = {
  filterVerifyCandidates: "驗證池候選（contribution_verify_pool 另有 SQL 守門 verify-pool-exclude-agent.test.ts）",
  excludeOwnAdjudications: "驗證池裡的裁決候選，不是任務佇列",
};

/** 偵測器：回傳問題清單（空＝通過）。純函式，才能對它做還原驗證 */
function checkEligibility(tsSrc: string, sql: string): string[] {
  const problems: string[] = [];
  const called = new Set([...tsSrc.matchAll(/\b((?:filter|exclude)[A-Z]\w*)\s*\(/g)].map((m) => m[1]!));
  // 函式定義本身不算呼叫（/next 不定義它們，防萬一有人在檔內定義）
  for (const name of called) {
    if (!(name in REGISTRY) && !(name in EXEMPT)) problems.push(`/next 呼叫了未登記的過濾器 ${name}：在 SQL 補一段「-- >>> 合格：…」並登記到 REGISTRY`);
  }
  for (const [name, e] of Object.entries(REGISTRY)) {
    if (!called.has(name)) problems.push(`REGISTRY 登記了 ${name}，但 /next 已不呼叫它：拿掉登記（並確認 SQL 那段是否還需要）`);
    if (e.tsOnly !== undefined && e.tsOnly.length < 10) problems.push(`${name} 只留程式，必須寫理由`);
    for (const m of e.markers ?? []) {
      const open = `-- >>> ${m}\n`;
      const close = `-- <<< ${m}\n`;
      const o = sql.split(open).length - 1;
      const c = sql.split(close).length - 1;
      if (o !== 1 || c !== 1) { problems.push(`${name} 的 SQL 標記「${m}」開 ${o} 次／關 ${c} 次（必須各一次）`); continue; }
      const body = sql.slice(sql.indexOf(open) + open.length, sql.indexOf(close));
      if (sql.indexOf(open) > sql.indexOf(close)) problems.push(`標記「${m}」順序顛倒`);
      else if (body.replace(/^\s*--.*$/gm, "").trim() === "") problems.push(`標記「${m}」底下沒有任何條件（只有註解）`);
    }
  }
  return problems;
}

// ============================================================
// A. 登記表
// ============================================================
Deno.test("A1 /next 的每個過濾器都登記了 SQL 標記（或明寫只留程式），最新定義的標記齊全", () => {
  assertEquals(checkEligibility(NEXT_SRC, QUEUE_SQL), []);
  // 最新定義就是這支 migration（之後有人再改，這條要跟著看）
  assertEquals(QUEUE_SQL.includes("-- >>> 合格：查無回報在等票"), true);
});

Deno.test("A2 /next 讀的是 contribution_queue_tasks，窗口常數是 QUEUE_WINDOW，過濾後全空時有 console.error", () => {
  assertStringIncludes(NEXT_SRC, 'supabase.rpc("contribution_queue_tasks", { p_type: null, p_region: region, p_limit: QUEUE_WINDOW,');
  assertStringIncludes(NEXT_SRC, "freeQueue.length === 0 && queueRaw.length >= QUEUE_WINDOW");
  assertStringIncludes(NEXT_SRC, "console.error(`next: 佇列窗口");
  // 舊的錯誤註解（說合格判斷都在 SQL 卻不是）不能回來
  assert(!NEXT_SRC.includes("手動任務的飽和、回報查無仍靠這裡"));
});

Deno.test("A3 還原驗證（偵測器）：拿掉任何一個標記、/next 新增未登記的過濾器、登記過期，偵測器都要報錯", () => {
  const markers = Object.values(REGISTRY).flatMap((e) => e.markers ?? []);
  assert(markers.length >= 7);
  for (const m of markers) {
    const noOpen = mutate(QUEUE_SQL, `-- >>> ${m}\n`, "-- >>> x\n");
    assert(checkEligibility(NEXT_SRC, noOpen).some((p) => p.includes(m)), `拿掉開標記「${m}」偵測不到`);
    const noClose = mutate(QUEUE_SQL, `-- <<< ${m}\n`, "-- <<< x\n");
    assert(checkEligibility(NEXT_SRC, noClose).some((p) => p.includes(m)), `拿掉關標記「${m}」偵測不到`);
    const emptied = stripBody(QUEUE_SQL, m);
    assert(checkEligibility(NEXT_SRC, emptied).some((p) => p.includes(m)), `掏空「${m}」底下的條件偵測不到`);
  }
  const added = mutate(NEXT_SRC, "filterSaturatedTasks(", "filterBrandNewTasks(filterSaturatedTasks(");
  assert(checkEligibility(added, QUEUE_SQL).some((p) => p.includes("filterBrandNewTasks")), "新加未登記過濾器偵測不到");
  const dropped = NEXT_SRC.replaceAll("filterSkippedTasks(", "identity(");
  assert(checkEligibility(dropped, QUEUE_SQL).some((p) => p.includes("filterSkippedTasks")), "登記過期偵測不到");
  assertEquals(Object.entries(REGISTRY).filter(([, e]) => e.tsOnly !== undefined).map(([k]) => k), ["filterSkippedTasks"], "只留程式的清單變了：要有人點頭");
});

Deno.test("A4 日本站暫不跟：drift 測試把 contribution_queue_tasks 的比對釘在這支 migration 之前", async () => {
  const drift = await Deno.readTextFile(new URL("./policy-jp-dispatch-drift.test.ts", import.meta.url));
  assertStringIncludes(drift, `before: "${MIG}"`);
});

// ============================================================
// B. 行為（PGlite）
// ============================================================
/** 拿掉標記整段（含兩條標記註解） */
function stripBlock(sql: string, marker: string): string {
  const open = `    -- >>> ${marker}\n`;
  const close = `    -- <<< ${marker}\n`;
  const a = sql.indexOf(open);
  const b = sql.indexOf(close);
  assert(a >= 0 && b > a, `找不到標記 ${marker}`);
  return sql.slice(0, a) + sql.slice(b + close.length);
}
/** 只掏空標記底下的內容（標記留著、條件沒了）——偵測器要抓得到 */
function stripBody(sql: string, marker: string): string {
  const open = `-- >>> ${marker}\n`;
  const close = `-- <<< ${marker}\n`;
  const a = sql.indexOf(open) + open.length;
  const b = sql.indexOf(close);
  return sql.slice(0, a) + sql.slice(b);
}

const SCHEMA = `
CREATE TABLE task_dispatches (
  task_id text PRIMARY KEY, task_type text, target jsonb NOT NULL DEFAULT '{}'::jsonb, what_we_need text, hint_sources text[], reward integer, region text,
  queue_at timestamptz NOT NULL, blocked boolean NOT NULL DEFAULT false, cooling boolean NOT NULL DEFAULT false,
  opened_at timestamptz NOT NULL DEFAULT now(), last_dispatched_at timestamptz);
CREATE TABLE contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id text, contribution_type text, status text, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  contributor_ip_hash text, agent_name text);
CREATE TABLE contribution_task_leases (task_id text, target_key text, leased_until timestamptz, agent_name text);
CREATE TABLE citizen_questions (id uuid PRIMARY KEY, answer_count integer NOT NULL DEFAULT 0);
CREATE TABLE question_answers (question_id uuid, agent_name text);
CREATE TABLE contribution_votes (contribution_id uuid, verifier_ip_hash text);
`;

async function buildDb(queueSql: string): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  for (const fn of ["task_target_key", "uuid_or_null", "question_answer_cap"]) await db.exec(await latestFn(fn));
  await db.exec(queueSql);
  return db;
}

let seq = 0;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const q = (s: string) => s.replaceAll("'", "''");

/** 一個劇本：建一個任務 T（外加讓它被排除的資料），用 (ip, agent) 呼叫，T 該不該出現 */
type Scenario = {
  marker: string; name: string; excluded: boolean;
  type?: string; taskId?: string; target?: Record<string, unknown>;
  setup?: string; ip: string | null; agent: string | null;
};
const ME = { ip: "ip-me", agent: "me" };
const MANUAL = (n: number) => uuid(900 + n);
const SCENARIOS: Scenario[] = [
  // 認領中
  { marker: "合格：認領中", name: "別人認領中（同 target_key）→ 排除", excluded: true, target: { policy_id: "p-lease" }, ...ME,
    setup: "INSERT INTO contribution_task_leases VALUES ('auto:other', 'policy:p-lease', now() + interval '10 minutes', 'someone-else');" },
  { marker: "合格：認領中", name: "自己認領中 → 照給", excluded: false, target: { policy_id: "p-lease-me" }, ...ME,
    setup: "INSERT INTO contribution_task_leases VALUES ('auto:other', 'policy:p-lease-me', now() + interval '10 minutes', 'ME');" },
  { marker: "合格：認領中", name: "認領已過期 → 照給", excluded: false, target: { policy_id: "p-lease-old" }, ...ME,
    setup: "INSERT INTO contribution_task_leases VALUES ('auto:other', 'policy:p-lease-old', now() - interval '1 minutes', 'someone-else');" },
  // 同機器交過
  { marker: "合格：同機器交過", name: "同 IP 交過在途 → 排除", excluded: true, ...ME,
    setup: "INSERT INTO contributions (task_id, contribution_type, status, contributor_ip_hash, agent_name) VALUES ('@T', 'policy', 'pending', 'ip-me', 'another-name');" },
  { marker: "合格：同機器交過", name: "同代號交過在途 → 排除", excluded: true, ...ME,
    setup: "INSERT INTO contributions (task_id, contribution_type, status, contributor_ip_hash, agent_name) VALUES ('@T', 'policy', 'verified', 'ip-x', 'me');" },
  { marker: "合格：同機器交過", name: "別人交過 → 照給", excluded: false, ...ME,
    setup: "INSERT INTO contributions (task_id, contribution_type, status, contributor_ip_hash, agent_name) VALUES ('@T', 'policy', 'pending', 'ip-x', 'not-me');" },
  // 查無回報在等票
  { marker: "合格：查無回報在等票", name: "no_change pending → 排除（有 ip）", excluded: true, ...ME,
    setup: `INSERT INTO contributions (task_id, contribution_type, status, payload) VALUES (NULL, 'no_change', 'pending', '{"task_id":"@T"}');` },
  { marker: "合格：查無回報在等票", name: "no_change verified → 排除（沒有 ip／代號：rebalance、queue_preview 的呼叫方式）", excluded: true, ip: null, agent: null,
    setup: `INSERT INTO contributions (task_id, contribution_type, status, payload) VALUES (NULL, 'no_change', 'verified', '{"task_id":"@T"}');` },
  { marker: "合格：查無回報在等票", name: "no_change 已退件／已上線 → 照給", excluded: false, ...ME,
    setup: `INSERT INTO contributions (task_id, contribution_type, status, payload) VALUES (NULL, 'no_change', 'rejected', '{"task_id":"@T"}'), (NULL, 'no_change', 'applied', '{"task_id":"@T"}');` },
  // 在途額滿
  { marker: "合格：在途未額滿", name: "在途 5 筆（pending／verified／disputed 混合）→ 排除，不分誰來領", excluded: true, ip: null, agent: null,
    setup: `INSERT INTO contributions (task_id, contribution_type, status) VALUES ('@T','policy','pending'),('@T','policy','pending'),('@T','policy','verified'),('@T','policy','disputed'),('@T','policy','pending');` },
  { marker: "合格：在途未額滿", name: "在途 4 筆 → 照給", excluded: false, ip: null, agent: null,
    setup: `INSERT INTO contributions (task_id, contribution_type, status) VALUES ('@T','policy','pending'),('@T','policy','pending'),('@T','policy','verified'),('@T','policy','disputed');` },
  { marker: "合格：在途未額滿", name: "4 筆在途＋多筆已退件／已上線 → 照給", excluded: false, ip: null, agent: null,
    setup: `INSERT INTO contributions (task_id, contribution_type, status) VALUES ('@T','policy','pending'),('@T','policy','pending'),('@T','policy','verified'),('@T','policy','disputed'),('@T','policy','rejected'),('@T','policy','applied');` },
  // 提問未滿額
  { marker: "合格：提問未滿額", name: "已上線 2 份＋在等票 1 份＝3 → 排除，不分誰來領", excluded: true, type: "question", taskId: MANUAL(1), target: { question_id: uuid(501) }, ip: null, agent: null,
    setup: `INSERT INTO citizen_questions VALUES ('${uuid(501)}', 2); INSERT INTO contributions (task_id, contribution_type, status) VALUES ('@T','question_answer','pending');` },
  { marker: "合格：提問未滿額", name: "已上線 1 份＋在等票 1 份 → 照給", excluded: false, type: "question", taskId: MANUAL(2), target: { question_id: uuid(502) }, ip: null, agent: null,
    setup: `INSERT INTO citizen_questions VALUES ('${uuid(502)}', 1); INSERT INTO contributions (task_id, contribution_type, status) VALUES ('@T','question_answer','pending');` },
  // 提問這台答過
  { marker: "合格：提問這台答過", name: "question_answers 有這個代號（大小寫不分）→ 排除", excluded: true, type: "question", taskId: MANUAL(3), target: { question_id: uuid(503) }, ...ME,
    setup: `INSERT INTO citizen_questions VALUES ('${uuid(503)}', 1); INSERT INTO question_answers VALUES ('${uuid(503)}', 'Me');` },
  { marker: "合格：提問這台答過", name: "這台機器交過已上線（applied）的答案 → 排除", excluded: true, type: "question", taskId: MANUAL(4), target: { question_id: uuid(504) }, ...ME,
    setup: `INSERT INTO citizen_questions VALUES ('${uuid(504)}', 1); INSERT INTO contributions (task_id, contribution_type, status, contributor_ip_hash, agent_name) VALUES ('@T','question_answer','applied','ip-me','other-name');` },
  { marker: "合格：提問這台答過", name: "別的代號答過 → 照給", excluded: false, type: "question", taskId: MANUAL(5), target: { question_id: uuid(505) }, ...ME,
    setup: `INSERT INTO citizen_questions VALUES ('${uuid(505)}', 1); INSERT INTO question_answers VALUES ('${uuid(505)}', 'someone-else');` },
  // 裁決任務
  { marker: "合格：裁決任務", name: "這筆爭議已有 pending 裁決在等票 → 排除，不分誰來領", excluded: true, type: "adjudicate", taskId: MANUAL(6), target: { contribution_id: uuid(601), contributor: "z" }, ip: null, agent: null,
    setup: `INSERT INTO contributions (contribution_type, status, payload) VALUES ('adjudication', 'pending', '{"contribution_id":"${uuid(601)}"}');` },
  { marker: "合格：裁決任務", name: "原貢獻是他自己交的（大小寫不分）→ 排除", excluded: true, type: "adjudicate", taskId: MANUAL(7), target: { contribution_id: uuid(602), contributor: "ME" }, ...ME },
  { marker: "合格：裁決任務", name: "這台機器對原貢獻投過票 → 排除", excluded: true, type: "adjudicate", taskId: MANUAL(8), target: { contribution_id: uuid(603), contributor: "z" }, ...ME,
    setup: `INSERT INTO contribution_votes VALUES ('${uuid(603)}', 'ip-me');` },
  { marker: "合格：裁決任務", name: "別的機器投過票、別人交的、沒有裁決在等 → 照給", excluded: false, type: "adjudicate", taskId: MANUAL(9), target: { contribution_id: uuid(604), contributor: "z" }, ...ME,
    setup: `INSERT INTO contribution_votes VALUES ('${uuid(604)}', 'ip-other'); INSERT INTO contributions (contribution_type, status, payload) VALUES ('adjudication', 'rejected', '{"contribution_id":"${uuid(604)}"}');` },
  { marker: "合格：裁決任務", name: "沒有 ip／代號（rebalance 的呼叫方式）：只套「已有裁決在等」，不套投票與提交者", excluded: false, type: "adjudicate", taskId: MANUAL(10), target: { contribution_id: uuid(605), contributor: "me" }, ip: null, agent: null,
    setup: `INSERT INTO contribution_votes VALUES ('${uuid(605)}', 'ip-me');` },
];

async function runScenarios(db: PGlite, only?: (s: Scenario) => boolean): Promise<Array<{ s: Scenario; id: string; present: boolean }>> {
  const out: Array<{ s: Scenario; id: string; present: boolean }> = [];
  for (const s of SCENARIOS) {
    if (only && !only(s)) continue;
    const id = s.taskId ?? `auto:sc${++seq}`;
    await db.query(
      `INSERT INTO task_dispatches (task_id, task_type, target, queue_at) VALUES ($1, $2, $3::jsonb, now())`,
      [id, s.type ?? "policy_missing", JSON.stringify(s.target ?? {})],
    );
    if (s.setup) await db.exec(s.setup.replaceAll("@T", q(id)));
    const r = await db.query<{ task_id: string }>(`SELECT task_id FROM contribution_queue_tasks(NULL, NULL, 1000, '', $1, $2)`, [s.ip, s.agent]);
    out.push({ s, id, present: r.rows.some((x) => x.task_id === id) });
  }
  return out;
}

Deno.test("B1 劇本：每個合格條件該排除的排除、不該排除的照給（最新定義）", async () => {
  const db = await buildDb(QUEUE_SQL);
  try {
    const res = await runScenarios(db);
    const bad = res.filter((r) => r.present === r.s.excluded).map((r) => `${r.s.marker}｜${r.s.name}（${r.s.excluded ? "該排除卻出現" : "該出現卻被排除"}）`);
    assertEquals(bad, []);
    // 每個登記的標記都至少有一個「排除」劇本與一個「照給」劇本（不是只測一邊）
    for (const m of Object.values(REGISTRY).flatMap((e) => e.markers ?? [])) {
      assert(SCENARIOS.some((s) => s.marker === m && s.excluded), `標記 ${m} 沒有排除劇本`);
      assert(SCENARIOS.some((s) => s.marker === m && !s.excluded), `標記 ${m} 沒有照給劇本`);
    }
  } finally { await db.close(); }
});

Deno.test("B2 隊頭堵塞重現：最前面 35 筆都有查無回報在等票，後面 1 筆好的；取 30 筆要拿到好的（沒有 ip 與有 ip 都是）", async () => {
  const db = await buildDb(QUEUE_SQL);
  try {
    for (let i = 0; i < 35; i++) {
      const id = `auto:dead${String(i).padStart(2, "0")}`;
      await db.query(`INSERT INTO task_dispatches (task_id, task_type, target, queue_at) VALUES ($1, 'avatar_choice', '{}'::jsonb, '2016-01-01'::timestamptz + ($2 || ' seconds')::interval)`, [id, String(i)]);
      await db.query(`INSERT INTO contributions (contribution_type, status, payload) VALUES ('no_change', 'pending', $1::jsonb)`, [JSON.stringify({ task_id: id })]);
    }
    await db.query(`INSERT INTO task_dispatches (task_id, task_type, target, queue_at) VALUES ('auto:good', 'policy_missing', '{}'::jsonb, now())`);
    for (const [ip, agent] of [[null, null], ["ip-me", "me"]] as const) {
      const r = await db.query<{ task_id: string }>(`SELECT task_id FROM contribution_queue_tasks(NULL, NULL, 30, '', $1, $2)`, [ip, agent]);
      assertEquals(r.rows.map((x) => x.task_id), ["auto:good"]);
    }
  } finally { await db.close(); }
});

Deno.test("B3 還原驗證（行為）：把任一標記整段拿掉，該標記的「排除」劇本全部翻面（被排除的任務又出現）", async () => {
  const markers = [...new Set(SCENARIOS.map((s) => s.marker))];
  assertEquals(markers.sort(), Object.values(REGISTRY).flatMap((e) => e.markers ?? []).sort());
  for (const m of markers) {
    const db = await buildDb(stripBlock(QUEUE_SQL, m));
    try {
      const res = await runScenarios(db, (s) => s.marker === m && s.excluded);
      const stillExcluded = res.filter((r) => !r.present).map((r) => r.s.name);
      assertEquals(stillExcluded, [], `拿掉「${m}」之後這些劇本仍被排除：劇本沒有真的在測這一段（或別段重複擋了）`);
    } finally { await db.close(); }
  }
});

// ============================================================
// C. 隊頭監看
// ============================================================
Deno.test("C1 queue_head_stale：有可派的隊頭、卻超過門檻沒有任務派出 → 一列；最近有派出、或沒有可派的隊頭 → 空", async () => {
  const db = await buildDb(QUEUE_SQL);
  try {
    for (const fn of ["queue_head_stale_hours", "queue_head_stale"]) await db.exec(await latestFn(fn));
    const stale = async () => (await db.query<{ head_task_id: string }>(`SELECT head_task_id FROM queue_head_stale()`)).rows.map((r) => r.head_task_id);
    assertEquals(await stale(), [], "空佇列沒有隊頭");
    // 隊頭是死路（不可派）、第二筆好的才是可派隊頭
    await db.exec(`INSERT INTO task_dispatches (task_id, task_type, queue_at) VALUES ('auto:dead', 'avatar_choice', '2016-01-01'), ('auto:head', 'policy_missing', '2016-01-02');
      INSERT INTO contributions (contribution_type, status, payload) VALUES ('no_change', 'pending', '{"task_id":"auto:dead"}');`);
    assertEquals(await stale(), ["auto:head"], "從來沒派出過＝停擺，隊頭是排除死路之後的第一筆");
    await db.exec(`UPDATE task_dispatches SET last_dispatched_at = now() - interval '7 hours' WHERE task_id = 'auto:dead'`);
    assertEquals(await stale(), ["auto:head"], "7 小時前派過");
    await db.exec(`UPDATE task_dispatches SET last_dispatched_at = now() - interval '2 hours' WHERE task_id = 'auto:dead'`);
    assertEquals(await stale(), [], "2 小時前有派出＝沒停擺");
    await db.exec(`INSERT INTO task_dispatches (task_id, task_type, queue_at, last_dispatched_at) VALUES ('verify:x', 'v', '2016-01-03', now())`);
    await db.exec(`UPDATE task_dispatches SET last_dispatched_at = now() - interval '9 hours' WHERE task_id = 'auto:dead'`);
    assertEquals(await stale(), ["auto:head"], "verify: 列的派出不算任務派出");
    // activity_health 新分支的 SQL 真的跑得動（整支視圖依賴很多表，這裡只跑新加的那一段）
    const mig = await readMig(MIG);
    const branch = mig.slice(mig.indexOf("SELECT 'queue_head_stale', s.head_task_id,"), mig.indexOf("FROM queue_head_stale() s;") + "FROM queue_head_stale() s".length);
    const h = await db.query<{ check_name: string; subject: string; detail: string }>(branch.replace("SELECT 'queue_head_stale',", "SELECT 'queue_head_stale' AS check_name,"));
    assertEquals(h.rows.length, 1);
    assertEquals(Object.values(h.rows[0]!)[1], "auto:head");
    assertStringIncludes(String(Object.values(h.rows[0]!)[2]), "已超過 6 小時");
  } finally { await db.close(); }
});

Deno.test("C2 activity_health＝上一版（20261010020000）原樣＋最後多一個 queue_head_stale 分支；門檻函式是 6 小時", async () => {
  const view = (sql: string) => sql.slice(sql.indexOf("CREATE OR REPLACE VIEW activity_health AS"), sql.indexOf(";\nCOMMENT ON VIEW activity_health"));
  const prev = view(await readMig("20261010020000_system_vote_stall_health.sql"));
  const now = view(await readMig(MIG));
  const tail = `
  UNION ALL
  SELECT 'queue_head_stale', s.head_task_id,`;
  assertEquals(now.slice(0, prev.length), prev, "舊的分支一字不動");
  assertEquals(now.slice(prev.length).startsWith(tail), true);
  assertEquals((now.match(/queue_head_stale\(\) s/g) ?? []).length, 1);
  assertStringIncludes(await readMig(MIG), "SELECT 6 $$;");
});
