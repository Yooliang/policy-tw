/**
 * 手動任務也是一支派工臂：網站請求與公民提問排在所有加推之前、固定時段再插隊一次（2026-10-08 維護者；migration 20261008135000）。
 *
 *   「網站請求裡面的任務每 6 小時幫忙插隊一次，因為這個是有人在關注的東西」，公民提問一起照辦；「網站請求也可以視為一種缺口」。
 *
 * 做法（09-23 Disk IO 事故後的裁決：缺口由排程寫進 task_dispatches、/next 只讀佇列）：open 的 contribution_tasks 是派工臂 manual_visitor／manual_open，
 * seed 每 10 分鐘把它們寫進 task_dispatches（task_id＝任務 uuid），queue_at 在 SQL 裡算；/next 讀 contribution_queue_tasks，不再撈 contribution_tasks 清單。
 * 只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）。
 *
 *   A. 文字層：每一處都是「現行定義＋機械式替換」——總表（+2 行分支）、活動名（+2 名）、seed（4 處）、rebalance（1 處）、queue_preview（2 處）、
 *      contribution_queue_tasks（contribution_auto_tasks 複本，3 處）、觸發器（只差 WHEN）；沒動 contribution_auto_tasks／task_dispatched／queue_slot 等；
 *      /next 不再撈 contribution_tasks 清單、不再有 manualQueueAt
 *   B. PGlite（行為層）：真的 seed／rebalance／觸發器／讀取函式，28 個舊分支換成 stub
 *        1. 排進佇列：open 的手動任務一筆一列（uuid）、關閉的不進；網站請求／公民提問 1970、維護者建的與裁決 1980、提議排隊尾；公民提問依支持度排
 *        2. 與加推比先後：網站請求排在 1979-12-31 之前的加推前面；派出後回到隊尾
 *        3. 固定時段（假時鐘 app.queue_now）：時段內才把「本時段開始後還沒派出過」的拉回 1970；第二次 seed 冪等；時段外不動；其他任務與自動缺口不動
 *        4. 關閉＝缺口消失（觸發器立刻收回、seed 也收回，gap_events 有 closed；重開有 reopened）；內容每輪更新、位置不動
 *        5. 自動缺口的派工逐件不變（沒有手動任務時與舊 seed 的結果相同；有手動任務時自動缺口彼此的先後不變）；rebalance 不動 2000 年以前的列
 *        6. /tasks、/request-task 用的 contribution_auto_tasks 仍只回自動缺口；租約擋得住手動任務
 *
 * 每條守門的還原驗證見 PR 說明（拿掉被守的東西確認會紅）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { applyP2, buildArmsDb, fnText, type GapRow, latestFn, migrationNames, mutate, P0_MIG, P1_MIG, P2_ER_MIG, P2_PG_MIG, P2_PR_MIG, readMig } from "./arms-pglite.ts";

const MIG = "20261008135000_manual_tasks_as_arm.sql";
const QP_MIG = "20261008090000_queue_priority_tiers.sql";
const POP_MIG = "20261002000006_queue_pop_head.sql";
const LIN_MIG = "20261006034900_policy_lineages.sql";
const M = await readMig(MIG);
const PR = await readMig(P2_PR_MIG);
const QP = await readMig(QP_MIG);
const P0 = await readMig(P0_MIG);
const P1 = await readMig(P1_MIG);
const POP = await readMig(POP_MIG);
const LIN = await readMig(LIN_MIG);
const RESTUB = ["raw", "election_results", "party_gap", "party_roster"] as const;

// ============================================================
// A. 文字層
// ============================================================
const definersBefore = async (fn: string, before: string) => {
  const out: string[] = [];
  for (const n of await migrationNames()) if (n < before && (await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${fn}(`)) out.push(n);
  return out;
};

Deno.test("A1 抄的底是現行版：總表、seed 最後是 party_roster（121000）、rebalance 是 #443、queue_preview 是 policy_lineages、活動名是 P1、contribution_auto_tasks 是 queue_pop_head", async () => {
  const last = async (fn: string) => (await definersBefore(fn, MIG)).at(-1);
  assertEquals(await last("contribution_auto_tasks_arms"), P2_PR_MIG, "總表的底過期了：以最新那版為底重做");
  assertEquals(await last("seed_auto_task_queue"), P2_PR_MIG, "seed 的底過期了");
  assertEquals(await last("rebalance_queue"), QP_MIG, "rebalance 的底過期了");
  assertEquals(await last("queue_preview"), LIN_MIG, "queue_preview 的底過期了");
  assertEquals(await last("activity_arm_names"), P1_MIG, "活動名的底過期了");
  assertEquals(await last("contribution_auto_tasks"), POP_MIG, "contribution_auto_tasks 的底過期了（contribution_queue_tasks 是它的複本）");
});

Deno.test("A2 總表＝現行定義＋兩行 UNION ALL（manual_visitor、manual_open），其餘一字不差；活動名＝P1 的清單＋兩個名字", () => {
  const NEW_LINES = "  UNION ALL SELECT 'manual_visitor' AS arm, t.* FROM contribution_auto_tasks_manual(true) t\n  UNION ALL SELECT 'manual_open' AS arm, t.* FROM contribution_auto_tasks_manual(false) t\n";
  assertEquals(mutate(fnText(M, "contribution_auto_tasks_arms"), NEW_LINES, ""), fnText(PR, "contribution_auto_tasks_arms"));
  assertEquals(
    mutate(fnText(M, "activity_arm_names"), "    'owner_mismatch',\n    'manual_visitor',\n    'manual_open'\n  ]::TEXT[]", "    'owner_mismatch'\n  ]::TEXT[]"),
    fnText(P1, "activity_arm_names"),
  );
});

Deno.test("A3 seed＝現行定義＋四處機械式替換（兩處收回改「不是 verify:」、新列位置、固定時段插隊），其餘一字不差", () => {
  let s = fnText(M, "seed_auto_task_queue");
  s = mutate(s,
    "   WHERE d.task_id NOT LIKE 'verify:%'\n     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id)\n     AND EXISTS (SELECT 1 FROM _gaps_all a WHERE a.task_id = d.task_id);",
    "   WHERE d.task_id LIKE 'auto:%'\n     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id)\n     AND EXISTS (SELECT 1 FROM _gaps_all a WHERE a.task_id = d.task_id);");
  s = mutate(s,
    "   WHERE d.task_id NOT LIKE 'verify:%'\n     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);",
    "   WHERE d.task_id LIKE 'auto:%'\n     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);");
  s = mutate(s,
    "SELECT g.task_id, now(), COALESCE(CASE WHEN g.arm LIKE 'manual\\_%' THEN manual_front_at(g.task_id) END,\n                                    v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds'), 0,",
    "SELECT g.task_id, now(), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', 0,");
  s = mutate(s,
    "  -- >>> 網站請求／公民提問固定時段插隊（台北 00:00、06:00、12:00、18:00 各前 20 分鐘）：時段內才動，其餘時段什麼都不做\n  PERFORM manual_front_pull();\n  -- <<< 固定時段插隊\n  PERFORM rebalance_queue();\n",
    "  PERFORM rebalance_queue();\n");
  assertEquals(s, fnText(PR, "seed_auto_task_queue"));
});

Deno.test("A4 rebalance＝現行定義＋一處（可派任務的集合改讀 contribution_queue_tasks）；queue_preview＝現行定義＋兩處（任務列改讀它、手動任務那一段拿掉）", () => {
  assertEquals(
    mutate(fnText(M, "rebalance_queue"), "contribution_queue_tasks(NULL, NULL, 100000, '', NULL, NULL)", "contribution_auto_tasks(NULL, NULL, 100000, '', NULL, NULL)"),
    fnText(QP, "rebalance_queue"),
  );
  const MANUAL_BLOCK = `    UNION ALL
    SELECT 'task', t.id::TEXT, t.task_type, t.title, t.region,
           COALESCE(t.last_dispatched_at,
                    CASE WHEN t.source IN ('manual', 'auto_dispute', 'web_request') THEN TIMESTAMPTZ '1980-01-01' ELSE t.created_at END), 1
      FROM contribution_tasks t
     WHERE t.status = 'open'
`;
  let q = fnText(M, "queue_preview");
  q = mutate(q, "FROM contribution_queue_tasks(NULL, NULL, 100000, '', NULL, NULL) g\n    UNION ALL\n    SELECT 'verify'", "FROM contribution_auto_tasks(NULL, NULL, 100000, '', NULL, NULL) g\n" + MANUAL_BLOCK + "    UNION ALL\n    SELECT 'verify'");
  assertEquals(q, fnText(LIN, "queue_preview"));
  assert(!fnText(M, "queue_preview").includes("1980"), "預覽不再自己算 1980");
  assert(M.includes("REVOKE ALL ON FUNCTION queue_preview(INTEGER) FROM public;") && M.includes("GRANT EXECUTE ON FUNCTION queue_preview(INTEGER) TO anon, authenticated;"));
});

Deno.test("A5 contribution_queue_tasks＝contribution_auto_tasks 現行版的複本，只差名字、任務列範圍（auto: → 不是 verify:）與同位次的排序（公民提問依支持度）", () => {
  let q = fnText(M, "contribution_queue_tasks");
  q = mutate(q, "CREATE OR REPLACE FUNCTION contribution_queue_tasks(", "CREATE OR REPLACE FUNCTION contribution_auto_tasks(");
  q = mutate(q, "WHERE d.task_id NOT LIKE 'verify:%' AND d.task_type IS NOT NULL", "WHERE d.task_id LIKE 'auto:%' AND d.task_type IS NOT NULL");
  q = mutate(q,
    "  -- 同一個 queue_at 內：公民提問依支持度（target.stance_up，排程寫入）高的先、再依進佇列時間；自動缺口沒有 stance_up，這兩個鍵對它們全是 NULL，順序與 contribution_auto_tasks 一樣\n" +
    "  ORDER BY d.queue_at ASC,\n" +
    "           CASE WHEN jsonb_typeof(d.target->'stance_up') = 'number' THEN (d.target->>'stance_up')::NUMERIC END DESC NULLS LAST,\n" +
    "           CASE WHEN jsonb_typeof(d.target->'stance_up') = 'number' THEN d.opened_at END ASC NULLS LAST,\n" +
    "           d.task_id\n",
    "  ORDER BY d.queue_at ASC, d.task_id\n");
  assertEquals(q, fnText(POP, "contribution_auto_tasks"));
});

Deno.test("A6 缺口出生／收回的觸發器：WHEN 條件從 auto: 改成「不是 verify:」，其餘與 P0 一字不差", () => {
  const a = P0.indexOf("DROP TRIGGER IF EXISTS trg_task_dispatches_gap_before_insert");
  const old = P0.slice(a, P0.indexOf("-- task_dispatches_drop_applied（貢獻 applied 時收回缺口）")).trimEnd() + "\n";
  const b = M.indexOf("DROP TRIGGER IF EXISTS trg_task_dispatches_gap_before_insert");
  const tail = "EXECUTE FUNCTION task_dispatches_gap_after_delete();" + String.fromCharCode(10);
  const now = M.slice(b, M.indexOf(tail, b) + tail.length);
  assertEquals(now.replaceAll("NOT LIKE 'verify:%'", "LIKE 'auto:%'"), old);
  assertEquals((old.match(/LIKE 'auto:%'/g) ?? []).length, 3);
});

Deno.test("A7 沒動 contribution_auto_tasks／task_dispatched／queue_slot／refresh_dispatch_blocked／task_boost 等；只加不刪", () => {
  const code = M.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const untouched of ["contribution_auto_tasks", "task_dispatched", "queue_slot", "refresh_dispatch_blocked", "task_boost", "task_boost_matches", "contribution_auto_task_counts", "contribution_verify_pool", "activity_priority", "activity_open"]) {
    assert(!new RegExp(`CREATE OR REPLACE FUNCTION ${untouched}\\(`).test(code), `這支不改 ${untouched}`);
  }
  assert(!/DROP FUNCTION|DROP COLUMN|DROP TABLE (?!IF EXISTS _)|TRUNCATE/.test(code), "只加不刪（seed 自己的暫存表 _gaps 不算）");
});

Deno.test("A8 時段與常數只在 SQL：每 6 小時、前 20 分鐘、台北時區、1970；TS 沒有第二份", async () => {
  assert(M.includes("visitor_front_slot_hours() RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$ SELECT 6 $$"));
  assert(M.includes("visitor_front_window_minutes() RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$ SELECT 20 $$"));
  assert(M.includes("visitor_front_at() RETURNS TIMESTAMPTZ LANGUAGE sql IMMUTABLE AS $$ SELECT TIMESTAMPTZ '1970-01-01 00:00:00+00' $$"));
  assert(M.includes("p_tz TEXT DEFAULT 'Asia/Taipei'"));
  const dispatch = await Deno.readTextFile(new URL("./dispatch.ts", import.meta.url));
  for (const gone of ["manualQueueAt", "QUEUE_FRONT", "FRONT_SOURCES", "QUEUE_VISITOR_FRONT", "VISITOR_REQUEUE"]) assert(!dispatch.includes(gone), `TS 不再自己算排位：${gone}`);
});

Deno.test("A9 /next 只讀佇列：不撈 contribution_tasks 清單、沒有 manualQueueAt、讀 contribution_queue_tasks、派出走 task_dispatched；選中手動任務才用 id 單筆查", async () => {
  const src = (await Deno.readTextFile(new URL("../next/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  assert(!src.includes("manualQueueAt") && !src.includes("pickQueuedManual") && !src.includes("sortQuestionTasksBySupport"));
  assert(src.includes('supabase.rpc("contribution_queue_tasks"'), "任務清單改讀 contribution_queue_tasks");
  assert(!src.includes('rpc("contribution_auto_tasks"'));
  // contribution_tasks 只剩一處，而且是「選中那一筆」的單筆查：.eq("id", …).eq("status", "open").maybeSingle()，沒有 .limit／.order／.in
  const uses = src.split('.from("contribution_tasks")').length - 1;
  assertEquals(uses, 1);
  const at = src.indexOf('.from("contribution_tasks")');
  const chain = src.slice(at, src.indexOf(";", at));
  assert(/\.eq\("id", manualHead!\.task_id\)\s*\.eq\("status", "open"\)\s*\.maybeSingle\(\)/.test(chain), chain);
  assert(!/\.(limit|order|in|range)\(/.test(chain), "單筆查不能是清單");
  assert(!src.includes("last_dispatched_at"), "不再寫 contribution_tasks.last_dispatched_at（派出蓋章走 task_dispatched）");
  assertEquals(src.split('rpc("task_dispatched"').length - 1, 4, "跳過、驗證、手動任務、自動缺口各一處");
});

// ============================================================
// B. PGlite（行為層）
// ============================================================
type Db = PGlite;
const rows = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T> => (await rows<T>(db, sql, params))[0];

const G = (id: string, type: string, target: Record<string, unknown> | null): GapRow =>
  ({ task_id: `auto:${id}`, task_type: type, target, what_we_need: `說明 ${id}`, hint_sources: ["h1"], reward: 1, region: "台北市" });
const E26 = { election_id: 2026, election_type: "縣市長" };
const BRANCHES = {
  term_policies: [G("tp1", "term_policy_missing", E26), G("tp2", "term_policy_missing", E26), G("tp3", "term_policy_missing", E26)],
  dup: [G("dup1", "duplicate_politician", null)],
};
const AUTO_IDS = ["auto:dup1", "auto:tp1", "auto:tp2", "auto:tp3"];

const W1 = "00000000-0000-4000-8000-0000000000a1"; // 網站請求 policy_missing
const W2 = "00000000-0000-4000-8000-0000000000a2"; // 網站請求 profile_gap
const Q1 = "00000000-0000-4000-8000-0000000000b1"; // 公民提問（維護者建，source=manual）支持度 5
const Q2 = "00000000-0000-4000-8000-0000000000b2"; // 公民提問（網站，source=web_request）支持度 9
const M1 = "00000000-0000-4000-8000-0000000000c1"; // 維護者建
const D1 = "00000000-0000-4000-8000-0000000000c2"; // 裁決
const S1 = "00000000-0000-4000-8000-0000000000c3"; // 外部提議
const X1 = "00000000-0000-4000-8000-0000000000d1"; // 網站請求，已關閉
const QID1 = "00000000-0000-4000-8000-0000000000e1";
const QID2 = "00000000-0000-4000-8000-0000000000e2";

const PREREQ = async () => `
CREATE TABLE politicians (id uuid PRIMARY KEY, name text NOT NULL, merged_into uuid);
CREATE TABLE politician_elections (id integer PRIMARY KEY, politician_id uuid NOT NULL);
${await latestFn("politician_name_is_placeholder")}
ALTER TABLE elections ADD COLUMN bulletin_published_on date;
UPDATE elections SET bulletin_published_on = DATE '2026-11-18' WHERE id = 2026;
ALTER TABLE contributions ADD COLUMN contributor_ip_hash text, ADD COLUMN agent_name text, ADD COLUMN payload jsonb;
CREATE TABLE contribution_task_leases (task_id text, target_key text, leased_until timestamptz, agent_name text);
${await latestFn("task_target_key")}
DROP FUNCTION queue_slot(text);
${await latestFn("queue_slot")}
${await latestFn("contribution_auto_tasks")}
${await latestFn("task_dispatched")}
CREATE TABLE contribution_tasks (
  id uuid PRIMARY KEY, title text NOT NULL, description text, task_type text NOT NULL, target jsonb NOT NULL DEFAULT '{}'::jsonb, region text,
  priority integer NOT NULL DEFAULT 1, reward integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'open', source text NOT NULL DEFAULT 'manual',
  suggested_by text, hint_sources text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE citizen_questions (id uuid PRIMARY KEY, stance_up integer NOT NULL DEFAULT 0, answer_count integer NOT NULL DEFAULT 0);
CREATE OR REPLACE FUNCTION contribution_queue_at(t text, k text, c timestamptz) RETURNS timestamptz LANGUAGE sql AS $$ SELECT queue_slot('verify') $$;
${QP}
`;

const TASKS_SQL = `
INSERT INTO citizen_questions (id, stance_up) VALUES ('${QID1}', 5), ('${QID2}', 9);
INSERT INTO contribution_tasks (id, title, description, task_type, target, region, priority, source, suggested_by, created_at, status) VALUES
 ('${W1}', '查政見', '請查他的政見', 'policy_missing', '{"politician_id":"pol-1"}', '台北市', 0, 'web_request', NULL, '2026-09-28 01:00+00', 'open'),
 ('${W2}', '查簡介', NULL, 'profile_gap', '{"politician_id":"pol-2"}', '新北市', 0, 'web_request', NULL, '2026-09-26 14:00+00', 'open'),
 ('${Q1}', '提問一', '他說要蓋長照據點嗎？', 'question', '{"question_id":"${QID1}"}', NULL, 3, 'manual', NULL, '2026-10-01 00:00+00', 'open'),
 ('${Q2}', '提問二', '預算多少？', 'question', '{"question_id":"${QID2}"}', NULL, 3, 'web_request', NULL, '2026-10-02 00:00+00', 'open'),
 ('${M1}', '維護者任務', '查這份文件', 'audit', '{"policy_id":"pl-1"}', NULL, 1, 'manual', NULL, '2026-09-20 00:00+00', 'open'),
 ('${D1}', '裁決', NULL, 'adjudication', '{"contribution_id":"x1"}', NULL, 2, 'auto_dispute', NULL, '2026-09-21 00:00+00', 'open'),
 ('${S1}', '提議', '外部代理提議', 'politician_profile', '{"politician_id":"pol-3"}', NULL, 1, 'suggested', 'agent-z', '2026-09-22 00:00+00', 'open'),
 ('${X1}', '已結案的請求', NULL, 'policy_missing', '{"politician_id":"pol-9"}', NULL, 0, 'web_request', NULL, '2026-09-25 00:00+00', 'closed');
`;

type BuildOpts = { withMine?: boolean; withTasks?: boolean; mutateMig?: (s: string) => string };
async function buildDb(o: BuildOpts = {}): Promise<Db> {
  const withMine = o.withMine ?? true;
  const migs = [{ name: P2_ER_MIG }, { name: P2_PG_MIG }, { name: P2_PR_MIG }];
  const db = await buildArmsDb({ branches: BRANCHES, afterP1Sql: await PREREQ(), p2: { migs, restub: RESTUB } });
  await db.exec("SET app.activity_today = '2026-10-08'");
  if (o.withTasks ?? true) await db.exec(TASKS_SQL);
  if (withMine) await applyP2(db, (o.mutateMig ?? ((s) => s))(M), RESTUB);
  return db;
}

const TASK_ROWS = `SELECT task_id, queue_at, priority::int AS priority, dispatch_count::int AS n, last_dispatched_at, task_type, target, opened_by FROM task_dispatches WHERE task_id !~ '^(auto|verify):' ORDER BY task_id COLLATE "C"`;
const qat = async (db: Db, id: string) => (await one<{ q: string }>(db, `SELECT to_char(queue_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS q FROM task_dispatches WHERE task_id = $1`, [id])).q;
const hasRow = async (db: Db, id: string) => (await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM task_dispatches WHERE task_id = $1`, [id])).n === 1;
const head = async (db: Db, n = 100, ip: string | null = null, agent: string | null = null) =>
  (await rows<{ task_id: string }>(db, `SELECT task_id FROM contribution_queue_tasks(NULL, NULL, $1, '', $2, $3)`, [n, ip, agent])).map((r) => r.task_id);
const seed = async (db: Db, now?: string) => {
  await db.exec(now ? `SET app.queue_now = '${now}'` : `RESET app.queue_now`);
  await db.exec("SET app.activity_today = '2026-10-08'");
  return (await one<{ n: number }>(db, `SELECT seed_auto_task_queue() AS n`)).n;
};
/** 模擬一次派出：蓋章（task_dispatched 用真的 now()）之後把派出時間改成劇本裡的時間 */
const dispatchAt = async (db: Db, id: string, at: string) => {
  await db.query(`SELECT task_dispatched($1)`, [id]);
  await db.query(`UPDATE task_dispatches SET last_dispatched_at = $2::timestamptz WHERE task_id = $1`, [id, at]);
};
const FRONT = "1970-01-01T00:00:00";
const MAINT = "1980-01-01T00:00:00";
const isTail = async (db: Db, id: string) => (await one<{ t: boolean }>(db, `SELECT queue_at >= TIMESTAMPTZ '2000-01-01' AS t FROM task_dispatches WHERE task_id = $1`, [id])).t;

