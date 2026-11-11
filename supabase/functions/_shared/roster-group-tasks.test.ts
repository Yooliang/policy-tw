/**
 * 2026 名冊差異分組任務（migration 20261107030000_roster_group_tasks.sql）的守門。
 *
 * A. 文字層：機械式替換的底（三支函式現行定義裡的「三型不停放」字串次數）、暫停名冊對帳只動 2026 的兩個活動、不寫參選資料、
 *    TS 與 SQL 的多人任務豁免互相對得上、協議文件有講
 * B. 多人任務不停放、不因一筆交件而關（PGlite：真的 contribution_queue_tasks、真的 drop_applied 觸發器；一般手動任務對照）
 * C. 分組（PGlite，差異來源用 stub 表）：每張最多 8 位、不足 6 位的跨縣市併組、冪等、說明逐人寫明、單人任務關閉
 * D. 對帳：處理完的人從清單移除並更新人數、全部處理完才關、官方名冊鏡像過期不算處理完
 * E. 暫停名冊對帳的 INSERT：冪等、可用 created_by 整批還原
 * F. TS：shouldCloseOnApplied／closeTaskIfFulfilled 對多人任務不關
 * 還原驗證：拿掉豁免一行、拿掉不足併組、拿掉鏡像新鮮判斷，對應的斷言要紅。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, mutate, readMig } from "./arms-pglite.ts";
import { isMultiPersonTarget, shouldCloseOnApplied } from "./task-fulfilment.ts";
import { closeTaskIfFulfilled, type ContributionRow } from "./apply-contribution.ts";
import { MULTI_PERSON_HINT } from "./task-guidance.ts";

const MIG_NAME = "20261107030000_roster_group_tasks.sql";
const MIG = await readMig(MIG_NAME);
const section = (sql: string, name: string) => {
  const a = sql.indexOf(`-- ▼▼ SECTION: ${name} ▼▼`);
  const b = sql.indexOf(`-- ▲▲ SECTION: ${name} ▲▲`);
  assert(a >= 0 && b > a, `找不到段落 ${name}`);
  return sql.slice(a, b);
};
const strip = (s: string) => s.replace(/^(REVOKE|GRANT)\b[^;]*;\s*$/gm, "");
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const OLD = "d.task_type NOT IN ('question', 'adjudicate', 'roster_check')";

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 機械式替換的底：三支函式現行定義裡「三型不停放」字串的次數＝migration 斷言的次數", async () => {
  const count = (s: string) => s.split(OLD).length - 1;
  assertEquals(count(await latestFn("contribution_queue_tasks", "20261111100000_work_key.sql")), 2);
  assertEquals(count(await latestFn("contribution_auto_tasks")), 2);
  assertEquals(count(fnText(await readMig("20261017020100_overvoted_votes.sql"), "console_queue_state")), 1);
  const exempt = section(MIG, "exempt");
  assert(exempt.includes("('contribution_queue_tasks(text,text,integer,text,text,text)', 2)"));
  assert(exempt.includes("('contribution_auto_tasks(text,text,integer,text,text,text)', 2)"));
  assert(exempt.includes("('console_queue_state()', 1)"));
  // 現行定義的最後一版真的是我們認得的那幾個檔（中間有人再插一版，這裡要重看）
  const names: string[] = [];
  for await (const e of Deno.readDir(new URL("../../migrations/", import.meta.url))) if (e.name.endsWith(".sql")) names.push(e.name);
  const defining = async (fn: string) => {
    const out: string[] = [];
    for (const n of names.sort()) if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${fn}(`)) out.push(n);
    return out;
  };
  assertEquals((await defining("contribution_queue_tasks")).filter((n) => n < "20261111100000").at(-1), "20261017010000_verify_ticket_follows_task.sql");  // 20261111100000（work_key）整支重寫，底是線上現行定義
  assertEquals((await defining("console_queue_state")).at(-1), "20261017020100_overvoted_votes.sql");
  assertEquals((await defining("manual_task_closes_on_applied")).at(-1), MIG_NAME);
});

Deno.test("A2 暫停的是 2026 的 raw:roster_check 與 roster_villages（單位清查臂在 2026 用的兩個活動名），不碰其他", async () => {
  const run = section(MIG, "run");
  assert(/VALUES \('raw:roster_check'\), \('roster_villages'\)/.test(run));
  assert(run.includes("2026, 'closed'"));
  // 2026（未投票）的單位清查只會用這兩個臂名：roster_cec_gap 只給已投票屆
  const unify = await readMig("20261101020000_roster_check_unify.sql");
  assert(unify.includes("CASE WHEN g.voted THEN 'roster_cec_gap' WHEN g.election_type = '村里長' THEN 'roster_villages' ELSE 'raw:roster_check' END"));
  const gap = await readMig("20261103010000_roster_gap_units.sql");
  assert(gap.includes("CASE WHEN g.election_type = '村里長' THEN 'roster_villages' ELSE 'raw:roster_check' END"));
  const arms = await readMig("20261008165000_manual_tasks_as_arm.sql");
  assert(arms.includes("'raw:roster_check',") && arms.includes("'roster_villages',"));
  // 舊的每日補人任務不復活
  assert(!/cron\.schedule\(\s*'cec-missing-person/.test(MIG));
  assert(!MIG.includes("CREATE OR REPLACE FUNCTION cec_missing_person_tasks_create"));
  // 回復方式寫在檔頭
  assert(MIG.includes("DELETE FROM activity_overrides WHERE created_by = 'roster-group-2026-11-07'"));
});

Deno.test("A3 本檔只開任務、停派工，不寫任何參選資料", () => {
  const c = code(MIG);
  assert(!/(INSERT INTO|UPDATE|DELETE FROM)\s+(politicians|politician_elections|contributions|policies|regions)\b/.test(c), "不得寫人物／參選／貢獻");
  for (const f of ["roster_group_people", "roster_group_tasks_create", "roster_group_tasks_sweep", "roster_group_close_extra_singles"]) assert(c.includes(`FUNCTION ${f}(`));
});

Deno.test("A4 TS 與 SQL 的多人任務豁免對得上，協議文件講了怎麼交", async () => {
  assert(MIG.includes("COALESCE(p_target->>'multi_person', '') = 'true'"));
  const ts = await Deno.readTextFile(new URL("./task-fulfilment.ts", import.meta.url));
  assert(ts.includes("multi_person === true"));
  assert(MULTI_PERSON_HINT.includes("task_id") && MULTI_PERSON_HINT.includes("每一位各交一筆"));
  const md = await Deno.readTextFile(new URL("../../../public/skill-types.md", import.meta.url));
  assert(md.includes("多人任務") && md.includes("target.people") && md.includes("roster_group"));
  const ctx = await Deno.readTextFile(new URL("./task-context.ts", import.meta.url));
  assert(ctx.includes("isMultiPersonTarget(target) ? MULTI_PERSON_HINT"));
});

// ============================================================
// B. 不停放、不因一筆交件而關
// ============================================================
const SCHEMA_B = `
CREATE TABLE queue_settings (id smallint PRIMARY KEY, boost_seconds bigint NOT NULL DEFAULT 157680000, visitor_front_seconds bigint NOT NULL DEFAULT 315360000,
  manual_front_seconds bigint NOT NULL DEFAULT 157680000, verify_priority_seconds integer NOT NULL DEFAULT 1209600, dispatch_horizon_seconds integer NOT NULL DEFAULT 86400,
  verify_inherit_negative boolean NOT NULL DEFAULT false);
INSERT INTO queue_settings (id) VALUES (1);
CREATE TABLE task_dispatches (task_id text PRIMARY KEY, work_key text, last_dispatched_at timestamptz NOT NULL DEFAULT now(), dispatch_count integer NOT NULL DEFAULT 1, refreshed_at timestamptz,
  queue_at timestamptz NOT NULL DEFAULT now(), task_type text, target jsonb NOT NULL DEFAULT '{}'::jsonb, what_we_need text, hint_sources text[], reward integer, region text,
  blocked boolean NOT NULL DEFAULT false, cooling boolean NOT NULL DEFAULT false, verify_target integer, priority_seconds integer NOT NULL DEFAULT 0,
  boost_seconds bigint NOT NULL DEFAULT 0, cool_until timestamptz, opened_at timestamptz NOT NULL DEFAULT now(), verify_follows_task boolean NOT NULL DEFAULT true);
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id text, contribution_type text, status text NOT NULL DEFAULT 'pending',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, contributor_ip_hash text, agent_name text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, task_type text NOT NULL, source text NOT NULL DEFAULT 'manual', status text NOT NULL DEFAULT 'open',
  target jsonb NOT NULL DEFAULT '{}'::jsonb, last_dispatched_at timestamptz);
CREATE TABLE contribution_task_leases (task_id text, target_key text, leased_until timestamptz, agent_name text, work_key text);
CREATE TABLE citizen_questions (id uuid PRIMARY KEY, answer_count integer NOT NULL DEFAULT 0);
CREATE TABLE question_answers (question_id uuid, agent_name text);
CREATE TABLE contribution_votes (contribution_id uuid, verifier_ip_hash text);
`;
async function envB(mutateExempt: (s: string) => string = (s) => s): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA_B);
  for (const n of ["uuid_or_null", "task_target_key", "question_answer_cap"]) await db.exec(await latestFn(n));
  // 現行（20261017010000）的 contribution_queue_tasks 與 drop_applied；再套本檔的 helper、新 manual_task_closes_on_applied 與機械替換（只替換這支，
  // 另兩支需要整個派工環境，A1 守它們的次數）
  await db.exec(fnText(await readMig("20261017010000_verify_ticket_follows_task.sql"), "contribution_queue_tasks"));
  await db.exec(await latestFn("task_dispatches_drop_applied"));
  const exempt = section(MIG, "exempt")
    .replace(/\('contribution_auto_tasks\(text,text,integer,text,text,text\)', 2\),\n/, "")
    .replace(/,\n\s*\('console_queue_state\(\)', 1\)\)/, ")");
  assert(!exempt.includes("console_queue_state()"));
  await db.exec(mutateExempt(exempt));
  await db.exec(`CREATE TRIGGER contributions_drop_dispatch AFTER UPDATE OF status ON contributions
    FOR EACH ROW WHEN (NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied') EXECUTE FUNCTION task_dispatches_drop_applied()`);
  return db;
}
let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
async function manualTask(db: PGlite, target: Record<string, unknown>, type = "candidacy_source_missing"): Promise<string> {
  const id = uid();
  await db.exec(`INSERT INTO contribution_tasks (id, task_type, target) VALUES ('${id}', '${type}', '${JSON.stringify(target)}')`);
  await db.exec(`INSERT INTO task_dispatches (task_id, task_type, target) VALUES ('${id}', '${type}', '${JSON.stringify(target)}')`);
  return id;
}
const listed = async (db: PGlite, id: string) => (await db.query<{ task_id: string }>(`SELECT task_id FROM contribution_queue_tasks(NULL, NULL, 1000, '', NULL, NULL)`)).rows.some((r) => r.task_id === id);
const exists = async (db: PGlite, id: string) => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM task_dispatches WHERE task_id = '${id}'`)).rows[0]!.n === 1;

Deno.test("B1 多人任務有交件在途也不停放；一般手動任務照舊停放", async () => {
  const db = await envB();
  const multi = await manualTask(db, { multi_person: true, origin: "roster_group" });
  const single = await manualTask(db, { kind: "roster_missing" });
  assertEquals(await listed(db, multi), true);
  assertEquals(await listed(db, single), true);
  for (const t of [multi, single]) await db.exec(`INSERT INTO contributions (task_id, contribution_type, status) VALUES ('${t}', 'candidacy', 'pending')`);
  assertEquals(await listed(db, multi), true, "多人任務：一位在途，其他人還能領");
  assertEquals(await listed(db, single), false, "一般手動任務：在途就停放");
  await db.close();
});

Deno.test("B2 一位的交件上線，多人任務的派工列不被收回；一般手動任務會被收回", async () => {
  const db = await envB();
  const multi = await manualTask(db, { multi_person: true });
  const single = await manualTask(db, { origin: "x" });
  for (const t of [multi, single]) {
    const id = uid();
    await db.exec(`INSERT INTO contributions (id, task_id, contribution_type, status) VALUES ('${id}', '${t}', 'candidacy', 'pending')`);
    await db.exec(`UPDATE contributions SET status = 'applied' WHERE id = '${id}'`);
  }
  assertEquals(await exists(db, multi), true, "多人任務留著");
  assertEquals(await exists(db, single), false, "一般手動任務：補完就收回");
  await db.close();
});

Deno.test("B3 還原驗證：機械替換拿掉豁免，多人任務就會被停放", async () => {
  const db = await envB((x) => mutate(x, "AND NOT task_target_multi_person(d.target)$s$", "$s$"));
  const multi = await manualTask(db, { multi_person: true });
  await db.exec(`INSERT INTO contributions (task_id, contribution_type, status) VALUES ('${multi}', 'candidacy', 'pending')`);
  assertEquals(await listed(db, multi), false, "沒有豁免：停放");
  await db.close();
});

// ============================================================
// C / D. 分組與對帳
// ============================================================
const SCHEMA_C = `
CREATE TABLE politicians (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, party text, region text, merged_into uuid, birth_year int);
CREATE TABLE regions (id serial PRIMARY KEY, region text, sub_region text, village text);
CREATE TABLE politician_elections (id serial PRIMARY KEY, politician_id uuid, region_id int);
CREATE TABLE cec_roster_units (url text PRIMARY KEY, election_type text, county text, town text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'ok', fetched_at timestamptz DEFAULT now());
CREATE TABLE _diff (kind text, diff_key text, election_type text, county text, town text, unit text, cand_no int, pe_id int, politician_id uuid, our_name text, our_status text,
  our_cand_no int, roster_id bigint, roster_name text, roster_party text, roster_birth text, roster_url text, roster_li_code text, partner_pe_id int, partner_politician_id uuid, partner_name text);
CREATE FUNCTION cec_roster_diff() RETURNS SETOF _diff LANGUAGE sql STABLE AS $$ SELECT * FROM _diff $$;
CREATE TABLE _gap (election_type text, county text, town text, items jsonb);
CREATE FUNCTION roster_gap_units() RETURNS TABLE (election_type text, county text, town text, items jsonb) LANGUAGE sql STABLE AS $$ SELECT * FROM _gap $$;
CREATE TABLE _fnd (election_id int, election_type text, county text, town text, kind text, politician_id uuid, politician_election_id int, name text, current_value jsonb, official_value jsonb, source_url text);
CREATE FUNCTION roster_diff_findings() RETURNS TABLE (election_id int, election_type text, county text, town text, kind text, politician_id uuid, politician_election_id int, name text,
  current_value jsonb, official_value jsonb, source_url text) LANGUAGE sql STABLE AS $$ SELECT * FROM _fnd $$;
CREATE TABLE contribution_tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, description text, task_type text, target jsonb NOT NULL DEFAULT '{}'::jsonb,
  region text, priority int, reward int, status text NOT NULL DEFAULT 'open', source text, created_by text, hint_sources text[], closed_at timestamptz);
`;
async function envC(mutateTasks: (s: string) => string = (s) => s): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA_C);
  await db.exec(strip(section(MIG, "people")));
  await db.exec(strip(mutateTasks(section(MIG, "tasks"))));
  return db;
}
const q = async <T = Record<string, any>>(db: PGlite, sql: string) => (await db.query<T>(sql)).rows;
const esc = (s: string) => s.replaceAll("'", "''");
async function unit(db: PGlite, type: string, county: string, town = "", ageDays = 0) {
  await db.exec(`INSERT INTO cec_roster_units (url, election_type, county, town, fetched_at) VALUES ('https://example/${type}${county}${town}', '${type}', '${county}', '${town}', now() - interval '${ageDays} days')`);
}
function missingItems(count: number, prefix: string) {
  return Array.from({ length: count }, (_, i) => ({
    kind: "缺人", name: `${prefix}${i + 1}`, current: { region: "台中市" },
    official: { village: `里${i + 1}`, cand_no: i + 1, party: "無", birth_roc: "0700101", birth_year: 1981, unit: "台中市|北屯區" },
    source_url: "https://info.cec.gov.tw/vote2026/static/json/cand/V1/66000/66000080.json",
  }));
}
async function gap(db: PGlite, type: string, county: string, town: string, items: unknown[]) {
  await db.exec(`INSERT INTO _gap VALUES ('${type}', '${county}', '${town}', '${esc(JSON.stringify(items))}')`);
}
async function extra(db: PGlite, type: string, county: string, town: string, peId: number, name: string) {
  await db.exec(`INSERT INTO _diff (kind, diff_key, election_type, county, town, pe_id, politician_id, our_name, our_status, our_cand_no)
    VALUES ('extra', 'extra:${peId}', '${type}', '${county}', '${town}', ${peId}, gen_random_uuid(), '${name}', 'filed', 3)`);
}
async function wrongOwner(db: PGlite, county: string, peId: number, name: string) {
  await db.exec(`INSERT INTO _fnd VALUES (2026, '縣市議員', '${county}', '', '掛錯人', gen_random_uuid(), ${peId}, '${name}',
    '{"birth_year":1962,"district":"第1選舉區","party":"無黨籍","region":"${county}"}',
    '{"signals":[{"kind":"vote_said_different","detail":"驗證的人寫了不是同一人"}],"same_name":[{"politician_id":"abc","birth_year":1957,"region":"南投縣","party":"無黨籍"}],"cec_same_name":[]}',
    'https://db.cec.gov.tw/query?cand_name=${name}')`);
}
const groupTasks = (db: PGlite) => q<{ id: string; title: string; description: string; target: any; task_type: string; region: string; status: string; source: string; created_by: string }>(
  db, `SELECT * FROM contribution_tasks WHERE target->>'origin' = 'roster_group' ORDER BY title`);

Deno.test("C1 分組：17 位同縣市同選舉別同做法 → 3 張（6/6/5），每張最多 8 位；說明逐人寫明姓名、村里、號次、官方網址；標題講縣市、選舉別、做法、人數", async () => {
  const db = await envC();
  await unit(db, "村里長", "台中市", "北屯區");
  await gap(db, "村里長", "台中市", "北屯區", missingItems(17, "王"));
  const made = (await q<{ n: number }>(db, `SELECT roster_group_tasks_create('t') AS n`))[0]!.n;
  assertEquals(made, 3);
  const ts = await groupTasks(db);
  const sizes = ts.map((t) => t.target.people_count).sort((a: number, b: number) => b - a);
  assertEquals(sizes, [6, 6, 5]);
  assert(sizes.every((s: number) => s <= 8));
  for (const t of ts) {
    assertEquals(t.task_type, "candidacy_source_missing");
    assertEquals(t.source, "manual");
    assertEquals(t.status, "open");
    assertEquals(t.target.multi_person, true);
    assert(t.title.includes("台中市") && t.title.includes("村里長") && t.title.includes("補參選紀錄") && t.title.endsWith(`${t.target.people_count} 位`), t.title);
    assert(t.description.includes("task_id 都填本任務 id") && t.description.includes("candidacy"));
    assert(t.description.includes("https://info.cec.gov.tw/vote2026/static/json/cand/V1/66000/66000080.json"));
    for (const p of t.target.people) assert(t.description.includes(`「${p.name}」`) && t.description.includes("北屯區") && t.description.includes("號次"));
  }
  assertEquals(new Set(ts.flatMap((t) => t.target.people.map((p: any) => p.key))).size, 17, "每個人剛好在一張裡");
  await db.close();
});

Deno.test("C2 不足 6 位的（縣市, 選舉別, 做法）跨縣市併成「多縣市」一組；夠 6 位的留在自己縣市", async () => {
  const db = await envC();
  for (let i = 1; i <= 3; i++) await extra(db, "村里長", `甲${i}縣`, "某區", 100 + i, `乙${i}`);
  for (let i = 1; i <= 6; i++) await extra(db, "村里長", "大縣", "某區", 200 + i, `丙${i}`);
  const made = (await q<{ n: number }>(db, `SELECT roster_group_tasks_create('t') AS n`))[0]!.n;
  assertEquals(made, 2);
  const ts = await groupTasks(db);
  const pooled = ts.find((t) => t.title.includes("多縣市"))!;
  const own = ts.find((t) => t.title.startsWith("大縣"))!;
  assertEquals(pooled.target.people_count, 3);
  assertEquals(own.target.people_count, 6);
  assertEquals(pooled.task_type, "candidate_status_stale");
  assert(pooled.description.includes("not_running") && pooled.description.includes("politician_election_id 101"));
  assert(pooled.title.includes("甲1縣"));
  // 還原驗證：不併組就會變成 4 張
  const db2 = await envC();
  for (let i = 1; i <= 3; i++) await extra(db2, "村里長", `甲${i}縣`, "某區", 100 + i, `乙${i}`);
  for (let i = 1; i <= 6; i++) await extra(db2, "村里長", "大縣", "某區", 200 + i, `丙${i}`);
  assertEquals((await q<{ n: number }>(db2, `SELECT roster_group_tasks_create('t', 8, 1) AS n`))[0]!.n, 4, "p_pool_min=1（等於不併）：每縣市一張");
  await db.close(); await db2.close();
});

Deno.test("C3 冪等：人已在 open 的分組任務裡就不再開；新出現的人只開新的一張", async () => {
  const db = await envC();
  for (let i = 1; i <= 7; i++) await wrongOwner(db, "新北市", 300 + i, `丁${i}`);
  assertEquals((await q<{ n: number }>(db, `SELECT roster_group_tasks_create('t') AS n`))[0]!.n, 1);
  assertEquals((await q<{ n: number }>(db, `SELECT roster_group_tasks_create('t') AS n`))[0]!.n, 0, "再跑一次不重開");
  await wrongOwner(db, "新北市", 399, "戊");
  assertEquals((await q<{ n: number }>(db, `SELECT roster_group_tasks_create('t') AS n`))[0]!.n, 1, "新人另開一張");
  const ts = await groupTasks(db);
  assertEquals(ts.length, 2);
  const t = ts.find((x) => x.target.people_count === 7)!;
  assertEquals(t.task_type, "candidacy_owner_mismatch");
  assert(t.description.includes("訊號：驗證的人寫了不是同一人") && t.description.includes("站上同名者：abc") && t.description.includes("reassign_candidacy"));
  // 任務關掉後（人還在差異裡）可以重開
  await db.exec(`UPDATE contribution_tasks SET status = 'closed' WHERE target->>'people_count' = '1'`);
  assertEquals((await q<{ n: number }>(db, `SELECT roster_group_tasks_create('t') AS n`))[0]!.n, 1);
  await db.close();
});

Deno.test("C4 關單人任務：人已不在 extra 差異（且名冊新鮮）→ 關；已被分組任務收進去 → 關；還在差異又沒人收 → 留著", async () => {
  const db = await envC();
  await unit(db, "村里長", "台中市", "北屯區");
  await extra(db, "村里長", "台中市", "北屯區", 501, "在分組裡");
  await extra(db, "村里長", "台中市", "北屯區", 502, "沒人收");
  const single = async (pe: number, over = "") => {
    await db.exec(`INSERT INTO contribution_tasks (title, task_type, target, status, source, created_by) VALUES ('單人', 'candidate_status_stale',
      '{"politician_election_id":${pe},"election_type":"村里長","region":"台中市","sub_region":"北屯區"${over}}', 'open', 'manual', 'cec-extra-sweep')`);
  };
  await single(501); await single(502); await single(503); // 503 已不在差異
  await db.exec(`INSERT INTO contribution_tasks (title, task_type, target, status, source, created_by) VALUES ('別人的', 'candidate_status_stale', '{"politician_election_id":503}', 'open', 'manual', 'someone-else')`);
  // 只讓 501 進分組任務：先開，再把 502 的分組任務關掉
  await q(db, `SELECT roster_group_tasks_create('t')`);
  await db.exec(`UPDATE contribution_tasks SET target = jsonb_set(target, '{people}', (SELECT jsonb_agg(e) FROM jsonb_array_elements(target->'people') e WHERE e->>'key' = 'extra:501')) WHERE target->>'origin' = 'roster_group'`);
  const closed = (await q<{ n: number }>(db, `SELECT roster_group_close_extra_singles() AS n`))[0]!.n;
  assertEquals(closed, 2, "501（被收進去）與 503（過時）");
  const open = (await q<{ pe: string }>(db, `SELECT target->>'politician_election_id' AS pe FROM contribution_tasks WHERE created_by = 'cec-extra-sweep' AND status = 'open'`)).map((r) => r.pe);
  assertEquals(open, ["502"]);
  assertEquals((await q<{ s: string }>(db, `SELECT status AS s FROM contribution_tasks WHERE created_by = 'someone-else'`))[0]!.s, "open", "只動 cec-extra-sweep");
  // 名冊不新鮮：過時的不能當成處理完
  await db.exec(`UPDATE cec_roster_units SET fetched_at = now() - interval '5 days'`);
  await single(504);
  assertEquals((await q<{ n: number }>(db, `SELECT roster_group_close_extra_singles() AS n`))[0]!.n, 0, "鏡像過期：不關");
  await db.close();
});

Deno.test("D1 對帳：處理完的人從任務移除並更新人數與說明；全部處理完才 closed；官方名冊鏡像過期不算處理完", async () => {
  const db = await envC();
  await unit(db, "村里長", "高雄市", "某區");
  for (let i = 1; i <= 4; i++) await extra(db, "村里長", "高雄市", "某區", 600 + i, `己${i}`);
  await q(db, `SELECT roster_group_tasks_create('t')`);
  const get = async () => (await groupTasks(db))[0]!;
  assertEquals((await get()).target.people_count, 4);
  // 沒變：什麼都不動
  assertEquals((await q<{ n: number }>(db, `SELECT roster_group_tasks_sweep() AS n`))[0]!.n, 0);
  assertEquals((await get()).target.people_count, 4);
  // 兩位處理完（不在 extra 差異裡了）
  await db.exec(`DELETE FROM _diff WHERE pe_id IN (601, 602)`);
  assertEquals((await q<{ n: number }>(db, `SELECT roster_group_tasks_sweep() AS n`))[0]!.n, 0);
  let t = await get();
  assertEquals(t.status, "open");
  assertEquals(t.target.people_count, 2);
  assert(t.title.endsWith("2 位") && !t.title.includes("4 位"), t.title);
  assert(!t.description.includes("「己1」") && t.description.includes("「己3」") && t.description.includes("「己4」"));
  // 鏡像過期：其餘兩位也不在差異裡，但不能當成處理完
  await db.exec(`DELETE FROM _diff`);
  await db.exec(`UPDATE cec_roster_units SET fetched_at = now() - interval '4 days'`);
  assertEquals((await q<{ n: number }>(db, `SELECT roster_group_tasks_sweep() AS n`))[0]!.n, 0);
  assertEquals((await get()).status, "open", "鏡像過期：留著");
  // 鏡像新鮮：全部處理完 → 關
  await db.exec(`UPDATE cec_roster_units SET fetched_at = now()`);
  assertEquals((await q<{ n: number }>(db, `SELECT roster_group_tasks_sweep() AS n`))[0]!.n, 1);
  t = await get();
  assertEquals(t.status, "closed");
  await db.close();
  // 還原驗證：拿掉鏡像新鮮判斷，過期的也會關
  const bad = await envC((s) => mutate(s, "OR (e.p->>'action' IN ('missing', 'extra', 'cand_no') AND NOT roster_group_fresh(e.p->>'election_type', e.p->>'county', e.p->>'town'));", ";"));
  await unit(bad, "村里長", "高雄市", "某區", 4);
  await extra(bad, "村里長", "高雄市", "某區", 701, "庚");
  await q(bad, `SELECT roster_group_tasks_create('t')`);
  await bad.exec(`DELETE FROM _diff`);
  assertEquals((await q<{ n: number }>(bad, `SELECT roster_group_tasks_sweep() AS n`))[0]!.n, 1, "沒有新鮮判斷：誤關");
  await bad.close();
});

Deno.test("D2 不靠鏡像的做法（掛錯人）：差異消失就算處理完，不需要該縣市有官方名冊單位", async () => {
  const db = await envC();
  for (let i = 1; i <= 2; i++) await wrongOwner(db, "新北市", 800 + i, `辛${i}`);
  await q(db, `SELECT roster_group_tasks_create('t')`);
  await db.exec(`DELETE FROM _fnd`);
  assertEquals((await q<{ n: number }>(db, `SELECT roster_group_tasks_sweep() AS n`))[0]!.n, 1);
  await db.close();
});

// ============================================================
// E. 暫停名冊對帳的 INSERT
// ============================================================
Deno.test("E 暫停名冊對帳：兩列 closed／2026／有 reason、冪等、用 created_by 一次還原", async () => {
  const db = new PGlite();
  await db.exec(`CREATE TABLE activity_overrides (id serial PRIMARY KEY, activity text NOT NULL, election_id int, election_type text, "force" text NOT NULL,
    open_from date, open_until date, reason text NOT NULL CHECK (length(btrim(reason)) > 0), created_by text, expires_at date);
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, boost_seconds bigint NOT NULL DEFAULT 0);
    INSERT INTO task_dispatches VALUES ('auto:roster_check:2026:台北市:縣市議員', 157680000), ('auto:roster_check:2026:花蓮縣花蓮市:村里長', 0), ('auto:policy_missing:x', 157680000);`);
  const run = section(MIG, "run");
  const ins = run.slice(run.indexOf("INSERT INTO activity_overrides"), run.indexOf("-- 派工列在下一輪"));
  await db.exec(ins); await db.exec(ins);
  const rows = await q<{ activity: string; election_id: number; force: string; reason: string; created_by: string }>(db, `SELECT activity, election_id, "force" AS force, reason, created_by FROM activity_overrides ORDER BY activity`);
  assertEquals(rows.map((r) => [r.activity, r.election_id, r.force, r.created_by]), [["raw:roster_check", 2026, "closed", "roster-group-2026-11-07"], ["roster_villages", 2026, "closed", "roster-group-2026-11-07"]]);
  assert(rows.every((r) => r.reason.length > 20));
  const boosts = await q<{ task_id: string; boost_seconds: string }>(db, `SELECT * FROM task_dispatches ORDER BY task_id`);
  assertEquals(boosts.map((b) => b.task_id + ":" + b.boost_seconds), ["auto:policy_missing:x:157680000", "auto:roster_check:2026:台北市:縣市議員:157680000", "auto:roster_check:2026:花蓮縣花蓮市:村里長:0"], "插隊歸零在 run 段後面那句，這裡只驗 INSERT");
  await db.exec(`UPDATE task_dispatches SET boost_seconds = 0 WHERE task_id LIKE 'auto:roster_check:2026%' AND boost_seconds <> 0`);
  assertEquals((await q<{ b: number }>(db, `SELECT boost_seconds AS b FROM task_dispatches WHERE task_id = 'auto:policy_missing:x'`))[0]!.b, 157680000, "只動 roster_check 2026");
  await db.exec(`DELETE FROM activity_overrides WHERE created_by = 'roster-group-2026-11-07'`);
  assertEquals((await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM activity_overrides`))[0]!.n, 0, "一句還原");
  assert(run.includes("UPDATE task_dispatches SET boost_seconds = 0 WHERE task_id LIKE 'auto:roster_check:2026%' AND boost_seconds <> 0;"));
  await db.close();
});

// ============================================================
// F. TS
// ============================================================
Deno.test("F1 shouldCloseOnApplied／isMultiPersonTarget：多人任務不關，其他照舊", () => {
  assertEquals(isMultiPersonTarget({ multi_person: true }), true);
  assertEquals(isMultiPersonTarget({ multi_person: "true" }), false);
  assertEquals(isMultiPersonTarget(null), false);
  assertEquals(shouldCloseOnApplied("candidacy_source_missing", "candidacy", { multi_person: true }), false);
  assertEquals(shouldCloseOnApplied("candidacy_source_missing", "candidacy", {}), true);
  assertEquals(shouldCloseOnApplied("candidacy_source_missing", "candidacy"), true, "不帶 target＝舊行為");
  assertEquals(shouldCloseOnApplied("candidate_status_stale", "correction", { multi_person: true }), false);
});

Deno.test("F2 closeTaskIfFulfilled：多人任務的一筆交件上線，任務不關；一般任務照關", async () => {
  const mk = (target: Record<string, unknown>) => {
    const updates: unknown[] = [];
    const db = {
      from: (table: string) => ({
        select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: table === "contribution_tasks" ? { id, status: "open", task_type: "candidacy_source_missing", target } : null, error: null }) }) }),
        update: (patch: Record<string, unknown>) => ({ eq: (_c: string, id: string) => { updates.push({ table, patch, id }); return { select: () => ({ maybeSingle: async () => ({ data: { id, status: "closed" }, error: null }) }) }; } }),
        insert: () => ({ error: null }),
      }),
    };
    return { db, updates };
  };
  const row = { id: "c1", contribution_type: "candidacy", payload: {}, source_urls: ["https://example.org"], note: null, agent_name: "a", contributor_url: null, task_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } as ContributionRow;
  const multi = mk({ multi_person: true });
  assertEquals(await closeTaskIfFulfilled(multi.db as never, row), false);
  assertEquals(multi.updates.length, 0);
  const one = mk({});
  assertEquals(await closeTaskIfFulfilled(one.db as never, row), true);
  assertEquals(one.updates.length, 1);
});
