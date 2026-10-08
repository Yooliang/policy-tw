/**
 * 派工與排程的啟用時間窗，P0（2026-10-08，docs/PLAN-task-activation.md；migration 20261008001000_activity_windows_p0.sql）。
 *
 * P0 只建表與函式、沒有人呼叫；唯一碰到線上行為的是 seed_auto_task_queue()。守門分兩半，都只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）：
 *
 *   A. 文字層（不開資料庫）
 *      1. 這支 migration 是 seed_auto_task_queue、task_dispatches_drop_applied 的「緊接著的下一版」——中間沒有別人插一版（插了，我們抄的底就過期了）
 *      2. seed 新函式＝20261002000007 的現行定義加 INSERT 兩處欄位清單（opened_at、opened_by），其餘一字不差，函式裡沒有 gap_events；
 *         drop_applied 新函式＝20260924000001 的現行定義（與正式庫一字不差，2026-10-08 比對過）加標記起訖的兩段 set_config，其餘一字不差
 *      3. 還原驗證：動一個不該動的字、少一處機械替換，上面那條都要紅
 *
 *   事件由 task_dispatches 上的觸發器統一寫（不靠各呼叫端）：seed、貢獻 applied 的收回、/next 的 task_dispatched 三條路都測。
 *
 *   B. PGlite（行為層）：stub 表灌正式庫唯讀快照（四場選舉、roster_check_scope 七列），真的跑 migration
 *      1. 回填對照：新里程碑視圖與舊欄位逐列相同（登記截止、名單公告、投票日、任期起訖）
 *      2. 假時鐘下 activity_open 的開關邊界：含頭含尾、缺里程碑＝關、確定程度、範圍限定、覆寫、回傳的規則與里程碑列
 *      3. gap_events 有寫（opened／closed／reopened）、只增不刪；回填既有派工列
 *      4. 派工輸出逐件不變：舊函式與新函式在同樣的缺口序列下，派工列（內容、排隊位置、回傳值）逐件相同
 *      5. 每條守門都做還原驗證：把 migration 文字改壞一處（精確改一處，改不到就失敗），對應的檢查必須紅
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const MIG = "20261008001000_activity_windows_p0.sql";
const BASE_SEED = "20261002000007_verify_pool_from_snapshot.sql";
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const MIG_SQL = await read(MIG);

async function migrationNames(): Promise<string[]> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  return names.sort();
}

/** 函式定義全文（從 CREATE OR REPLACE FUNCTION 到結尾的 $$;） */
function fnText(sql: string, name: string): string {
  const head = `CREATE OR REPLACE FUNCTION ${name}(`;
  const a = sql.indexOf(head);
  assert(a >= 0, `找不到函式 ${name}`);
  const rest = sql.slice(a);
  const tag = /AS (\$[a-z]*\$)/.exec(rest);
  assert(tag, `${name} 沒有 $$ 本體`);
  const start = rest.indexOf(tag[0]) + tag[0].length;
  return rest.slice(0, rest.indexOf(tag[1] + ";", start) + tag[1].length + 1);
}

/** migrations 裡某支函式最後一次的定義（照檔名排序，後蓋前） */
async function latestFn(name: string): Promise<string> {
  let def: string | null = null;
  for (const n of await migrationNames()) {
    const sql = await read(n);
    if (sql.includes(`CREATE OR REPLACE FUNCTION ${name}(`)) def = fnText(sql, name);
  }
  assert(def, `找不到 ${name}`);
  return def;
}

/** 精確改一處：改不到或改到兩處都算失敗（標記字串必須唯一，不然「還原驗證」可能什麼都沒改） */
function mutate(sql: string, from: string, to: string): string {
  const n = sql.split(from).length - 1;
  assertEquals(n, 1, `要改的字串必須剛好出現一次（出現 ${n} 次）：${from.slice(0, 60)}`);
  return sql.replace(from, () => to);
}

// ============================================================
// A. 文字層：seed_auto_task_queue 新函式＝現行定義加機械式事件寫入
// ============================================================
const OLD_SEED = fnText(await read(BASE_SEED), "seed_auto_task_queue");
const NEW_SEED = fnText(MIG_SQL, "seed_auto_task_queue");

const INSERT_COLS_OLD = "region, refreshed_at)\n  SELECT g.task_id, now(), v_base";
const INSERT_COLS_NEW = "region, refreshed_at, opened_at, opened_by)\n  SELECT g.task_id, now(), v_base";
const SELECT_OLD = "g.region, now()\n    FROM _gaps g\n   WHERE NOT EXISTS";
const SELECT_NEW = "g.region, now(), now(), '{\"basis\":\"seed\"}'::JSONB\n    FROM _gaps g\n   WHERE NOT EXISTS";

/** 把新函式倒推回舊函式：還原兩處欄位清單。結構不對就丟錯 */
function reverseSeed(fn: string): string {
  let s = mutate(fn, INSERT_COLS_NEW, INSERT_COLS_OLD);
  s = mutate(s, SELECT_NEW, SELECT_OLD);
  return s;
}
const OLD_DROP = fnText(await read("20260924000001_dispatch_io.sql"), "task_dispatches_drop_applied");
const NEW_DROP = fnText(MIG_SQL, "task_dispatches_drop_applied");
const MARK_RE = /[ ]*-- >>> gap_events[^\n]*\n[\s\S]*?[ ]*-- <<< gap_events\n/g;
/** drop_applied 倒推：拿掉標記起訖之間的 set_config（剛好兩段） */
function reverseDrop(fn: string): string {
  assertEquals((fn.match(MARK_RE) ?? []).length, 2, "set_config 要剛好兩段（刪之前、刪之後），各有起訖標記");
  return fn.replace(MARK_RE, "");
}
const isMechanicalDrop = (fn: string) => {
  try {
    return reverseDrop(fn) === OLD_DROP;
  } catch {
    return false;
  }
};
const isMechanical = (fn: string) => {
  try {
    return reverseSeed(fn) === OLD_SEED;
  } catch {
    return false;
  }
};

Deno.test("A1 這支 migration 是 seed_auto_task_queue、task_dispatches_drop_applied 緊接著現行版的下一版（中間沒有人插一版，抄的底才不會過期）", async () => {
  for (const [fn, base] of [["seed_auto_task_queue", BASE_SEED], ["task_dispatches_drop_applied", "20260924000001_dispatch_io.sql"]]) {
    const defining: string[] = [];
    for (const n of await migrationNames()) if ((await read(n)).includes(`CREATE OR REPLACE FUNCTION ${fn}(`)) defining.push(n);
    const i = defining.indexOf(MIG);
    assert(i > 0, `這支 migration 要在重新定義 ${fn} 的清單裡`);
    assertEquals(defining[i - 1], base, `${fn} 的前一版應該是 ${base}；有人在中間改了，要以那一版為底重做`);
    // 之後只允許 P1（20261008060000，只機械式把 seed 寫死的 opened_by 換成規則帶來的，守門在 activity-arms.test.ts）、優先層（20261008090000，只機械式加優先層區塊，守門在 queue-priority.test.ts）
    // 與 party_roster 那支 P2（20261008121000，seed 分 window／filled，守門在 activity-party-roster.test.ts）；多了別人的就要以最新那版為底重做
    // drop_applied 之後只允許補號次那支（20261008150000：補號次與重查的任務不在單筆落庫時收回，只多一個條件，守門在 activity-ballot-numbers.test.ts）
    assertEquals(defining.slice(i + 1), fn === "seed_auto_task_queue" ? ["20261008060000_activity_windows_p1.sql", "20261008090000_queue_priority_tiers.sql", "20261008121000_activity_windows_p2_party_roster.sql"] : ["20261008150000_ballot_numbers_arm.sql"], `這支之後又有人改了 ${fn}：那一版要以這支為底`);
  }
});

Deno.test("A2 seed 新函式＝現行定義＋INSERT 兩處欄位清單，其餘一字不差、不含 gap_events；drop_applied＝現行定義＋標記起訖的兩段 set_config", () => {
  assert(isMechanical(NEW_SEED));
  assertEquals(reverseSeed(NEW_SEED), OLD_SEED);
  assert(!NEW_SEED.includes("gap_events"), "事件交給 task_dispatches 的觸發器，seed 函式裡不寫 gap_events");
  assert(isMechanicalDrop(NEW_DROP));
  assertEquals(reverseDrop(NEW_DROP), OLD_DROP);
  // 三支觸發器函式與三個觸發器都在，而且只管 auto: 列
  for (const t of ["BEFORE INSERT", "AFTER INSERT", "AFTER DELETE"]) assert(MIG_SQL.includes(`${t} ON task_dispatches\n  FOR EACH ROW WHEN (`), `缺 ${t} 觸發器（要有 WHEN 條件只管 auto: 列）`);
});