Deno.test("B1 派工臂：排進佇列、queue_at、優先層、出生紀錄、公民提問依支持度、與加推比先後", async (t) => {
  const db = await buildDb();
  try {
    await seed(db);
    await t.step("每個 open 的手動任務一列（uuid），關閉的不進；自動缺口照舊", async () => {
      const r = await rows<{ task_id: string }>(db, TASK_ROWS);
      assertEquals(r.map((x) => x.task_id).sort(), [W1, W2, Q1, Q2, M1, D1, S1].sort());
      assert(!(await hasRow(db, X1)));
      assertEquals((await rows(db, `SELECT task_id FROM task_dispatches WHERE task_id LIKE 'auto:%' ORDER BY 1`)).length, AUTO_IDS.length);
    });
    await t.step("queue_at：網站請求與公民提問 1970、維護者建的與裁決 1980、提議排隊尾", async () => {
      for (const id of [W1, W2, Q1, Q2]) assertEquals(await qat(db, id), FRONT, id);
      for (const id of [M1, D1]) assertEquals(await qat(db, id), MAINT, id);
      assert(await isTail(db, S1));
    });
    await t.step("優先層：網站請求與公民提問＝前段（層 1），其餘預設層；出生紀錄帶臂名與規則", async () => {
      const tiers = await rows<{ id: number; is_default: boolean }>(db, `SELECT id::int, is_default FROM task_priority_tiers ORDER BY id`);
      const dflt = tiers.find((x) => x.is_default)!.id;
      const r = Object.fromEntries((await rows<{ task_id: string; priority: number; opened_by: Record<string, unknown> }>(db, TASK_ROWS)).map((x) => [x.task_id, x]));
      for (const id of [W1, W2, Q1, Q2]) {
        assertEquals(r[id].priority, 1, id);
        assertEquals(r[id].opened_by.arm, "manual_visitor");
      }
      for (const id of [M1, D1, S1]) {
        assertEquals(r[id].priority, dflt, id);
        assertEquals(r[id].opened_by.arm, "manual_open");
      }
      const ev = await rows<{ task_id: string; event: string }>(db, `SELECT task_id, event FROM gap_events WHERE task_id !~ '^(auto|verify):' ORDER BY task_id`);
      assertEquals(ev.length, 7);
      assert(ev.every((e) => e.event === "opened"));
    });
    await t.step("內容：task_type／target 照任務表帶，原 target 的鍵保留；補 title、region；公民提問帶 stance_up", async () => {
      const r = Object.fromEntries((await rows<{ task_id: string; target: Record<string, unknown>; task_type: string }>(db, TASK_ROWS)).map((x) => [x.task_id, x]));
      assertEquals(r[W1].task_type, "policy_missing");
      assertEquals(r[W1].target.politician_id, "pol-1");
      assertEquals(r[W1].target.title, "查政見");
      assertEquals(r[W1].target.region, "台北市");
      assertEquals(r[Q2].target.question_id, QID2);
      assertEquals(r[Q2].target.stance_up, 9);
      assertEquals(r[Q1].target.stance_up, 5);
      assert(!("stance_up" in r[W1].target), "只有公民提問帶支持度");
      const d = await one<{ what_we_need: string; reward: number }>(db, `SELECT what_we_need, reward FROM task_dispatches WHERE task_id = $1`, [W2]);
      assertEquals(d.what_we_need, "查簡介", "沒有 description 就用 title");
    });
    await t.step("與加推比先後：網站請求排在 1979-12-31 之前的加推前面；公民提問依支持度高的先", async () => {
      await db.exec(`UPDATE task_dispatches SET queue_at = TIMESTAMPTZ '1979-12-31 23:50:00+00' WHERE task_id = 'auto:tp1'`);
      await db.exec(`UPDATE task_dispatches SET queue_at = TIMESTAMPTZ '1980-01-01 00:00:00+00' - INTERVAL '3 minutes' WHERE task_id = 'auto:tp2'`);
      const order = await head(db);
      assertEquals(order.slice(0, 8), [Q2, Q1, W1, W2, "auto:tp1", "auto:tp2", M1, D1]);
      assert(order.indexOf(S1) > 7 && order.includes("auto:tp3"));
    });
    await t.step("派出後回到隊尾（跟所有缺口一樣）：離開最前、dispatch_count＋1", async () => {
      await db.query(`SELECT task_dispatched($1)`, [W1]);
      assert(await isTail(db, W1));
      assertEquals((await one<{ n: number }>(db, `SELECT dispatch_count::int AS n FROM task_dispatches WHERE task_id = $1`, [W1])).n, 1);
      assertEquals((await head(db)).slice(0, 3), [Q2, Q1, W2]);
    });
  } finally {
    await db.close();
  }
});

