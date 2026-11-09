/**
 * 名冊分組（多人）任務的逐人查核階梯與「不同人」裁決（migration 20261109210000，協議 1.125.0）的守門。
 *
 * A. dup：cec_roster_diff() 的 dup 輸出排除已有 politician_pair_resolutions＝different 的一對（正式庫 0166f1c8…，林振德派了 14 次）；
 *    對真正的函式本體做同一個替換，要剛好改到一處
 * B. 逐人冷卻（PGlite，真的 task_checks／階梯函式／結案視圖／對帳／refresh_dispatch_blocked）：d9042ce1…（許明全 not_found 三次）
 *    1) 一次 not_found → 那一位冷卻 5 天，只剩他一位 → 分組任務自己冷卻（cool_until＝他冷卻結束）、說明不列他
 *    2) 還有別人沒冷卻 → 任務照派（cool_until 空）；全部冷卻 → cool_until＝最早結束的那一位
 *    3) 累計 4 次 not_found → 結案：對帳把他移出，沒人了任務關閉；開任務也不再替結案、冷卻中的人開
 *    4) TS 與 SQL 的逐人鍵一致
 * 還原驗證：拿掉 dup 的 NOT EXISTS、拿掉 g 的冷卻判斷，對應斷言要紅。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, mutate, readMig } from "./arms-pglite.ts";
import { personCheckTaskId } from "./group-person.ts";

const MIG = await readMig("20261109210000_roster_group_person_cooldown.sql");
const LADDER = await readMig("20261109150000_confirmed_no_verify_check_ladder.sql");
const CAND = await readMig("20261109190000_cand_no_ladder_and_off_roster.sql");
const PERSON_KEY_MIG = await readMig("20261109120000_roster_group_person_key.sql");
const ROSTER_DIFF_MIG = await readMig("20261031160000_cec_roster_2026.sql");
const strip = (s: string) => s.replace(/^(REVOKE|GRANT)\b[^;]*;\s*$/gm, "");

const DO_A = (() => {
  const a = MIG.indexOf("DO $do$");
  const b = MIG.indexOf("$do$;", a) + "$do$;".length;
  return MIG.slice(a, b);
})();

// ============================================================
// A. dup 排除已裁決「不同人」
// ============================================================
Deno.test("A1 真正的 cec_roster_diff 本體：dup 輸出的結尾 FROM dg g 剛好一處（替換才有地方放）", () => {
  const body = fnText(ROSTER_DIFF_MIG, "cec_roster_diff");
  assertEquals(body.split("FROM dg g").length - 1, 1);
  assert(DO_A.includes("politician_pair_resolutions") && DO_A.includes("x.resolution = ''different''"));
  assert(MIG.includes("pair_key = g.a_pid::TEXT || ''|'' || g.b_pid::TEXT"), "鍵與 politician_pair_key() 同形（較小 uuid|較大 uuid；dg 的 b > a）");
});

const A = "205592b7-0d38-43f5-88f4-23e9fdfb6054", B = "c275bbd0-1279-425b-a9a1-a24d84534669", C = "00000000-0000-0000-0000-00000000000c", D = "ffffffff-0000-0000-0000-00000000000d";
async function dupEnv(doBlock = DO_A): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE politician_pair_resolutions (pair_key text PRIMARY KEY, a uuid, b uuid, resolution text);
    CREATE TABLE _dg (a_pid uuid, b_pid uuid);
    -- 結構同真正的函式：結尾「FROM dg g」
    CREATE FUNCTION cec_roster_diff() RETURNS TABLE (kind text, diff_key text) LANGUAGE sql STABLE AS $fn$
      WITH dg AS (SELECT a_pid, b_pid FROM _dg)
      SELECT 'dup'::text, 'dup:' || g.a_pid || '|' || g.b_pid
        FROM dg g
    $fn$;
    INSERT INTO _dg VALUES ('${A}', '${B}'), ('${C}', '${D}');
  `);
  await db.exec(doBlock);
  return db;
}
const keys = async (db: PGlite) => (await db.query<{ diff_key: string }>(`SELECT diff_key FROM cec_roster_diff() ORDER BY 1`)).rows.map((r) => r.diff_key);

Deno.test("A2 dup：記為 different 的一對不再出現；沒裁決、裁決 same 的照舊；冪等", async () => {
  const db = await dupEnv();
  assertEquals((await keys(db)).length, 2);
  await db.exec(`INSERT INTO politician_pair_resolutions VALUES ('${A}|${B}', '${A}', '${B}', 'different')`);
  assertEquals(await keys(db), [`dup:${C}|${D}`]);
  await db.exec(`INSERT INTO politician_pair_resolutions VALUES ('${C}|${D}', '${C}', '${D}', 'same')`);
  assertEquals(await keys(db), [`dup:${C}|${D}`], "same 不算「不同人」");
  await db.exec(DO_A); // 重跑：不重複替換
  assertEquals(await keys(db), [`dup:${C}|${D}`]);
  await db.close();
  // 還原驗證：拿掉 NOT EXISTS，林振德那一對又回來
  const bad = await dupEnv(mutate(DO_A, "x.resolution = ''different''", "TRUE AND x.resolution IS NULL"));
  await bad.exec(`INSERT INTO politician_pair_resolutions VALUES ('${A}|${B}', '${A}', '${B}', 'different')`);
  assertEquals((await keys(bad)).length, 2);
  await bad.close();
});

// ============================================================
// B. 逐人冷卻與階梯
// ============================================================
const TASK = "d9042ce1-f031-4804-ac98-d41e219ea38a";
const person = (pe: number, name: string) => ({ key: `掛錯人:${pe}`, name, action: "wrong_owner", politician_election_id: pe, election_type: "村里長", county: "花蓮縣", town: "", line: `${name} 的說明` });
const SCHEMA = `
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id text, status text, contribution_type text, payload jsonb);
CREATE TABLE task_checks (id bigserial PRIMARY KEY, task_id text NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(), agent_name text, note text, contribution_id uuid, outcome text);
CREATE TABLE task_cooldown_settings (id int PRIMARY KEY, enabled boolean, task_types text[], not_found_first_days int, not_found_repeat_days int);
INSERT INTO task_cooldown_settings VALUES (1, true, ARRAY['progress_stale','deadline_due'], 14, 30);
CREATE FUNCTION task_check_cooldown_days() RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT 14 $$;
CREATE FUNCTION task_unreachable_cooldown_days() RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT 2 $$;
CREATE FUNCTION task_not_found_cooldown_days() RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT 2 $$;
CREATE TABLE contribution_tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, description text, task_type text, target jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open', closed_at timestamptz);
CREATE TABLE task_dispatches (task_id text PRIMARY KEY, blocked boolean NOT NULL DEFAULT false, cool_until timestamptz, cooling boolean NOT NULL DEFAULT false,
  last_dispatched_at timestamptz DEFAULT now(), priority_seconds int DEFAULT 0, boost_seconds int DEFAULT 0);
CREATE TABLE queue_settings (id int PRIMARY KEY, dispatch_horizon_seconds int);
INSERT INTO queue_settings VALUES (1, 86400);
-- 排序鍵的簡化替身：冷卻結束時間比「現在」晚（超過一天的視界）才算 cooling；本測試只看 cool_until 與 cooling 的有無
CREATE FUNCTION task_queue_key(p_last timestamptz, p_prio int, p_cool timestamptz, p_boost int) RETURNS timestamptz LANGUAGE sql STABLE
  AS $$ SELECT GREATEST(COALESCE(p_last, now()), COALESCE(p_cool, '-infinity'::timestamptz)) $$;
-- 對帳要的清單與新鮮判斷：本測試把「差異清單」當作永遠都還在（人要靠階梯結案或冷卻才離開）
CREATE TABLE _people (person_key text, action text, pe_id int);
CREATE FUNCTION roster_group_people() RETURNS TABLE (person_key text, action text, election_type text, county text, town text, name text, pe_id int, politician_id uuid, loc text, line text, source_url text)
  LANGUAGE sql STABLE AS $$ SELECT p.person_key, p.action, '村里長'::text, '花蓮縣'::text, ''::text, p.person_key, p.pe_id, NULL::uuid, ''::text, ''::text, NULL::text FROM _people p $$;
CREATE FUNCTION roster_group_fresh(p_type text, p_county text, p_town text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
`;
const grab = (sql: string, name: string) => strip(fnText(sql, name));
async function envB(mutateRefresh: (s: string) => string = (s) => s): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  // 階梯：設定表、函式、結案視圖，全部取自真的 migration
  await db.exec(strip(LADDER.slice(LADDER.indexOf("CREATE TABLE IF NOT EXISTS task_check_ladder_settings"), LADDER.indexOf("-- 第 n 次查核（n 從 1 起）"))).replace(/COMMENT ON TABLE[^;]*;/, "").replace(/ALTER TABLE[^;]*;/, "").replace(/DROP POLICY[^;]*;/, "").replace(/CREATE POLICY[^;]*;/, ""));
  await db.exec(grab(LADDER, "task_check_ladder_days"));
  await db.exec(grab(CAND, "task_check_ladder_exempt"));
  await db.exec(grab(LADDER, "task_check_cooldown_days_for"));
  await db.exec(grab(LADDER, "task_cooldown_max_days"));
  const v0 = LADDER.indexOf("CREATE OR REPLACE VIEW task_ladder_closed AS");
  await db.exec(LADDER.slice(v0, LADDER.indexOf(";\n", v0) + 1));
  await db.exec(grab(PERSON_KEY_MIG, "roster_group_description"));
  await db.exec(grab(MIG, "roster_group_check_task_id"));
  await db.exec(grab(MIG, "roster_group_person_status"));
  await db.exec(grab(MIG, "roster_group_tasks_sweep"));
  await db.exec(mutateRefresh(grab(MIG, "refresh_dispatch_blocked")));
  return db;
}
const rows = async <T = Record<string, any>>(db: PGlite, sql: string) => (await db.query<T>(sql)).rows;
async function openGroup(db: PGlite, people: ReturnType<typeof person>[], id = TASK): Promise<void> {
  const header = "表頭";
  const target = { multi_person: true, origin: "roster_group", header, title_base: "標題｜", people, people_count: people.length };
  await db.query(`INSERT INTO contribution_tasks (id, title, description, task_type, target) VALUES ($1, $2, $3, 'candidacy_owner_mismatch', $4::jsonb)`,
    [id, `標題｜${people.length} 位`, `${header}\n` + people.map((p, i) => `${i + 1}. person_key：${p.key}｜${p.line}`).join("\n"), JSON.stringify(target)]);
  await db.query(`INSERT INTO task_dispatches (task_id) VALUES ($1)`, [id]);
  for (const p of people) await db.query(`INSERT INTO _people VALUES ($1, 'wrong_owner', $2)`, [p.key, p.politician_election_id]);
}
const check = (db: PGlite, pe: number, outcome: string, daysAgo = 0) =>
  db.query(`INSERT INTO task_checks (task_id, outcome, checked_at, agent_name) VALUES ($1, $2, now() - ($3 || ' days')::interval, 'x')`, [`auto:candidacy_owner_mismatch:${pe}`, outcome, String(daysAgo)]);
const disp = async (db: PGlite) => (await rows<{ cool_until: Date | null; cooling: boolean; blocked: boolean }>(db, `SELECT cool_until, cooling, blocked FROM task_dispatches WHERE task_id = '${TASK}'`))[0]!;
const task = async (db: PGlite) => (await rows<{ status: string; description: string; target: any; title: string }>(db, `SELECT * FROM contribution_tasks WHERE id = '${TASK}'`))[0]!;
const days = (d: Date) => (d.getTime() - Date.now()) / 86400000;

Deno.test("B1 許明全一位、查無一次：那一位冷卻 5 天 → 分組任務自己冷卻到那天（cool_until＝他冷卻結束）、說明不列他", async () => {
  const db = await envB();
  await openGroup(db, [person(56884, "許明全")]);
  assertEquals((await disp(db)).cool_until, null);
  await check(db, 56884, "not_found");
  await db.exec(`SELECT refresh_dispatch_blocked()`);
  const d = await disp(db);
  assert(d.cool_until && Math.abs(days(d.cool_until) - 5) < 0.01, `cool_until ${d.cool_until}`);
  assert(d.cooling, "5 天超過一天視界 → cooling");
  await db.exec(`SELECT roster_group_tasks_sweep()`);
  const t = await task(db);
  assertEquals(t.status, "open");
  assert(!t.description.includes("許明全") && !t.description.includes("掛錯人:56884"), "冷卻中的人不寫進說明：" + t.description);
  assertEquals(t.target.people.length, 1, "仍在 target.people（person_key 仍認得）");
  // 冷卻過了（查核在 6 天前）：任務回到佇列、說明又列他
  await db.exec(`UPDATE task_checks SET checked_at = now() - interval '6 days'`);
  await db.exec(`SELECT refresh_dispatch_blocked()`);
  assertEquals((await disp(db)).cool_until, null);
  assertEquals((await disp(db)).cooling, false);
  await db.exec(`SELECT roster_group_tasks_sweep()`);
  assert((await task(db)).description.includes("掛錯人:56884"));
  await db.close();
});

Deno.test("B2 兩位：只有一位冷卻 → 任務照派；兩位都冷卻 → cool_until＝較早結束的那一位；說明只列沒冷卻的", async () => {
  const db = await envB();
  await openGroup(db, [person(1, "甲"), person(2, "乙")]);
  await check(db, 1, "not_found");
  await db.exec(`SELECT refresh_dispatch_blocked()`);
  assertEquals((await disp(db)).cool_until, null, "還有乙沒冷卻");
  assertEquals((await disp(db)).cooling, false);
  await db.exec(`SELECT roster_group_tasks_sweep()`);
  let t = await task(db);
  assert(!t.description.includes("掛錯人:1｜") && t.description.includes("掛錯人:2"), t.description);
  await check(db, 2, "not_found", 2); // 乙 2 天前查的 → 還剩 3 天
  await db.exec(`SELECT refresh_dispatch_blocked()`);
  const d = await disp(db);
  assert(d.cool_until && Math.abs(days(d.cool_until) - 3) < 0.01, `最早結束的是乙：${d.cool_until}`);
  await db.exec(`SELECT roster_group_tasks_sweep()`);
  t = await task(db);
  assert(!t.description.includes("掛錯人:1") && !t.description.includes("掛錯人:2"), t.description);
  await db.close();
  // 還原驗證：拿掉「全部冷卻才冷卻」的判斷，只一位冷卻也會把整張擋掉
  const bad = await envB((s) => mutate(s, "AND count(*) FILTER (WHERE NOT gp.closed AND NOT COALESCE(gp.until > now(), FALSE)) = 0", ""));
  await openGroup(bad, [person(1, "甲"), person(2, "乙")]);
  await check(bad, 1, "not_found");
  await bad.exec(`SELECT refresh_dispatch_blocked()`);
  assert((await disp(bad)).cool_until !== null, "沒有判斷：誤擋");
  await bad.close();
});

Deno.test("B3 階梯結案：一位 not_found 累計 4 次 → 不再派；對帳把他移出，沒人了任務關閉；confirmed 也算同一階梯", async () => {
  const db = await envB();
  await openGroup(db, [person(1, "甲"), person(2, "乙")]);
  for (const ago of [40, 30, 20, 10]) await check(db, 1, "not_found", ago); // 第 4 次 → 結案
  await db.exec(`SELECT roster_group_tasks_sweep()`);
  let t = await task(db);
  assertEquals(t.status, "open");
  assertEquals(t.target.people.map((p: any) => p.name), ["乙"], "結案的人移出");
  assertEquals(t.target.people_count, 1);
  // 乙：confirmed 三次（5／10 天，第 3 次結案）
  for (const ago of [30, 20, 10]) await check(db, 2, "confirmed", ago);
  await db.exec(`SELECT roster_group_tasks_sweep()`);
  assertEquals((await task(db)).status, "closed", "兩位都結案 → 任務關閉");
  await db.close();
});

Deno.test("B4 非掛錯人的人用 auto:roster_group_person:<key>，也走同一個階梯", async () => {
  const db = await envB();
  const p = { key: "dup:a|b", name: "林振德", action: "dup", politician_election_id: 55975, election_type: "x", county: "x", town: "", line: "l" };
  await db.query(`INSERT INTO contribution_tasks (id, title, description, task_type, target) VALUES ($1, 't', 'h', 'duplicate_politician', $2::jsonb)`,
    [TASK, JSON.stringify({ multi_person: true, origin: "roster_group", header: "h", title_base: "t", people: [p], people_count: 1 })]);
  await db.query(`INSERT INTO task_dispatches (task_id) VALUES ($1)`, [TASK]);
  await db.exec(`INSERT INTO _people VALUES ('dup:a|b', 'dup', 55975)`);
  assertEquals((await rows(db, `SELECT roster_group_check_task_id('dup:a|b', 'dup', '55975') AS k`))[0]!.k, "auto:roster_group_person:dup:a|b");
  await db.query(`INSERT INTO task_checks (task_id, outcome, agent_name) VALUES ('auto:roster_group_person:dup:a|b', 'not_found', 'x')`);
  await db.exec(`SELECT refresh_dispatch_blocked()`);
  assert((await disp(db)).cool_until !== null);
  await db.close();
});

Deno.test("C TS personCheckTaskId 與 SQL roster_group_check_task_id 同一份", async () => {
  const db = await envB();
  const cases = [
    { key: "掛錯人:57044", action: "wrong_owner", politician_election_id: 57044 },
    { key: "掛錯人:x", action: "wrong_owner", politician_election_id: null },
    { key: "party:2026|某縣|某人", action: "party", politician_election_id: 777 },
    { key: "missing:abc", action: "missing", politician_election_id: null },
    { key: "dup:a|b", action: "dup", politician_election_id: 5 },
  ];
  for (const c of cases) {
    const sql = (await rows(db, `SELECT roster_group_check_task_id($1, $2, $3) AS k`.replace(/\$(\d)/g, (_, n) => [`'${c.key}'`, `'${c.action}'`, c.politician_election_id === null ? "NULL" : `'${c.politician_election_id}'`][Number(n) - 1])))[0]!.k;
    assertEquals(personCheckTaskId(c as never), sql, JSON.stringify(c));
  }
  await db.close();
});

Deno.test("D 文件：migration 與協議文件講了逐人階梯與不同人", async () => {
  const md = await Deno.readTextFile(new URL("../../../public/skill-types.md", import.meta.url));
  assert(md.includes("逐位") && md.includes("5／10／20") && md.includes("「不同人」"));
  assert(MIG.includes("refresh_dispatch_blocked") && MIG.includes("roster_group_tasks_create") && MIG.includes("20261109150000"));
  assert(!/(INSERT INTO|UPDATE|DELETE FROM)\s+(politicians|politician_elections|policies)\b/i.test(MIG.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")), "不寫人物或參選資料");
});