Deno.test("A3 還原驗證：動一個不該動的字、少一處機械替換、把事件寫回 seed、動 drop_applied 的本體，A2 都要紅", () => {
  // 偷改收回條件
  assert(!isMechanical(mutate(NEW_SEED, "WHERE d.task_id LIKE 'auto:%'\n     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);\n\n  -- 既有的", "WHERE d.task_id LIKE 'auto:%' AND d.dispatch_count >= 0\n     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);\n\n  -- 既有的")));
  // 偷改 UPDATE 的內容欄位
  assert(!isMechanical(mutate(NEW_SEED, "region = g.region, refreshed_at = now()", "region = g.region, refreshed_at = now(), reward = 0")));
  // 偷改回傳值
  assert(!isMechanical(mutate(NEW_SEED, "RETURN v_new + v_verify;", "RETURN v_new;")));
  // INSERT 少寫 opened_by（欄位清單只改一半）
  assert(!isMechanical(mutate(NEW_SEED, INSERT_COLS_NEW, "region, refreshed_at, opened_at)\n  SELECT g.task_id, now(), v_base")));
  // 在 seed 裡又寫一段事件（跟觸發器重複記）
  assert(!isMechanical(mutate(NEW_SEED, "  -- 既有的只更新內容", "  INSERT INTO gap_events (task_id, event) SELECT task_id, 'opened' FROM _gaps WHERE false;\n\n  -- 既有的只更新內容")));
  // 反向：舊函式本身不是「機械」的（INSERT 沒有新欄位）
  assert(!isMechanical(OLD_SEED));
  // drop_applied：偷改刪除條件、標記被拿掉（標記內 set_config 少寫的情況由行為層 drop_applied_* 守門與還原驗證負責）
  assert(!isMechanicalDrop(mutate(NEW_DROP, "DELETE FROM task_dispatches WHERE task_id = NEW.task_id;", "DELETE FROM task_dispatches WHERE task_id = NEW.task_id AND true;")));
  assert(!isMechanicalDrop(mutate(NEW_DROP, "    -- <<< gap_events\n    DELETE FROM", "    DELETE FROM")));
  assert(!isMechanicalDrop(OLD_DROP));
});

// ============================================================
// B. PGlite：stub 表＋正式庫快照，真的跑 migration
// ============================================================
const OFFICE_FNS = (await read("20261004000005_politician_offices.sql"));
const OFFICE_START = fnText(OFFICE_FNS, "office_term_start");
const OFFICE_END = fnText(OFFICE_FNS, "office_term_end");
const ELECTION_TERM_START = await latestFn("election_term_start");
const ELECTION_TERM_END = await latestFn("election_term_end");

const BASE_SCHEMA = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
CREATE TABLE elections (id integer PRIMARY KEY, election_key text, election_date date, election_reason text, election_types text[], notice_date date);
CREATE TABLE sources (id bigserial PRIMARY KEY, url text);
CREATE TABLE edit_history (id bigserial PRIMARY KEY, table_name text NOT NULL, record_id text NOT NULL, field text NOT NULL, old_value jsonb, new_value jsonb,
  contribution_id uuid, agent_name text, applied_at timestamptz NOT NULL DEFAULT now(), reverted_at timestamptz, reverted_by text);
CREATE TABLE roster_check_scope (election_id integer NOT NULL, election_type text NOT NULL, recheck_days integer NOT NULL DEFAULT 7, enabled boolean NOT NULL DEFAULT true,
  list_announced_on date NOT NULL, registration_closed_on date NOT NULL, regions text[], qualification_review_by date, ballot_draw_on date, municipal_mayor_list_on date,
  PRIMARY KEY (election_id, election_type));
CREATE TABLE task_dispatches (task_id text PRIMARY KEY, last_dispatched_at timestamptz NOT NULL DEFAULT now(), dispatch_count integer NOT NULL DEFAULT 1,
  queue_at timestamptz NOT NULL DEFAULT now(), task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text, refreshed_at timestamptz,
  blocked boolean NOT NULL DEFAULT false, cooling boolean NOT NULL DEFAULT false, verify_target integer);