Deno.test("B2 固定時段插隊（假時鐘 app.queue_now）：時段內才拉、冪等、時段外不動、只動網站請求與公民提問", async (t) => {
  const db = await buildDb();
  try {
    await t.step("時段函式：台北 00:00／06:00／12:00／18:00 各前 20 分鐘", async () => {
      const at = async (ts: string) => (await one<{ s: string | null }>(db, `SELECT to_char(visitor_front_slot_start($1::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS s`, [ts])).s;
      const cases: Array<[string, string | null]> = [
        ["2026-10-08 15:59:59+00", null], // 台北 23:59:59
        ["2026-10-08 16:00:00+00", "2026-10-08T16:00:00"], // 台北 00:00:00
        ["2026-10-08 16:19:59+00", "2026-10-08T16:00:00"],
        ["2026-10-08 16:20:00+00", null],
        ["2026-10-08 21:59:59+00", null], // 台北 05:59:59
        ["2026-10-08 22:00:00+00", "2026-10-08T22:00:00"], // 台北 06:00
        ["2026-10-09 04:10:00+00", "2026-10-09T04:00:00"], // 台北 12:10
        ["2026-10-09 10:19:00+00", "2026-10-09T10:00:00"], // 台北 18:19
        ["2026-10-09 10:21:00+00", null],
        ["2026-10-08 00:05:00+00", null], // 台北 08:05（不是 6 的倍數）
        ["2026-10-08 12:00:00+00", null], // 台北 20:00
      ];
      for (const [ts, want] of cases) assertEquals(await at(ts), want, ts);
      await db.exec(`SET app.queue_now = '2026-10-09 12:00:30+08'`);
      assertEquals((await one<{ s: string }>(db, `SELECT to_char(visitor_front_slot_start() AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD"T"HH24:MI:SS') AS s`)).s, "2026-10-09T12:00:00");
      await db.exec(`RESET app.queue_now`);
    });

    await seed(db, "2026-10-09 10:00:00+08"); // 時段外：第一輪 seed，建立所有列
    // 派出時間的劇本（台北時間）：W1、W2、M1、S1 在 11:00～11:30 派出過（都在 12:00 這個時段開始之前）
    await dispatchAt(db, W1, "2026-10-09 11:30:00+08");
    await dispatchAt(db, W2, "2026-10-09 11:00:00+08");
    await dispatchAt(db, M1, "2026-10-09 11:00:00+08");
    await dispatchAt(db, S1, "2026-10-09 11:00:00+08");
    await dispatchAt(db, "auto:tp3", "2026-10-09 11:00:00+08");
    await dispatchAt(db, Q1, "2026-10-09 11:10:00+08");

    await t.step("時段外（台北 11:50）：seed 不動它們的位置，派出後照常在隊尾", async () => {
      const before = await rows(db, `SELECT task_id, queue_at FROM task_dispatches WHERE queue_at < TIMESTAMPTZ '2000-01-01' ORDER BY task_id`);
      assertEquals((await one<{ n: number }>(db, `SELECT manual_front_pull() AS n`)).n, 0);
      await seed(db, "2026-10-09 11:50:00+08");
      for (const id of [W1, W2, Q1]) assert(await isTail(db, id), id);
      assertEquals(await rows(db, `SELECT task_id, queue_at FROM task_dispatches WHERE queue_at < TIMESTAMPTZ '2000-01-01' AND task_id NOT IN ('${W1}','${W2}','${Q1}') ORDER BY task_id`),
        before.filter((r) => ![W1, W2, Q1].includes(r.task_id as string)));
    });

    await t.step("時段內（台北 12:00:30）：本時段開始後還沒派出過的網站請求與公民提問回到 1970；維護者任務、提議、自動缺口不動", async () => {
      await db.exec(`SET app.queue_now = '2026-10-09 12:00:30+08'`);
      const tailsBefore = Object.fromEntries(await Promise.all([M1, S1, "auto:tp3"].map(async (id) => [id, await isTail(db, id)])));
      await seed(db, "2026-10-09 12:00:30+08");
      for (const id of [W1, W2, Q1, Q2]) assertEquals(await qat(db, id), FRONT, id);
      for (const id of [M1, S1, "auto:tp3"]) assertEquals(await isTail(db, id), tailsBefore[id], `${id} 不該被動`);
      assertEquals(await qat(db, D1), MAINT);
      assertEquals((await head(db)).slice(0, 4), [Q2, Q1, W1, W2]);
    });

    await t.step("同一個時段內第二次 seed（12:10）冪等：12:05 被領走的不會又被拉回最前，還沒被領走的不動", async () => {
      await dispatchAt(db, W2, "2026-10-09 12:05:00+08"); // 時段內被領走
      assert(await isTail(db, W2));
      const before = await rows(db, `SELECT task_id, queue_at FROM task_dispatches WHERE task_id IN ('${W1}','${Q1}','${Q2}') ORDER BY task_id`);
      await seed(db, "2026-10-09 12:10:00+08");
      assert(await isTail(db, W2), "本時段開始後已派出過，不再拉");
      assertEquals(await rows(db, `SELECT task_id, queue_at FROM task_dispatches WHERE task_id IN ('${W1}','${Q1}','${Q2}') ORDER BY task_id`), before);
      assertEquals((await one<{ n: number }>(db, `SELECT manual_front_pull() AS n`)).n, 0, "再跑一次什麼都沒有可拉");
    });

    await t.step("時段結束（12:20）之後什麼都不動：18:00 這個時段再拉一次", async () => {
      await dispatchAt(db, W1, "2026-10-09 12:15:00+08");
      await seed(db, "2026-10-09 12:20:00+08");
      assert(await isTail(db, W1) && await isTail(db, W2));
      await seed(db, "2026-10-09 17:50:00+08");
      assert(await isTail(db, W1) && await isTail(db, W2));
      await seed(db, "2026-10-09 18:00:10+08");
      for (const id of [W1, W2]) assertEquals(await qat(db, id), FRONT, id);
      assert(await isTail(db, M1), "維護者任務沒被拉");
    });

    await t.step("已關閉的任務不被拉（沒有派工列）；從沒派過的列在時段內也維持 1970", async () => {
      await db.exec(`UPDATE contribution_tasks SET status = 'closed' WHERE id = '${Q2}'`);
      assert(!(await hasRow(db, Q2)));
      await seed(db, "2026-10-10 06:00:10+08");
      assert(!(await hasRow(db, Q2)));
      assertEquals(await qat(db, Q1), FRONT);
    });
  } finally {
    await db.close();
  }
});