CREATE TABLE contributions (id uuid PRIMARY KEY, status text, contribution_type text, task_id text, created_at timestamptz);
-- 貢獻 applied 時收回缺口的觸發器：現行（migration 前）的函式本體＋觸發器定義；migration 會把函式換成新版
${OLD_DROP}
CREATE TRIGGER contributions_drop_dispatch AFTER UPDATE OF status ON contributions
  FOR EACH ROW WHEN (NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied') EXECUTE FUNCTION task_dispatches_drop_applied();
-- seed_auto_task_queue 呼叫的東西：缺口來源換成可控的 stub 表，其餘是空殼（它們各自有自己的測試，這裡只看 seed 本身）
CREATE TABLE _stub_arms (task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text);
CREATE FUNCTION contribution_auto_tasks_arms() RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
  LANGUAGE sql STABLE AS $$ SELECT * FROM _stub_arms $$;
CREATE FUNCTION queue_slot(p text) RETURNS timestamptz LANGUAGE sql AS $$ SELECT timestamptz '2026-10-08 00:00:00+00' $$;
-- /next 派出時呼叫的 task_dispatched：正式庫 2026-10-08 pg_get_functiondef 的原文（auto: 列不存在就新增）
CREATE OR REPLACE FUNCTION task_dispatched(p_task_id text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  VALUES (p_task_id, now(), queue_slot(CASE WHEN p_task_id LIKE 'verify:%' THEN 'verify' ELSE 'task' END), 1)
  ON CONFLICT (task_id) DO UPDATE
    SET last_dispatched_at = now(),
        queue_at = queue_slot(CASE WHEN p_task_id LIKE 'verify:%' THEN 'verify' ELSE 'task' END),
        dispatch_count = task_dispatches.dispatch_count + 1
$$;
CREATE FUNCTION refresh_dispatch_blocked() RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
CREATE FUNCTION refresh_verify_targets() RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
CREATE FUNCTION rebalance_queue() RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
CREATE FUNCTION contribution_queue_at(t text, k text, c timestamptz) RETURNS timestamptz LANGUAGE sql AS $$ SELECT timestamptz '2026-10-08 00:00:00+00' $$;
${OFFICE_START}
${OFFICE_END}
${ELECTION_TERM_START}
${ELECTION_TERM_END}
`;

const ALL_POSITIONS = ["縣市長", "縣市議員", "鄉鎮市長", "直轄市山地原住民區長", "鄉鎮市民代表", "直轄市山地原住民區民代表", "村里長"];
const arr = (xs: string[]) => `ARRAY[${xs.map((x) => `'${x}'`).join(", ")}]`;
// 正式庫 2026-10-08 唯讀快照：四場選舉（id 4 是嘉義市重行選舉）
const ELECTIONS = [
  { id: 4, key: "2022-12-18_rerun_10020", date: "2022-12-18", reason: "rerun", types: ["縣市長"] },
  { id: 2022, key: "2022-11-26_local", date: "2022-11-26", reason: "regular", types: ALL_POSITIONS },
  { id: 2024, key: "2024-01-13_national", date: "2024-01-13", reason: "regular", types: ["總統副總統", "立法委員"] },
  { id: 2026, key: "2026-11-28_local", date: "2026-11-28", reason: "regular", types: ALL_POSITIONS },
];
// roster_check_scope：2026 七種職位各一列，兩個日期是「所有職位同一天」
const SCOPE = ALL_POSITIONS.map((t) => ({ election_id: 2026, election_type: t, registration_closed_on: "2026-09-04", list_announced_on: "2026-11-17" }));

/** 既有（migration 前）的派工列：回填的四種情況＋一筆驗證列 */
const PRELOAD_DISPATCHES = `
INSERT INTO task_dispatches (task_id, queue_at, refreshed_at, task_type) VALUES
  ('auto:old_normal',   '2026-09-21 10:00:00+00', '2026-10-07 15:40:00+00', 'policy_missing'),
  ('auto:old_boosted',  '1979-12-31 23:36:00+00', '2026-10-07 15:40:00+00', 'profile_gap'),
  ('auto:old_no_refresh', '2026-09-22 08:00:00+00', NULL, 'roster_check'),
  ('auto:old_boost_no_refresh', '1979-12-31 23:36:00+00', NULL, 'progress_stale');
INSERT INTO task_dispatches (task_id, queue_at, task_type) VALUES ('verify:11111111-1111-1111-1111-111111111111', '2026-09-23 00:00:00+00', NULL);
`;

type Db = PGlite;
async function buildDb(mutateMig: (sql: string) => string = (s) => s): Promise<Db> {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA);
  for (const e of ELECTIONS) {
    await db.exec(`INSERT INTO elections (id, election_key, election_date, election_reason, election_types) VALUES (${e.id}, '${e.key}', '${e.date}', '${e.reason}', ${arr(e.types)})`);
  }
  for (const s of SCOPE) {
    await db.exec(`INSERT INTO roster_check_scope (election_id, election_type, registration_closed_on, list_announced_on) VALUES (${s.election_id}, '${s.election_type}', '${s.registration_closed_on}', '${s.list_announced_on}')`);
  }
  await db.exec(PRELOAD_DISPATCHES);
  // migration 當下的「今天」固定，回填的 status 才不會隨測試跑的日期變（done／announced）
  await db.exec("SET app.activity_today = '2026-10-08'");
  await db.exec(mutateMig(MIG_SQL));
  await db.exec("RESET app.activity_today");
  return db;
}

const rows = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T> => (await rows<T>(db, sql, params))[0];
const openRows = (db: Db, activity: string, eid: number | null, type: string | null, today: string) =>
  rows<{ source: string; rule_id: number | null; override_id: number | null; milestone_kind: string | null; milestone_on_date: string | null; expected_open_on: string | null; open_until: string | null }>(
    db,
    `SELECT source, rule_id::int, override_id::int, milestone_kind, milestone_on_date::text, expected_open_on::text, open_until::text FROM activity_open($1, $2::int, $3::text, $4::date)`,
    [activity, eid, type, today],
  );
const isOpen = async (db: Db, activity: string, eid: number | null, type: string | null, today: string) => (await openRows(db, activity, eid, type, today)).length > 0;

/** 一個檢查：丟錯或條件不成立都算「紅」。回傳每條守門的結果，還原驗證時指定的那一條必須是 false */
type Verdicts = Record<string, boolean>;
async function guard(out: Verdicts, name: string, f: () => Promise<boolean>) {
  try {
    out[name] = await f();
  } catch {
    out[name] = false;
  }
}
const setRule = (db: Db, sql: string) => db.exec(sql);

async function addRules(db: Db) {
  const R = (activity: string, kind: string, fk: string | null, fo: number, uk: string | null, uo: number, extra = "") => {
    const cols = ["activity", "window_kind", "from_kind", "from_offset", "until_kind", "until_offset"];
    const vals = [`'${activity}'`, `'${kind}'`, fk ? `'${fk}'` : "NULL", String(fo), uk ? `'${uk}'` : "NULL", String(uo)];
    return db.exec(`INSERT INTO activity_rules (${cols.join(", ")}${extra ? ", " + extra.split("=>")[0] : ""}) VALUES (${vals.join(", ")}${extra ? ", " + extra.split("=>")[1] : ""})`);
  };
  await R("t_after", "event", "polling", 1, "polling", 14); // 投票日 +1 ～ +14
  await R("t_reg", "event", "registration_close", 0, "polling", 0); // 登記截止當天 ～ 投票日（含頭含尾）
  await R("t_draw_default", "event", "draw", 0, null, 0); // 預設 min_status＝announced
  await R("t_draw_expected", "event", "draw", 0, null, 0, "min_status=>'expected'");
  await R("t_done", "event", "list_published", 0, null, 0, "min_status=>'done'");
  await R("t_term", "term", "term_start", 90, "term_end", 0); // 就任日 +90 ～ 屆滿日
  await R("t_recur", "recurring", "term_start", 0, "term_end", 0, "recur_months=>'[1,3]'::int4range"); // 任期內每年 1–3 月
  await R("t_always", "always", null, 0, null, 0);
  await R("t_disabled", "event", "polling", 0, "polling", 0, "enabled=>false");
  await R("t_reason", "event", "polling", 0, "polling", 0, "reasons=>ARRAY['rerun']");
  await R("t_pos", "event", "polling", 0, "polling", 0, "election_types=>ARRAY['縣市議員']");
  await R("t_level", "event", "polling", 0, "polling", 0, "levels=>ARRAY['national']");
  await R("t_juris_tw", "event", "polling", 0, "polling", 0, "jurisdictions=>ARRAY['tw']");
  await R("t_juris_jp", "event", "polling", 0, "polling", 0, "jurisdictions=>ARRAY['jp']");
  await R("t_multi", "event", "polling", 5, null, 0); // 兩條規則同時開：expected_open_on 最早的排前面
  await R("t_multi", "event", "polling", 1, null, 0);
  // 預估的里程碑（2026 整場選舉的抽籤日）
  await db.exec(`INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status) VALUES (2026, 'draw', NULL, '2026-10-23', 'statutory', 'expected')`);
  // 縣市長的名單公告確定程度先拉回 announced，t_done 才不隨 migration 當天的日期變
  await db.exec(`UPDATE election_milestones SET status = 'announced' WHERE kind = 'list_published'`);
}

/** 所有檢查（一個 DB 跑完）；每條守門一個名字，還原驗證時指定的名字必須紅 */
async function runSuite(db: Db): Promise<Verdicts> {
  const v: Verdicts = {};
  await addRules(db);

  // ---- 回填對照：新里程碑視圖與舊欄位逐列相同 ----
  await guard(v, "backfill_milestones_match_scope", async () => {
    const got = (await rows<{ s: string }>(db, `SELECT election_id || '|' || kind || '|' || election_type || '|' || on_date::text AS s FROM election_milestones_all WHERE origin = 'table' AND kind IN ('registration_close', 'list_published')`)).map((r) => r.s).sort();
    const want = SCOPE.flatMap((s) => [`${s.election_id}|registration_close|${s.election_type}|${s.registration_closed_on}`, `${s.election_id}|list_published|${s.election_type}|${s.list_announced_on}`]).sort();
    return JSON.stringify(got) === JSON.stringify(want) && got.length === 14;
  });
  await guard(v, "backfill_status_and_basis", async () => {
    // migration 當天（假時鐘 2026-10-08）：09-04 已過＝done，11-17 還沒到＝announced；都是官方公告
    const a = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM election_milestones WHERE kind = 'registration_close' AND basis = 'official'`);
    const b = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM election_milestones WHERE kind = 'registration_close' AND status = 'done'`);
    return a.n === 7 && b.n === 7;
  });
  await guard(v, "polling_and_term_match_sources", async () => {
    const polling = (await rows<{ s: string }>(db, `SELECT election_id || '|' || on_date::text AS s FROM election_milestones_all WHERE kind = 'polling'`)).map((r) => r.s).sort();
    const wantPolling = ELECTIONS.map((e) => `${e.id}|${e.date}`).sort();
    if (JSON.stringify(polling) !== JSON.stringify(wantPolling)) return false;
    // 任期起訖：視圖的每一列等於 election_term_start／end 直接算的（另一種查詢寫法），而且一個職位一列、不多不少
    const pairs = ELECTIONS.reduce((n, e) => n + e.types.length, 0);
    const start = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM election_milestones_all m WHERE m.kind = 'term_start' AND m.on_date = election_term_start(m.election_id, m.election_type)`);
    const end = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM election_milestones_all m WHERE m.kind = 'term_end' AND m.on_date = election_term_end(m.election_id, m.election_type)`);
    if (start.n !== pairs || end.n !== pairs) return false;
    // 與正式庫已知的就任日／屆滿日對（20261004000005 註解裡的三組）
    const known = await rows<{ s: string }>(db, `SELECT kind || '|' || election_id || '|' || election_type || '|' || on_date::text AS s FROM election_milestones_all
        WHERE (election_id, election_type) IN ((2022, '縣市長'), (2024, '立法委員'), (2024, '總統副總統')) AND kind IN ('term_start', 'term_end')`);
    return JSON.stringify(known.map((r) => r.s).sort()) === JSON.stringify([
      "term_end|2022|縣市長|2026-12-24", "term_end|2024|立法委員|2028-01-31", "term_end|2024|總統副總統|2028-05-19",
      "term_start|2022|縣市長|2022-12-25", "term_start|2024|立法委員|2024-02-01", "term_start|2024|總統副總統|2024-05-20",
    ].sort());
  });

  // ---- 假時鐘下的開關邊界：含頭含尾 ----
  await guard(v, "boundary_start_inclusive", async () => {
    // t_after：投票日（2026-11-28）+1 起。11-28 關、11-29 開
    return !(await isOpen(db, "t_after", 2026, null, "2026-11-28")) && (await isOpen(db, "t_after", 2026, null, "2026-11-29"));
  });
  await guard(v, "boundary_end_inclusive", async () => {
    // 迄日＝投票日+14＝2026-12-12，含當天；12-13 關
    return (await isOpen(db, "t_after", 2026, null, "2026-12-12")) && !(await isOpen(db, "t_after", 2026, null, "2026-12-13"));
  });
  await guard(v, "boundary_registration_window", async () => {
    // 登記截止（2026-09-04，縣市長專屬里程碑）起、投票日（整場選舉的里程碑）止：兩端都含
    const t = "縣市長";
    return !(await isOpen(db, "t_reg", 2026, t, "2026-09-03")) && (await isOpen(db, "t_reg", 2026, t, "2026-09-04")) &&
      (await isOpen(db, "t_reg", 2026, t, "2026-11-28")) && !(await isOpen(db, "t_reg", 2026, t, "2026-11-29"));
  });
  await guard(v, "each_election_has_its_own_window", async () => {
    // 同一條規則吃所有選舉：2022（投票日 2022-11-26）的窗口在 2022-11-27 開、2026-11-29 時已經關
    return (await isOpen(db, "t_after", 2022, null, "2022-11-27")) && !(await isOpen(db, "t_after", 2022, null, "2026-11-29")) && (await isOpen(db, "t_after", 4, null, "2022-12-19"));
  });
  await guard(v, "term_window", async () => {
    // 就任日 2026-12-25 +90＝2027-03-25 起，屆滿日 2030-12-24 止
    const t = "縣市長";
    return !(await isOpen(db, "t_term", 2026, t, "2027-03-24")) && (await isOpen(db, "t_term", 2026, t, "2027-03-25")) &&
      (await isOpen(db, "t_term", 2026, t, "2030-12-24")) && !(await isOpen(db, "t_term", 2026, t, "2030-12-25"));
  });
  await guard(v, "recurring_months", async () => {
    const t = "縣市長"; // 任期 2026-12-25 ～ 2030-12-24 內，每年 1–3 月
    return !(await isOpen(db, "t_recur", 2026, t, "2026-12-30")) && (await isOpen(db, "t_recur", 2026, t, "2027-01-01")) &&
      (await isOpen(db, "t_recur", 2026, t, "2027-03-31")) && !(await isOpen(db, "t_recur", 2026, t, "2027-04-01")) && !(await isOpen(db, "t_recur", 2026, t, "2031-02-01"));
  });

  // ---- 缺里程碑＝關 ----
  await guard(v, "missing_milestone_closed", async () => {
    // 2022 沒有登記截止（roster_check_scope 只有 2026）→ 關；2026 但職位沒指定（登記截止是職位專屬）→ 關；沒有選舉 → 關；t_draw_* 的抽籤日 2024 沒有 → 關
    return !(await isOpen(db, "t_reg", 2022, "縣市長", "2022-11-01")) && !(await isOpen(db, "t_reg", 2026, null, "2026-10-01")) &&
      !(await isOpen(db, "t_reg", null, null, "2026-10-01")) && !(await isOpen(db, "t_reg", 999, "縣市長", "2026-10-01")) &&
      !(await isOpen(db, "t_draw_expected", 2024, null, "2026-12-01"));
  });
  await guard(v, "missing_until_milestone_closed", async () => {
    // 迄點掛了里程碑卻找不到也是關：窗口 polling ～ certified（沒有 certified 里程碑）
    await db.exec(`INSERT INTO activity_rules (activity, window_kind, from_kind, until_kind) VALUES ('t_until_missing', 'event', 'polling', 'certified')`);
    return !(await isOpen(db, "t_until_missing", 2026, null, "2026-12-01"));
  });

  // ---- 確定程度 ----
  await guard(v, "min_status", async () => {
    // 預估的抽籤日：預設要求 announced → 關；min_status=expected → 開
    const closedByDefault = !(await isOpen(db, "t_draw_default", 2026, null, "2026-10-24"));
    const openWhenExpectedOk = await isOpen(db, "t_draw_expected", 2026, null, "2026-10-24");
    // 名單公告停在 announced：min_status=done 的規則關；改成 done 才開
    const doneClosed = !(await isOpen(db, "t_done", 2026, "縣市長", "2026-11-20"));
    await db.exec(`UPDATE election_milestones SET status = 'done' WHERE kind = 'list_published' AND election_type = '縣市長'`);
    const doneOpen = await isOpen(db, "t_done", 2026, "縣市長", "2026-11-20");
    await db.exec(`UPDATE election_milestones SET status = 'announced' WHERE kind = 'list_published'`);
    return closedByDefault && openWhenExpectedOk && doneClosed && doneOpen;
  });

  // ---- 範圍限定、停用、永遠開、多條規則 ----
  await guard(v, "scope_filters", async () => {
    const reason = !(await isOpen(db, "t_reason", 2026, null, "2026-11-28")) && (await isOpen(db, "t_reason", 4, null, "2022-12-18")); // 只有重行選舉
    const pos = !(await isOpen(db, "t_pos", 2026, "縣市長", "2026-11-28")) && (await isOpen(db, "t_pos", 2026, "縣市議員", "2026-11-28")) && !(await isOpen(db, "t_pos", 2026, null, "2026-11-28"));
    const level = (await isOpen(db, "t_level", 2024, "立法委員", "2024-01-13")) && !(await isOpen(db, "t_level", 2026, "縣市長", "2026-11-28")) && !(await isOpen(db, "t_level", 2024, null, "2024-01-13"));
    const juris = (await isOpen(db, "t_juris_tw", 2026, null, "2026-11-28")) && !(await isOpen(db, "t_juris_jp", 2026, null, "2026-11-28")) && !(await isOpen(db, "t_juris_tw", null, null, "2026-11-28"));
    return reason && pos && level && juris;
  });
  await guard(v, "disabled_rule_closed", async () => !(await isOpen(db, "t_disabled", 2026, null, "2026-11-28")));
  await guard(v, "always_rule_is_a_named_row", async () => {
    // always 也是一條有名字的規則列（回傳 rule_id），沒有里程碑；沒有選舉也開
    const r = await openRows(db, "t_always", null, null, "2026-11-28");
    const r2 = await openRows(db, "t_always", 2026, "縣市長", "2030-01-01");
    return r.length === 1 && r[0].source === "rule" && r[0].rule_id !== null && r[0].milestone_kind === null && r[0].milestone_on_date === null && r2.length === 1;
  });
  await guard(v, "returns_rule_and_milestone", async () => {
    const r = await openRows(db, "t_after", 2026, null, "2026-12-01");
    const ruleId = (await one<{ id: number }>(db, `SELECT id::int AS id FROM activity_rules WHERE activity = 't_after'`)).id;
    const x = r[0];
    return r.length === 1 && x.source === "rule" && x.rule_id === ruleId && x.override_id === null && x.milestone_kind === "polling" &&
      x.milestone_on_date === "2026-11-28" && x.expected_open_on === "2026-11-29" && x.open_until === "2026-12-12";
  });
  await guard(v, "multiple_rules_or_earliest_first", async () => {
    const r = await openRows(db, "t_multi", 2026, null, "2026-12-10");
    return r.length === 2 && r[0].expected_open_on === "2026-11-29" && r[1].expected_open_on === "2026-12-03";
  });
  await guard(v, "type_specific_milestone_preferred", async () => {
    // 縣市長的名單公告有專屬里程碑；另插一筆整場選舉（election_type 空）的同 kind 里程碑，縣市長要用專屬那筆、其他職位退回整場那筆
    await db.exec(`INSERT INTO activity_rules (activity, window_kind, from_kind) VALUES ('t_pref', 'event', 'list_published')`);
    await db.exec(`INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status) VALUES (2024, 'list_published', NULL, '2023-12-01', 'official', 'announced')`);
    await db.exec(`INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status) VALUES (2024, 'list_published', '立法委員', '2023-12-05', 'official', 'announced')`);
    const lv = await openRows(db, "t_pref", 2024, "立法委員", "2023-12-03"); // 專屬 12-05 還沒到
    const pres = await openRows(db, "t_pref", 2024, "總統副總統", "2023-12-03"); // 退回整場 12-01 → 開
    return lv.length === 0 && pres.length === 1 && pres[0].milestone_on_date === "2023-12-01";
  });

  // ---- 覆寫：closed ＞ open／window ＞ 規則；範圍、到期 ----
  await guard(v, "override_closed_beats_rule", async () => {
    const before = await isOpen(db, "t_after", 2026, null, "2026-12-01");
    await db.exec(`INSERT INTO activity_overrides (activity, election_id, "force", reason) VALUES ('t_after', 2026, 'closed', '測試：緊急止血')`);
    const after = await isOpen(db, "t_after", 2026, null, "2026-12-01");
    const otherElection = await isOpen(db, "t_after", 2022, null, "2022-12-01"); // 覆寫只管 2026
    // closed 優先於同範圍的 open
    await db.exec(`INSERT INTO activity_overrides (activity, election_id, "force", reason) VALUES ('t_after', 2026, 'open', '測試：同時有 open')`);
    const closedStillWins = !(await isOpen(db, "t_after", 2026, null, "2026-12-01"));
    await db.exec(`DELETE FROM activity_overrides WHERE activity = 't_after'`);
    return before && !after && otherElection && closedStillWins;
  });
  await guard(v, "override_window_replaces_rule", async () => {
    await db.exec(`INSERT INTO activity_overrides (activity, election_id, "force", open_from, open_until, reason) VALUES ('t_after', 2026, 'window', '2026-12-01', '2026-12-05', '測試：延期')`);
    const r = async (d: string) => openRows(db, "t_after", 2026, null, d);
    const beforeWin = await r("2026-11-30"); // 規則開、但覆寫的窗口還沒到 → 關（不退回規則）
    const startDay = await r("2026-12-01");
    const endDay = await r("2026-12-05");
    const afterWin = await r("2026-12-06"); // 規則還開（到 12-12）、覆寫窗口已過 → 關
    await db.exec(`DELETE FROM activity_overrides WHERE activity = 't_after'`);
    return beforeWin.length === 0 && startDay.length === 1 && startDay[0].source === "override" && startDay[0].rule_id === null && startDay[0].override_id !== null &&
      endDay.length === 1 && afterWin.length === 0;
  });
  await guard(v, "override_open_without_rule_and_expiry", async () => {
    await db.exec(`INSERT INTO activity_overrides (activity, "force", reason, expires_at) VALUES ('t_override_only', 'open', '測試：全域開', '2026-12-31')`);
    const live = (await openRows(db, "t_override_only", null, null, "2026-12-31")).length === 1; // 到期日當天仍有效
    const expired = (await openRows(db, "t_override_only", null, null, "2027-01-01")).length === 0;
    await db.exec(`DELETE FROM activity_overrides WHERE activity = 't_override_only'`);
    return live && expired;
  });
  await guard(v, "override_reason_required", async () => {
    try {
      await db.exec(`INSERT INTO activity_overrides (activity, "force", reason) VALUES ('t_x', 'closed', '   ')`);
      return false;
    } catch {
      return true;
    }
  });

  // ---- 假時鐘（GUC）與 activity_today ----
  await guard(v, "fake_clock_guc", async () => {
    try {
      await db.exec("SET app.activity_today = '2026-11-28'");
      const a = (await rows(db, `SELECT 1 FROM activity_open('t_after', 2026, NULL)`)).length === 0;
      await db.exec("SET app.activity_today = '2026-11-29'");
      const b = (await rows(db, `SELECT 1 FROM activity_open('t_after', 2026, NULL)`)).length === 1;
      const viaView = await one<{ is_open: boolean }>(db, `SELECT is_open FROM activity_open_now WHERE activity = 't_after' AND election_id = 2026 AND election_type IS NULL`);
      const viaViewClosed = await one<{ is_open: boolean }>(db, `SELECT is_open FROM activity_open_now WHERE activity = 't_after' AND election_id = 2022 AND election_type IS NULL`);
      const health = (await rows<{ check_name: string }>(db, `SELECT check_name FROM activity_health`)).map((r) => r.check_name);
      await db.exec("RESET app.activity_today");
      const real = await one<{ ok: boolean }>(db, `SELECT activity_today() = (now() AT TIME ZONE 'Asia/Taipei')::date AS ok`);
      return a && b && viaView.is_open === true && viaViewClosed.is_open === false && health.includes("clock_overridden") && real.ok;
    } finally {
      await db.exec("RESET app.activity_today");
    }
  });
  await guard(v, "activity_open_now_shape", async () => {
    // 每個活動：不屬於任何選舉 1 列 ＋ 四場選舉整場各 1 列 ＋ 每場選舉的各職位（7＋7＋2＋7＋1... 依 election_types）
    const per = 1 + ELECTIONS.length + ELECTIONS.reduce((n, e) => n + e.types.length, 0);
    const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM activity_open_now WHERE activity = 't_after'`);
    const always = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM activity_open_now WHERE activity = 't_always' AND is_open`);
    return n.n === per && always.n === per;
  });

  // ---- 健康檢查 ----
  await guard(v, "health_inverted_window", async () => {
    await db.exec(`INSERT INTO activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset) VALUES ('t_inverted', 'event', 'polling', 10, 'polling', 0)`);
    const r = await rows<{ check_name: string }>(db, `SELECT check_name FROM activity_health WHERE subject LIKE 'rule %' AND check_name = 'window_inverted'`);
    await db.exec(`DELETE FROM activity_rules WHERE activity = 't_inverted'`);
    return r.length === 4; // 四場選舉各一條
  });
  await guard(v, "health_disabled_activity_and_orphan_override", async () => {
    await db.exec(`INSERT INTO activity_overrides (activity, "force", reason) VALUES ('t_orphan', 'closed', '測試')`);
    const r = (await rows<{ check_name: string; subject: string }>(db, `SELECT check_name, subject FROM activity_health WHERE check_name IN ('override_without_rule', 'activity_all_rules_disabled')`))
      .map((x) => `${x.check_name}|${x.subject}`).sort();
    await db.exec(`DELETE FROM activity_overrides WHERE activity = 't_orphan'`);
    return JSON.stringify(r) === JSON.stringify(["activity_all_rules_disabled|t_disabled", "override_without_rule|t_orphan"]);
  });
  await guard(v, "health_milestone_scope_drift", async () => {
    const before = (await rows(db, `SELECT 1 FROM activity_health WHERE check_name = 'milestone_scope_drift'`)).length;
    await db.exec(`UPDATE roster_check_scope SET registration_closed_on = '2026-09-05' WHERE election_type = '縣市長'`);
    const regDrift = (await rows(db, `SELECT 1 FROM activity_health WHERE check_name = 'milestone_scope_drift'`)).length;
    await db.exec(`UPDATE roster_check_scope SET registration_closed_on = '2026-09-04' WHERE election_type = '縣市長'`);
    await db.exec(`UPDATE roster_check_scope SET list_announced_on = '2026-11-18' WHERE election_type = '村里長'`);
    const listDrift = (await rows(db, `SELECT 1 FROM activity_health WHERE check_name = 'milestone_scope_drift'`)).length;
    await db.exec(`UPDATE roster_check_scope SET list_announced_on = '2026-11-17' WHERE election_type = '村里長'`);
    return before === 0 && regDrift === 1 && listDrift === 1;
  });

  // ---- 審計：每次新增／修改／刪除各記一列 edit_history ----
  await guard(v, "audit_trigger_rules", async () => {
    await db.exec(`INSERT INTO activity_rules (activity, window_kind) VALUES ('t_audit', 'always')`);
    const id = (await one<{ id: number }>(db, `SELECT id::int AS id FROM activity_rules WHERE activity = 't_audit'`)).id;
    await db.exec(`UPDATE activity_rules SET note = '改過' WHERE id = ${id}`);
    await db.exec(`DELETE FROM activity_rules WHERE id = ${id}`);
    const h = await rows<{ has_old: boolean; has_new: boolean; agent_name: string; field: string }>(db,
      `SELECT old_value IS NOT NULL AS has_old, new_value IS NOT NULL AS has_new, agent_name, field FROM edit_history WHERE table_name = 'activity_rules' AND record_id = $1 ORDER BY id`, [String(id)]);
    return h.length === 3 && h.every((x) => x.agent_name === "activity-audit" && x.field === "*") &&
      !h[0].has_old && h[0].has_new && h[1].has_old && h[1].has_new && h[2].has_old && !h[2].has_new;
  });
  await guard(v, "audit_trigger_milestones_and_overrides", async () => {
    // 回填那 14 列也各記了一筆；之後的修改與覆寫都有
    const backfill = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM edit_history WHERE table_name = 'election_milestones' AND old_value IS NULL AND (new_value->>'note') LIKE '2026-10-08 由 roster_check_scope%'`);
    await db.exec(`INSERT INTO activity_overrides (activity, "force", reason) VALUES ('t_audit2', 'closed', '審計測試')`);
    const ov = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM edit_history WHERE table_name = 'activity_overrides' AND (new_value->>'activity') = 't_audit2'`);
    await db.exec(`DELETE FROM activity_overrides WHERE activity = 't_audit2'`);
    return backfill.n === 14 && ov.n === 1;
  });
  await guard(v, "updated_at_touched", async () => {
    await db.exec(`INSERT INTO activity_rules (activity, window_kind, updated_at, created_at) VALUES ('t_touch', 'always', '2020-01-01', '2020-01-01')`);
    await db.exec(`UPDATE activity_rules SET note = 'x' WHERE activity = 't_touch'`);
    const r = await one<{ y: number }>(db, `SELECT EXTRACT(YEAR FROM updated_at)::int AS y FROM activity_rules WHERE activity = 't_touch'`);
    await db.exec(`DELETE FROM activity_rules WHERE activity = 't_touch'`);
    return r.y >= 2026;
  });

  // ---- 規則表的形狀檢查 ----
  await guard(v, "rule_shape_checks", async () => {
    const bad = [
      `INSERT INTO activity_rules (activity, window_kind) VALUES ('t_bad', 'event')`, // event 沒掛里程碑
      `INSERT INTO activity_rules (activity, window_kind, from_kind) VALUES ('t_bad', 'always', 'polling')`, // always 不能掛
      `INSERT INTO activity_rules (activity, window_kind, from_kind) VALUES ('t_bad', 'event', 'term_start')`, // event 不能掛任期
      `INSERT INTO activity_rules (activity, window_kind, from_kind) VALUES ('t_bad', 'term', 'polling')`, // term 只能掛任期
      `INSERT INTO activity_rules (activity, window_kind, from_kind) VALUES ('t_bad', 'recurring', 'term_start')`, // recurring 要月份
      `INSERT INTO activity_rules (activity, window_kind, from_kind) VALUES ('t_bad', 'event', 'no_such_kind')`,
      `INSERT INTO election_milestones (election_id, kind, on_date, basis, status) VALUES (2026, 'polling', '2026-11-28', 'official', 'announced')`, // polling 不存這張表
      `INSERT INTO election_milestones (election_id, kind, on_date, basis, status) VALUES (2026, 'term_start', '2026-12-25', 'official', 'announced')`,
      `INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status) VALUES (2026, 'registration_close', '縣市長', '2026-09-09', 'official', 'announced')`, // 重複鍵
    ];
    for (const sql of bad) {
      try {
        await db.exec(sql);
        return false;
      } catch { /* 該擋 */ }
    }
    return true;
  });

  // ---- 缺口出生紀錄 ----
  await guard(v, "backfill_opened_at", async () => {
    // 既有的 auto: 派工列：LEAST(queue_at, refreshed_at)；verify: 列不動
    const r = await rows<{ task_id: string; opened_at: string | null; basis: string | null }>(db,
      `SELECT task_id, opened_at::text AS opened_at, opened_by->>'basis' AS basis FROM task_dispatches WHERE task_id IN ('auto:old_normal', 'auto:old_no_refresh') OR task_id LIKE 'verify:%' ORDER BY task_id`);
    const m = Object.fromEntries(r.map((x) => [x.task_id, x]));
    const verify = r.find((x) => x.task_id.startsWith("verify:"))!;
    return m["auto:old_normal"].opened_at?.startsWith("2026-09-21 10:00:00") === true && m["auto:old_normal"].basis === "backfill" &&
      m["auto:old_no_refresh"].opened_at?.startsWith("2026-09-22 08:00:00") === true && verify.opened_at === null && verify.basis === null;
  });
  await guard(v, "backfill_sentinel_not_1980", async () => {
    // 插隊哨兵（queue_at＝1979-12-31）不能變成出生時間：取 refreshed_at；兩個都沒有才用 now()（2026 年以後）
    const r = await rows<{ task_id: string; y: number; sentinel: boolean | null }>(db,
      `SELECT task_id, EXTRACT(YEAR FROM opened_at)::int AS y, (opened_by->>'queue_at_sentinel')::boolean AS sentinel FROM task_dispatches WHERE task_id IN ('auto:old_boosted', 'auto:old_boost_no_refresh') ORDER BY task_id`);
    const boosted = await one<{ o: string }>(db, `SELECT opened_at::text AS o FROM task_dispatches WHERE task_id = 'auto:old_boosted'`);
    return r.length === 2 && r.every((x) => x.y >= 2026 && x.sentinel === true) && boosted.o.startsWith("2026-10-07 15:40:00");
  });
  await guard(v, "backfill_gap_events", async () => {
    const ev = await rows<{ task_id: string; event: string; basis: string; at: string }>(db,
      `SELECT task_id, event, detail->>'basis' AS basis, at::text AS at FROM gap_events WHERE task_id LIKE 'auto:old_%' ORDER BY task_id`);
    const verify = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM gap_events WHERE task_id LIKE 'verify:%'`);
    return ev.length === 4 && ev.every((e) => e.event === "opened" && e.basis === "backfill") && verify.n === 0 &&
      ev.find((e) => e.task_id === "auto:old_normal")!.at.startsWith("2026-09-21 10:00:00");
  });

  // ---- seed：opened／closed／reopened、同一個交易、不重複、驗證列不記 ----
  const seed = () => one<{ n: number }>(db, `SELECT seed_auto_task_queue() AS n`);
  const setArms = async (ids: string[]) => {
    await db.exec(`DELETE FROM _stub_arms`);
    for (const id of ids) await db.exec(`INSERT INTO _stub_arms VALUES ('${id}', 'policy_missing', '{"k":"v"}', '補政見', ARRAY['x'], 5, '台北市')`);
  };
  const events = (id: string) => rows<{ event: string; reason: string | null; basis: string | null }>(db,
    `SELECT event, reason, detail->>'basis' AS basis FROM gap_events WHERE task_id = $1 ORDER BY id`, [id]);
  await guard(v, "seed_writes_opened", async () => {
    await db.exec(`INSERT INTO contributions VALUES ('22222222-2222-2222-2222-222222222222', 'pending', 'policy', NULL, now())`);
    await setArms(["auto:s1", "auto:s2", "auto:s3"]);
    await seed();
    const d = await rows<{ task_id: string; opened_at: string | null; basis: string | null }>(db,
      `SELECT task_id, opened_at::text AS opened_at, opened_by->>'basis' AS basis FROM task_dispatches WHERE task_id IN ('auto:s1', 'auto:s2', 'auto:s3') ORDER BY task_id`);
    const e = await events("auto:s1");
    const verify = await one<{ opened_at: string | null; n: number }>(db, `SELECT d.opened_at::text AS opened_at, (SELECT count(*)::int FROM gap_events WHERE task_id LIKE 'verify:%') AS n FROM task_dispatches d WHERE d.task_id = 'verify:22222222-2222-2222-2222-222222222222'`);
    // 同一個交易：新增列的 opened_at ＝ 事件的 at（同一個 now()）
    const same = await one<{ ok: boolean }>(db, `SELECT d.opened_at = e.at AS ok FROM task_dispatches d JOIN gap_events e ON e.task_id = d.task_id AND e.event = 'opened' WHERE d.task_id = 'auto:s1'`);
    return d.length === 3 && d.every((x) => x.opened_at !== null && x.basis === "seed") && e.length === 1 && e[0].event === "opened" && e[0].basis === "seed" &&
      verify.opened_at === null && verify.n === 0 && same.ok;
  });
  await guard(v, "seed_idempotent_keeps_opened_at", async () => {
    const before = await one<{ o: string; r: string }>(db, `SELECT opened_at::text AS o, refreshed_at::text AS r FROM task_dispatches WHERE task_id = 'auto:s1'`);
    await new Promise((r) => setTimeout(r, 20));
    await seed();
    const after = await one<{ o: string; r: string }>(db, `SELECT opened_at::text AS o, refreshed_at::text AS r FROM task_dispatches WHERE task_id = 'auto:s1'`);
    const e = await events("auto:s1");
    return before.o === after.o && before.r !== after.r && e.length === 1; // opened_at 不動、refreshed_at 更新、沒有重複事件
  });
  await guard(v, "seed_writes_closed", async () => {
    await setArms(["auto:s1", "auto:s3"]); // s2 補上了
    await seed();
    const gone = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM task_dispatches WHERE task_id = 'auto:s2'`);
    const e = await events("auto:s2");
    const detail = await one<{ has_opened_at: boolean }>(db, `SELECT (detail ? 'opened_at') AS has_opened_at FROM gap_events WHERE task_id = 'auto:s2' AND event = 'closed'`);
    // 沒被收回的不記 closed
    const kept = await events("auto:s1");
    return gone.n === 0 && e.length === 2 && e[0].event === "opened" && e[1].event === "closed" && e[1].reason === "filled" && detail.has_opened_at && kept.length === 1;
  });
  await guard(v, "seed_writes_reopened", async () => {
    await setArms(["auto:s1", "auto:s2", "auto:s3"]);
    await seed();
    const e = (await events("auto:s2")).map((x) => x.event);
    const row = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM task_dispatches WHERE task_id = 'auto:s2' AND opened_at IS NOT NULL`);
    return JSON.stringify(e) === JSON.stringify(["opened", "closed", "reopened"]) && row.n === 1;
  });
  await guard(v, "seed_closes_backfilled_rows_too", async () => {
    // 回填的舊列不在 stub 缺口裡 → 第一輪就被收回，各記一筆 closed（detail 帶回填的 opened_by）
    const e = await events("auto:old_normal");
    return e.length === 2 && e[0].basis === "backfill" && e[1].event === "closed";
  });
  await guard(v, "seed_verify_rows_no_events", async () => {
    // 驗證列被收回（貢獻不是 pending 了）不記 closed
    await db.exec(`UPDATE contributions SET status = 'applied'`);
    const before = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM gap_events`);
    await seed();
    const after = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM gap_events`);
    const gone = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM task_dispatches WHERE task_id LIKE 'verify:%'`);
    return before.n === after.n && gone.n === 0;
  });
  await guard(v, "drop_applied_records_closed", async () => {
    // 貢獻 applied → 觸發器直接刪 auto: 列（不經 seed）：要有 closed 事件，detail 帶出是哪一筆貢獻；缺口還在時下一輪 seed 記 reopened
    const cid = "44444444-4444-4444-4444-444444444444";
    await db.exec(`INSERT INTO contributions VALUES ('${cid}', 'pending', 'policy', 'auto:d1', now())`);
    await setArms(["auto:s1", "auto:s2", "auto:s3", "auto:d1"]);
    await seed();
    const before = (await events("auto:d1")).map((x) => x.event);
    await db.exec(`UPDATE contributions SET status = 'applied' WHERE id = '${cid}'`);
    const gone = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM task_dispatches WHERE task_id = 'auto:d1'`);
    const closed = await one<{ event: string; reason: string; via: string; cid: string; has_opened_at: boolean }>(db,
      `SELECT event, reason, detail->>'via' AS via, detail->>'contribution_id' AS cid, (detail ? 'opened_at') AS has_opened_at FROM gap_events WHERE task_id = 'auto:d1' AND event = 'closed'`);
    await seed(); // 缺口還在 → 重新出現
    const after = (await events("auto:d1")).map((x) => x.event);
    return JSON.stringify(before) === JSON.stringify(["opened"]) && gone.n === 0 && closed.reason === "filled" && closed.via === "drop_applied" && closed.cid === cid &&
      closed.has_opened_at && JSON.stringify(after) === JSON.stringify(["opened", "closed", "reopened"]);
  });
  await guard(v, "drop_applied_cleans_settings", async () => {
    // 交易內設定用完就清：同一個交易裡 drop_applied 之後的設定是空的，不會污染之後的刪除
    const cid = "55555555-5555-5555-5555-555555555555";
    await db.exec(`INSERT INTO contributions VALUES ('${cid}', 'pending', 'policy', 'auto:d2', now())`);
    await setArms(["auto:s1", "auto:s2", "auto:s3", "auto:d2"]);
    await seed();
    const r = await db.exec(`UPDATE contributions SET status = 'applied' WHERE id = '${cid}'; SELECT COALESCE(current_setting('gap.close_detail', true), '') AS d, COALESCE(current_setting('gap.close_reason', true), '') AS r`);
    const last = r[r.length - 1].rows[0] as { d: string; r: string };
    return last.d === "" && last.r === "";
  });
  await guard(v, "task_dispatched_records_opened", async () => {
    // /next 派出時 task_dispatched 新增 auto: 列（列剛好不存在）：要有 opened_at、opened_by、一筆 opened；再派一次（衝突改成更新）不重複記
    await db.exec(`SELECT task_dispatched('auto:td1')`);
    const row = await one<{ opened_at: string | null; basis: string | null; n: number }>(db,
      `SELECT opened_at::text AS opened_at, opened_by->>'basis' AS basis, dispatch_count AS n FROM task_dispatches WHERE task_id = 'auto:td1'`);
    const e1 = await events("auto:td1");
    const same = await one<{ ok: boolean }>(db, `SELECT d.opened_at = e.at AS ok FROM task_dispatches d JOIN gap_events e ON e.task_id = d.task_id WHERE d.task_id = 'auto:td1'`);
    await db.exec(`SELECT task_dispatched('auto:td1')`);
    const row2 = await one<{ opened_at: string | null; n: number }>(db, `SELECT opened_at::text AS opened_at, dispatch_count AS n FROM task_dispatches WHERE task_id = 'auto:td1'`);
    const e2 = await events("auto:td1");
    // 缺口不存在（stub 缺口清單沒有它）→ 下一輪 seed 收回、記 closed
    await seed();
    const e3 = (await events("auto:td1")).map((x) => x.event);
    return row.opened_at !== null && row.basis === "insert" && row.n === 1 && e1.length === 1 && e1[0].event === "opened" && same.ok &&
      row2.opened_at === row.opened_at && row2.n === 2 && e2.length === 1 && JSON.stringify(e3) === JSON.stringify(["opened", "closed"]);
  });
  await guard(v, "verify_rows_never_in_gap_events", async () => {
    // 驗證列（verify:）不管從哪條路進出都不進 gap_events、不填 opened_at：task_dispatched 新增、直接刪除
    const before = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM gap_events`);
    await db.exec(`SELECT task_dispatched('verify:66666666-6666-6666-6666-666666666666')`);
    const row = await one<{ opened_at: string | null; opened_by: string | null }>(db, `SELECT opened_at::text AS opened_at, opened_by::text AS opened_by FROM task_dispatches WHERE task_id = 'verify:66666666-6666-6666-6666-666666666666'`);
    await db.exec(`DELETE FROM task_dispatches WHERE task_id = 'verify:66666666-6666-6666-6666-666666666666'`);
    const after = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM gap_events`);
    const any = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM gap_events WHERE task_id LIKE 'verify:%'`);
    return before.n === after.n && any.n === 0 && row.opened_at === null && row.opened_by === null;
  });
  await guard(v, "close_reason_setting", async () => {
    // 呼叫端用交易內設定帶關閉原因與補充；沒設記 filled；亂填的原因退回 filled 並把原值留在 detail
    await db.exec(`INSERT INTO task_dispatches (task_id, task_type) VALUES ('auto:cr1', 'x'), ('auto:cr2', 'x'), ('auto:cr3', 'x')`);
    await db.exec(`SELECT set_config('gap.close_reason', 'override', true), set_config('gap.close_detail', '{"by":"test"}', true); DELETE FROM task_dispatches WHERE task_id = 'auto:cr1'`);
    await db.exec(`SELECT set_config('gap.close_reason', 'bogus', true); DELETE FROM task_dispatches WHERE task_id = 'auto:cr2'`);
    await db.exec(`DELETE FROM task_dispatches WHERE task_id = 'auto:cr3'`);
    const r = await rows<{ task_id: string; reason: string; by: string | null; raw: string | null }>(db,
      `SELECT task_id, reason, detail->>'by' AS by, detail->>'reason_raw' AS raw FROM gap_events WHERE task_id IN ('auto:cr1', 'auto:cr2', 'auto:cr3') AND event = 'closed' ORDER BY task_id`);
    return r.length === 3 && r[0].reason === "override" && r[0].by === "test" && r[1].reason === "filled" && r[1].raw === "bogus" && r[2].reason === "filled" && r[2].by === null && r[2].raw === null;
  });
  await guard(v, "gap_events_append_only", async () => {
    let blocked = 0;
    for (const sql of [`UPDATE gap_events SET reason = 'window'`, `DELETE FROM gap_events`, `TRUNCATE gap_events`]) {
      try {
        await db.exec(sql);
      } catch {
        blocked++;
      }
    }
    const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM gap_events`);
    return blocked === 3 && n.n > 0;
  });
  return v;
}