Deno.test("B3 關閉＝缺口消失（觸發器與 seed 都收回，gap_events 記 closed／reopened）；內容每輪更新、位置不動", async (t) => {
  const db = await buildDb();
  try {
    await seed(db);
    await t.step("任務一關閉就立刻收回派工列，closed 事件帶 via＝task_closed", async () => {
      await db.exec(`UPDATE contribution_tasks SET status = 'closed' WHERE id = '${M1}'`);
      assert(!(await hasRow(db, M1)));
      const ev = await one<{ event: string; reason: string; via: string }>(db, `SELECT event, reason, detail->>'via' AS via FROM gap_events WHERE task_id = $1 ORDER BY id DESC LIMIT 1`, [M1]);
      assertEquals([ev.event, ev.reason, ev.via], ["closed", "filled", "task_closed"]);
    });
    await t.step("重開後下一輪 seed 排回來（reopened）；位置照維護者任務的規則 1980", async () => {
      await db.exec(`UPDATE contribution_tasks SET status = 'open' WHERE id = '${M1}'`);
      assert(!(await hasRow(db, M1)), "seed 之前還沒有");
      await seed(db);
      assertEquals(await qat(db, M1), MAINT);
      const ev = await one<{ event: string }>(db, `SELECT event FROM gap_events WHERE task_id = $1 ORDER BY id DESC LIMIT 1`, [M1]);
      assertEquals(ev.event, "reopened");
    });
    await t.step("觸發器漏掉的（停用觸發器模擬）由 seed 收回；刪除任務也收回", async () => {
      await db.exec(`ALTER TABLE contribution_tasks DISABLE TRIGGER USER`);
      await db.exec(`UPDATE contribution_tasks SET status = 'closed' WHERE id = '${D1}'`);
      await db.exec(`DELETE FROM contribution_tasks WHERE id = '${S1}'`);
      assert(await hasRow(db, D1) && await hasRow(db, S1), "觸發器停用時還在");
      await db.exec(`ALTER TABLE contribution_tasks ENABLE TRIGGER USER`);
      await seed(db);
      assert(!(await hasRow(db, D1)) && !(await hasRow(db, S1)));
      const ev = await rows<{ event: string }>(db, `SELECT event FROM gap_events WHERE task_id = $1 ORDER BY id DESC LIMIT 1`, [D1]);
      assertEquals(ev[0].event, "closed");
    });
    await t.step("內容每輪更新、排隊位置不動；支持度變了，公民提問的先後跟著變", async () => {
      const q1 = await qat(db, Q1);
      await db.exec(`UPDATE contribution_tasks SET title = '新標題', target = target || '{"extra":1}'::jsonb WHERE id = '${Q1}'`);
      await db.exec(`UPDATE citizen_questions SET stance_up = 20 WHERE id = '${QID1}'`);
      await seed(db);
      const r = await one<{ target: Record<string, unknown> }>(db, `SELECT target FROM task_dispatches WHERE task_id = $1`, [Q1]);
      assertEquals([r.target.title, r.target.extra, r.target.stance_up], ["新標題", 1, 20]);
      assertEquals(await qat(db, Q1), q1);
      assertEquals((await head(db)).slice(0, 2), [Q1, Q2], "支持度 20 > 9");
    });
  } finally {
    await db.close();
  }
});