const ALL_GUARDS = [
  "backfill_milestones_match_scope", "backfill_status_and_basis", "polling_and_term_match_sources",
  "boundary_start_inclusive", "boundary_end_inclusive", "boundary_registration_window", "each_election_has_its_own_window", "term_window", "recurring_months",
  "missing_milestone_closed", "missing_until_milestone_closed", "min_status", "scope_filters", "disabled_rule_closed", "always_rule_is_a_named_row",
  "returns_rule_and_milestone", "multiple_rules_or_earliest_first", "type_specific_milestone_preferred",
  "override_closed_beats_rule", "override_window_replaces_rule", "override_open_without_rule_and_expiry", "override_reason_required",
  "fake_clock_guc", "activity_open_now_shape", "health_inverted_window", "health_disabled_activity_and_orphan_override", "health_milestone_scope_drift",
  "audit_trigger_rules", "audit_trigger_milestones_and_overrides", "updated_at_touched", "rule_shape_checks",
  "backfill_opened_at", "backfill_sentinel_not_1980", "backfill_gap_events",
  "seed_writes_opened", "seed_idempotent_keeps_opened_at", "seed_writes_closed", "seed_writes_reopened", "seed_closes_backfilled_rows_too", "seed_verify_rows_no_events",
  "drop_applied_records_closed", "drop_applied_cleans_settings", "task_dispatched_records_opened", "verify_rows_never_in_gap_events", "close_reason_setting",
  "gap_events_append_only",
];