Deno.test("B4 自動缺口逐件不變：沒有手動任務時 seed 的結果與舊 seed 相同；有手動任務時自動缺口彼此的先後不變；rebalance 不動 2000 年以前的列", async (t) => {
  const oldDb = await buildDb({ withMine: false, withTasks: false });
  const newEmpty = await buildDb({ withTasks: false });
  const newFull = await buildDb();
  try {
    const dump = (db: Db) => rows(db, `SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region, priority, dispatch_count FROM task_dispatches WHERE task_id LIKE 'auto:%' ORDER BY queue_at, task_id COLLATE "C"`);
    await t.step("沒有手動任務：回傳值、列、內容、先後逐件相同", async () => {
      // 新的 migration 套上時已經跑過一次 seed（套上就先算一次），所以兩邊都再跑一輪，之後的狀態逐件比
      assertEquals(await seed(oldDb), 4, "舊 seed 排進 4 個自動缺口");
      assertEquals(await seed(oldDb), 0);
      assertEquals(await seed(newEmpty), 0, "migration 套上時已經排好");
      assertEquals((await dump(newEmpty)).length, 4);
      assertEquals(await dump(newEmpty), await dump(oldDb));
      assertEquals((await rows(newEmpty, TASK_ROWS)).length, 0);
    });
    await t.step("有手動任務：自動缺口各層內部的先後與舊 seed 一樣；手動任務都在 2000 年以前（不進交錯）時，自動缺口整體的先後也一樣", async () => {
      await seed(newFull);
      const perTier = (r: Array<Record<string, unknown>>) => {
        const m = new Map<unknown, unknown[]>();
        for (const x of r) m.set(x.priority, [...(m.get(x.priority) ?? []), x.task_id]);
        return [...m.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
      };
      assertEquals(perTier(await dump(newFull)), perTier(await dump(oldDb)));
      // 提議（S1）是唯一排在隊尾、會進交錯的手動任務：它佔預設層的一格，所以別層與預設層之間的穿插會變（這是「跟其他缺口一樣」的代價）。把它關掉再比，整體先後就完全一樣
      await newFull.exec(`UPDATE contribution_tasks SET status = 'closed' WHERE id = '${S1}'`);
      await newFull.exec(`SELECT rebalance_queue()`);
      await oldDb.exec(`SELECT rebalance_queue()`);
      assertEquals((await dump(newFull)).map((r) => r.task_id), (await dump(oldDb)).map((r) => r.task_id));
    });
    await t.step("rebalance 不動 2000 年以前的列（加推、1970、1980）；2000 年以後的手動任務列進交錯", async () => {
      await newFull.exec(`UPDATE task_dispatches SET queue_at = TIMESTAMPTZ '1979-12-31 23:50:00+00' WHERE task_id = 'auto:tp1'`);
      const before = await rows(newFull, `SELECT task_id, queue_at FROM task_dispatches WHERE queue_at < TIMESTAMPTZ '2000-01-01' ORDER BY task_id`);
      assert(before.length >= 7);
      await newFull.exec(`SELECT rebalance_queue()`);
      assertEquals(await rows(newFull, `SELECT task_id, queue_at FROM task_dispatches WHERE queue_at < TIMESTAMPTZ '2000-01-01' ORDER BY task_id`), before);
      await dispatchAt(newFull, W1, "2026-10-09 11:30:00+08");
      await newFull.exec(`SELECT rebalance_queue()`);
      const w1 = await one<{ q: boolean; ready: boolean }>(newFull, `SELECT d.queue_at >= TIMESTAMPTZ '2000-01-01' AS q, EXISTS (SELECT 1 FROM contribution_queue_tasks(NULL, NULL, 100000, '', NULL, NULL) g WHERE g.task_id = d.task_id) AS ready FROM task_dispatches d WHERE d.task_id = $1`, [W1]);
      assert(w1.q && w1.ready);
    });
  } finally {
    await oldDb.close();
    await newEmpty.close();
    await newFull.close();
  }
});

Deno.test("B5 /tasks、/request-task 用的 contribution_auto_tasks 仍只回自動缺口；contribution_queue_tasks 兩種都回；租約擋得住手動任務", async (t) => {
  const db = await buildDb();
  try {
    await seed(db);
    await t.step("contribution_auto_tasks 沒有手動任務、contribution_queue_tasks 有 7 筆", async () => {
      const a = await rows<{ task_id: string }>(db, `SELECT task_id FROM contribution_auto_tasks(NULL, NULL, 100000, '', NULL, NULL)`);
      assert(a.length > 0 && a.every((r) => r.task_id.startsWith("auto:")));
      const q = await head(db, 100000);
      assertEquals(q.filter((id) => !id.startsWith("auto:")).sort(), [W1, W2, Q1, Q2, M1, D1, S1].sort());
      assertEquals(q.filter((id) => id.startsWith("auto:")).sort(), a.map((r) => r.task_id).sort());
    });
    await t.step("別人的租約擋掉手動任務（依目標：politician:pol-2）；自己的不擋", async () => {
      await db.exec(`INSERT INTO contribution_task_leases (task_id, target_key, leased_until, agent_name) VALUES ('${W2}', 'politician:pol-2', now() + interval '10 minutes', 'someone-else')`);
      assert(!(await head(db, 100, "ip-me", "me")).includes(W2));
      assert((await head(db, 100, "ip-me", "someone-else")).includes(W2));
      assert((await head(db, 100)).includes(W2), "沒帶來源 IP（/tasks 式的讀法）不看租約，與自動缺口一樣");
    });
    await t.step("p_region 篩得到手動任務（派工列的 region 欄）", async () => {
      const r = (await rows<{ task_id: string }>(db, `SELECT task_id FROM contribution_queue_tasks('policy_missing', '台北市', 100, '', NULL, NULL)`)).map((x) => x.task_id);
      assertEquals(r, [W1]);
    });
  } finally {
    await db.close();
  }
});