Deno.test("B1 migration 在 PGlite 上整支跑得動；全部守門都綠（回填對照、假時鐘邊界、缺里程碑＝關、覆寫、gap_events、審計）", async () => {
  const db = await buildDb();
  // 剛建好、還沒有任何規則：健康檢查是空的、視圖查得到
  assertEquals(await rows(db, `SELECT * FROM activity_health`), []);
  assertEquals(await rows(db, `SELECT * FROM activity_open_now`), []);
  const v = await runSuite(db);
  const red = ALL_GUARDS.filter((g) => v[g] !== true);
  assertEquals(red, [], `這些守門是紅的：${red.join("、")}`);
  assertEquals(Object.keys(v).sort(), [...ALL_GUARDS].sort(), "守門清單與實際跑的要一致");
  await db.close();
});

// ---- 還原驗證：migration 文字改壞一處（精確改一處），對應的守門必須紅 ----
const MUTATIONS: { name: string; breaks: string[]; edit: (sql: string) => string }[] = [
  { name: "起日改成不含當天", breaks: ["boundary_start_inclusive", "boundary_registration_window"],
    edit: (s) => mutate(s, "p_today >= f.on_date + r.from_offset))", "p_today > f.on_date + r.from_offset))") },
  { name: "迄日改成不含當天", breaks: ["boundary_end_inclusive", "boundary_registration_window"],
    edit: (s) => mutate(s, "p_today <= u.on_date + r.until_offset))", "p_today < u.on_date + r.until_offset))") },
  // 缺起點里程碑有兩層擋：f.on_date IS NOT NULL，以及 status 等級（缺＝0，永遠低於 min_status）。兩層都拿掉才會 fail open——只拿一層，另一層還擋得住
  { name: "缺起點里程碑改成開（fail open，兩層檢查都拿掉）", breaks: ["missing_milestone_closed"],
    edit: (s) => mutate(
      mutate(s, "(f.on_date IS NOT NULL AND p_today >= f.on_date + r.from_offset)", "(f.on_date IS NULL OR p_today >= f.on_date + r.from_offset)"),
      "AND activity_status_rank(CASE WHEN r.from_kind IS NOT NULL THEN f.status ELSE u.status END) >= activity_status_rank(r.min_status)", "AND true") },
  { name: "缺起點里程碑只拿掉 IS NOT NULL 那一層，status 等級還是擋住（雙重保險，結果不變）", breaks: [],
    edit: (s) => mutate(s, "(f.on_date IS NOT NULL AND p_today >= f.on_date + r.from_offset)", "(f.on_date IS NULL OR p_today >= f.on_date + r.from_offset)") },
  { name: "缺迄點里程碑改成開（fail open）", breaks: ["missing_until_milestone_closed"],
    edit: (s) => mutate(s, "(u.on_date IS NOT NULL AND p_today <= u.on_date + r.until_offset)", "(u.on_date IS NULL OR p_today <= u.on_date + r.until_offset)") },
  { name: "拿掉確定程度檢查", breaks: ["min_status"],
    edit: (s) => mutate(s, "AND activity_status_rank(CASE WHEN r.from_kind IS NOT NULL THEN f.status ELSE u.status END) >= activity_status_rank(r.min_status)", "AND true") },
  { name: "拿掉職位限定", breaks: ["scope_filters"],
    edit: (s) => mutate(s, "AND (r.election_types IS NULL OR p_election_type = ANY (r.election_types))", "AND true") },
  { name: "拿掉事由限定", breaks: ["scope_filters"],
    edit: (s) => mutate(s, "AND (r.reasons IS NULL OR el.election_reason = ANY (r.reasons))", "AND true") },
  { name: "closed 覆寫不再優先", breaks: ["override_closed_beats_rule"],
    edit: (s) => mutate(s, "WHERE NOT EXISTS (SELECT 1 FROM ov WHERE ov.\"force\" = 'closed')", "WHERE true") },
  { name: "window 覆寫不取代規則（退回規則）", breaks: ["override_window_replaces_rule"],
    edit: (s) => mutate(s, "WHERE NOT EXISTS (SELECT 1 FROM ov)\n    ) x", "WHERE NOT EXISTS (SELECT 1 FROM ov WHERE ov.\"force\" = 'closed')\n    ) x") },
  { name: "覆寫到期日不看", breaks: ["override_open_without_rule_and_expiry"],
    edit: (s) => mutate(s, "AND (o.expires_at IS NULL OR p_today <= o.expires_at)", "") },
  { name: "回填登記截止拿錯欄位", breaks: ["backfill_milestones_match_scope"],
    edit: (s) => mutate(s, "SELECT s.election_id, 'registration_close', s.election_type, s.registration_closed_on,", "SELECT s.election_id, 'registration_close', s.election_type, s.list_announced_on,") },
  { name: "投票日視圖拿掉一場選舉", breaks: ["polling_and_term_match_sources"],
    edit: (s) => mutate(s, "   WHERE e.election_date IS NOT NULL\n  UNION ALL\n  SELECT e.id, 'term_start'", "   WHERE e.election_date IS NOT NULL AND e.id <> 4\n  UNION ALL\n  SELECT e.id, 'term_start'") },
  { name: "里程碑對不上舊欄位時健康檢查不報", breaks: ["health_milestone_scope_drift"],
    edit: (s) => mutate(s, "AND m.election_type = s.election_type AND m.on_date = s.registration_closed_on)", "AND m.election_type = s.election_type)") },
  { name: "拿掉規則表的審計觸發器", breaks: ["audit_trigger_rules"],
    edit: (s) => mutate(s, "CREATE TRIGGER trg_activity_rules_audit AFTER INSERT OR UPDATE OR DELETE ON activity_rules FOR EACH ROW EXECUTE FUNCTION activity_audit();", "SELECT 1;") },
  { name: "拿掉 updated_at 觸發器", breaks: ["updated_at_touched"],
    edit: (s) => mutate(s, "CREATE TRIGGER trg_activity_rules_touch BEFORE UPDATE ON activity_rules FOR EACH ROW EXECUTE FUNCTION activity_touch_updated_at();", "SELECT 1;") },
  { name: "放寬規則形狀（always 也能掛里程碑）", breaks: ["rule_shape_checks"],
    edit: (s) => mutate(s, "(window_kind = 'always' AND from_kind IS NULL AND until_kind IS NULL AND recur_months IS NULL)", "(window_kind = 'always')") },
  { name: "回填把插隊哨兵值直接當出生時間", breaks: ["backfill_sentinel_not_1980"],
    edit: (s) => mutate(s, "LEAST(CASE WHEN d.queue_at >= TIMESTAMPTZ '2026-09-20 00:00:00+00' THEN d.queue_at END, d.refreshed_at)", "LEAST(d.queue_at, d.refreshed_at)") },
  { name: "不回填 gap_events", breaks: ["backfill_gap_events", "seed_closes_backfilled_rows_too"],
    edit: (s) => mutate(s, "   AND NOT EXISTS (SELECT 1 FROM gap_events e WHERE e.task_id = d.task_id);", "   AND false;") },
  { name: "拿掉 AFTER DELETE 觸發器（收回不記 closed，不論 seed 或 drop_applied）", breaks: ["seed_writes_closed", "seed_writes_reopened", "seed_closes_backfilled_rows_too", "drop_applied_records_closed", "task_dispatched_records_opened", "close_reason_setting"],
    edit: (s) => mutate(s, "CREATE TRIGGER trg_task_dispatches_gap_after_delete AFTER DELETE ON task_dispatches\n  FOR EACH ROW WHEN (OLD.task_id LIKE 'auto:%') EXECUTE FUNCTION task_dispatches_gap_after_delete();", "SELECT 1;") },
  { name: "拿掉 AFTER INSERT 觸發器（新增不記 opened，不論 seed 或 task_dispatched）", breaks: ["seed_writes_opened", "seed_idempotent_keeps_opened_at", "seed_writes_closed", "seed_writes_reopened", "drop_applied_records_closed", "task_dispatched_records_opened"],
    edit: (s) => mutate(s, "CREATE TRIGGER trg_task_dispatches_gap_after_insert AFTER INSERT ON task_dispatches\n  FOR EACH ROW WHEN (NEW.task_id LIKE 'auto:%') EXECUTE FUNCTION task_dispatches_gap_after_insert();", "SELECT 1;") },
  { name: "拿掉 BEFORE INSERT 觸發器（task_dispatched 新增的 auto: 列沒有 opened_at）", breaks: ["task_dispatched_records_opened"],
    edit: (s) => mutate(s, "CREATE TRIGGER trg_task_dispatches_gap_before_insert BEFORE INSERT ON task_dispatches\n  FOR EACH ROW WHEN (NEW.task_id LIKE 'auto:%') EXECUTE FUNCTION task_dispatches_gap_before_insert();", "SELECT 1;") },
  { name: "AFTER INSERT 觸發器拿掉 WHEN（驗證列也進 gap_events）", breaks: ["verify_rows_never_in_gap_events"],
    edit: (s) => mutate(s, "AFTER INSERT ON task_dispatches\n  FOR EACH ROW WHEN (NEW.task_id LIKE 'auto:%') EXECUTE", "AFTER INSERT ON task_dispatches\n  FOR EACH ROW EXECUTE") },
  { name: "AFTER DELETE 觸發器拿掉 WHEN（驗證列被刪也記 closed）", breaks: ["verify_rows_never_in_gap_events", "seed_verify_rows_no_events"],
    edit: (s) => mutate(s, "AFTER DELETE ON task_dispatches\n  FOR EACH ROW WHEN (OLD.task_id LIKE 'auto:%') EXECUTE", "AFTER DELETE ON task_dispatches\n  FOR EACH ROW EXECUTE") },
  { name: "關閉原因不讀交易內設定", breaks: ["close_reason_setting"],
    edit: (s) => mutate(s, "v_reason := COALESCE(NULLIF(current_setting('gap.close_reason', true), ''), 'filled');", "v_reason := 'filled';") },
  { name: "drop_applied 不帶貢獻（拿掉第一段 set_config）", breaks: ["drop_applied_records_closed"],
    edit: (s) => mutate(s, "PERFORM set_config('gap.close_detail', jsonb_build_object('via', 'drop_applied', 'contribution_id', NEW.id)::TEXT, true);", "") },
  { name: "drop_applied 刪完不清設定", breaks: ["drop_applied_cleans_settings"],
    edit: (s) => mutate(s, "PERFORM set_config('gap.close_detail', '', true);", "") },
  { name: "重新出現的缺口不標 reopened", breaks: ["seed_writes_reopened", "drop_applied_records_closed"],
    edit: (s) => mutate(s, "CASE WHEN EXISTS (SELECT 1 FROM gap_events e WHERE e.task_id = NEW.task_id) THEN 'reopened' ELSE 'opened' END", "'opened'") },
  { name: "seed 的 opened_at 改填 NULL（BEFORE INSERT 觸發器補上，結果不變：雙重保險）", breaks: [],
    edit: (s) => mutate(s, "g.region, now(), now(), '{\"basis\":\"seed\"}'::JSONB\n    FROM _gaps g\n   WHERE NOT EXISTS", "g.region, now(), NULL, '{\"basis\":\"seed\"}'::JSONB\n    FROM _gaps g\n   WHERE NOT EXISTS") },
  { name: "gap_events 可以被改（拿掉只增不刪）", breaks: ["gap_events_append_only"],
    edit: (s) => mutate(s, "RAISE EXCEPTION 'gap_events 只增不刪（PLAN-task-activation 2.5）：不能 %', TG_OP;", "RETURN OLD;") },
];

for (const m of MUTATIONS) {
  Deno.test(`B2 還原驗證：${m.name} → ${m.breaks.join("、")} 必須紅`, async () => {
    const db = await buildDb(m.edit);
    const v = await runSuite(db);
    const red = ALL_GUARDS.filter((g) => v[g] !== true).sort();
    for (const b of m.breaks) assert(red.includes(b), `改壞了「${m.name}」，守門 ${b} 卻沒紅（紅的：${red.join("、") || "無"}）`);
    if (m.breaks.length === 0) assertEquals(red, [], `「${m.name}」本來就不該讓任何守門變紅`);
    await db.close();
  });
}

// ============================================================
// B3 派工輸出逐件不變：舊函式與新函式，同樣的缺口序列，派工列逐件相同
// ============================================================
Deno.test("B3 seed_auto_task_queue 新舊函式在同樣的缺口序列下，派工列（內容、排隊位置、回傳值）逐件相同", async () => {
  const dbNew = await buildDb();
  await dbNew.exec(`DELETE FROM task_dispatches`); // 回填的舊列不參與比較（舊函式的資料庫沒有它們）
  const dbOld = new PGlite();
  await dbOld.exec(BASE_SCHEMA);
  await dbOld.exec(OLD_SEED); // 舊函式原文，沒有任何新欄位
  const dump = (db: Db) => rows(db, `SELECT task_id, task_type, target::text AS target, what_we_need, hint_sources::text AS hint_sources, reward, region, dispatch_count,
      queue_at::text AS queue_at, blocked, cooling, verify_target FROM task_dispatches ORDER BY task_id`);
  const step = async (label: string, arms: Array<[string, string, string]>, verifyStatus?: string) => {
    for (const db of [dbNew, dbOld]) {
      await db.exec(`DELETE FROM _stub_arms`);
      for (const [id, type, what] of arms) await db.exec(`INSERT INTO _stub_arms VALUES ('${id}', '${type}', '{"id":"${id}"}', '${what}', ARRAY['h1','h2'], 5, '台北市')`);
      if (verifyStatus) {
        await db.exec(`DELETE FROM contributions`);
        await db.exec(`INSERT INTO contributions VALUES ('33333333-3333-3333-3333-333333333333', '${verifyStatus}', 'policy', NULL, '2026-10-01')`);
      }
    }
    const a = await one<{ n: number }>(dbNew, `SELECT seed_auto_task_queue() AS n`);
    const b = await one<{ n: number }>(dbOld, `SELECT seed_auto_task_queue() AS n`);
    assertEquals(a.n, b.n, `${label}：回傳值`);
    assertEquals(await dump(dbNew), await dump(dbOld), `${label}：派工列`);
  };
  await step("第一輪：三個新缺口＋一筆 pending 驗證", [["auto:1", "policy_missing", "A"], ["auto:2", "profile_gap", "B"], ["auto:3", "roster_check", "C"]], "pending");
  await step("第二輪：內容變了（只更新內容、不動排隊位置）", [["auto:1", "policy_missing", "A2"], ["auto:2", "profile_gap", "B"], ["auto:3", "roster_check", "C"]]);
  await step("第三輪：一個補上了、一個新增", [["auto:1", "policy_missing", "A2"], ["auto:3", "roster_check", "C"], ["auto:4", "progress_stale", "D"]]);
  await step("第四輪：全部補上、驗證列也不是 pending 了", [], "applied");
  await step("第五輪：之前補上的又出現", [["auto:2", "profile_gap", "B"]]);
  // 新函式多出來的只有兩個新欄位與流水，其餘都在上面逐件比過
  const extra = await one<{ n: number }>(dbNew, `SELECT count(*)::int AS n FROM task_dispatches WHERE task_id LIKE 'auto:%' AND opened_at IS NOT NULL AND opened_by IS NOT NULL`);
  assertEquals(extra.n, 1);
  await dbNew.close();
  await dbOld.close();
});

Deno.test("B4 migration 只加不刪：沒有 DROP TABLE／DROP COLUMN／DELETE FROM（除了函式本體裡原本就有的收回），也沒有動 contribution_auto_tasks_arms 與 elections", () => {
  const code = MIG_SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert(!/DROP TABLE (?!IF EXISTS _gaps)/i.test(code) && !/DROP COLUMN/i.test(code), "不該刪表或欄位（seed 函式裡原本就有的 DROP TABLE IF EXISTS _gaps 除外）");
  assert(!/(CREATE OR REPLACE FUNCTION|ALTER FUNCTION) contribution_auto_tasks_/i.test(code), "P0 不碰任何一支臂");
  assert(!/ALTER TABLE elections/i.test(code) && !/UPDATE elections/i.test(code), "P0 不動 elections 表");
  assertEquals((code.match(/DELETE FROM task_dispatches/g) ?? []).length, 3, "DELETE 只有 seed 函式裡原本那兩處與 drop_applied 裡原本那一處");
});
