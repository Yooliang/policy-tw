/**
 * 查參選狀態任務（cec_roster_extra）可連號次一起交；同一筆參選紀錄已有這種 open 任務時補號次缺口不再派
 * （policy-ops#175 本期；migration 20261102170000_status_task_takes_cand_no.sql，協議 1.112.0）。
 *
 * 守住：
 *   1. 補號次缺口：這筆參選紀錄有 open 的 cec_roster_extra 任務就不進缺口；任務結案（或不是 cec_roster_extra、或是別人的紀錄）缺口照舊
 *   2. 整個單位只剩被排除的人時，整件缺口消失（＝seed 既有的收回機制會收回，gap_events 照記）；單位裡其他人不受影響
 *   3. 現有 229 張任務的說明補一段「號次也在這張交」（冪等、只動 open 的 cec_roster_extra）；cec_extra_status_tasks_create 新開的也帶
 *   4. 不寫任何參選欄位
 *   5. TS／文件端：TASK_BRANCHES 收 candidacy、骨架有 candidacy、任務指引與 skill-types 有講、協議版號不低於 1.112.0
 * 還原驗證：拿掉排除條件、拿掉 open 條件，對應測試要紅（見最後兩個測試）。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { latestFn, mutate, readMig } from "./arms-pglite.ts";
import { buildBranchTemplates, TASK_BRANCHES, TASK_GUIDANCE } from "./task-guidance.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { readSkillWithTypes } from "./skill-text.ts";

const MIG_NAME = "20261102170000_status_task_takes_cand_no.sql";
const M = await readMig(MIG_NAME);
const EXCLUDE = "AND cs.target->>'politician_election_id' = rk.pe_id::TEXT)";
const fnOf = (sql: string, name: string) => {
  const a = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert(a >= 0, `找不到 ${name}`);
  return sql.slice(a, sql.indexOf("\n$$;", a) + 4);
};
const codeOnly = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

async function viewDef(): Promise<string> {
  // 號次單位視圖：取最後一次定義（本 migration 沒動它）
  let def = "";
  const names = await (await import("./arms-pglite.ts")).migrationNames();
  for (const n of names) {
    const s = await readMig(n);
    const a = s.lastIndexOf("CREATE OR REPLACE VIEW ballot_number_units AS");
    if (a >= 0) def = s.slice(a, s.indexOf(";\n", a) + 1);
  }
  assert(def !== "");
  return def;
}

async function buildDb(edit: (s: string) => string = (s) => s): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE elections (id integer PRIMARY KEY, election_date date);
    CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
    CREATE TABLE politicians (id uuid PRIMARY KEY, name text, region text, merged_into uuid);
    CREATE TABLE politician_elections (id integer PRIMARY KEY, election_id integer, politician_id uuid, election_type text, region_id integer, candidacy_status text, cand_no integer);
    CREATE TABLE contributions (id serial PRIMARY KEY, contribution_type text, status text, payload jsonb);
    CREATE TABLE contribution_tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, description text, task_type text NOT NULL,
      target jsonb NOT NULL DEFAULT '{}', region text, priority integer NOT NULL DEFAULT 1, reward integer NOT NULL DEFAULT 1,
      status text NOT NULL DEFAULT 'open', created_by text, created_at timestamptz NOT NULL DEFAULT now(),
      source text, hint_sources text[] DEFAULT '{}', closed_at timestamptz);
    CREATE TABLE election_milestones_all (election_id integer, kind text, election_type text, on_date date, status text);
    CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql STABLE AS $$ SELECT date '2026-10-23' $$;
    CREATE FUNCTION candidacy_list_published(p_election_id integer, p_election_type text, p_on date) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION cec_vote2026_cand_url(p_et text, p_county text, p_town text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;
    ${await latestFn("candidacy_protocol_status")}
    ${await latestFn("ballot_number_unit")}
    ${await latestFn("ballot_number_dups")}
    ${await latestFn("ballot_number_missing")}`);
  await db.exec(await viewDef());
  await db.exec(edit(fnOf(M, "contribution_auto_tasks_ballot_numbers")));
  await db.exec(`INSERT INTO elections VALUES (2026, '2026-11-28')`);
  await db.exec(`INSERT INTO election_milestones_all VALUES (2026, 'draw', NULL, '2026-10-23', 'announced')`);
  return db;
}

let nextId = 1;
async function person(db: PGlite, name: string, county = "台北市", cand_no: number | null = null): Promise<number> {
  const id = nextId++;
  const pid = `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
  await db.query(`INSERT INTO politicians VALUES ($1, $2, $3, NULL)`, [pid, name, county]);
  await db.query(`INSERT INTO politician_elections VALUES ($1, 2026, $2, '縣市長', NULL, 'filed', $3)`, [id, pid, cand_no]);
  return id;
}
const extraTask = (db: PGlite, peId: number, o: { status?: string; origin?: string; type?: string } = {}) =>
  db.query(
    `INSERT INTO contribution_tasks (title, description, task_type, target, status, source, created_by) VALUES ('t', '原說明', $1, $2::jsonb, $3, 'manual', 'cec-extra-sweep')`,
    [o.type ?? "candidate_status_stale", JSON.stringify({ politician_election_id: peId, origin: o.origin ?? "cec_roster_extra" }), o.status ?? "open"],
  );
// deno-lint-ignore no-explicit-any
const gaps = async (db: PGlite) => (await db.query<{ task_id: string; target: Record<string, any> }>(`SELECT task_id, target FROM contribution_auto_tasks_ballot_numbers() ORDER BY task_id`)).rows;
// deno-lint-ignore no-explicit-any
const gapNames = async (db: PGlite) => (await gaps(db)).flatMap((g) => g.target.items ?? []).map((i: any) => i.name as string).sort();

Deno.test("沒有 open 的查參選狀態任務：缺口照舊（對照組）", async () => {
  const db = await buildDb();
  await person(db, "甲");
  await person(db, "乙");
  assertEquals(await gapNames(db), ["乙", "甲"]);
  await db.close();
});

Deno.test("有 open 的 cec_roster_extra 任務的那筆不進補號次缺口，同單位其他人照派", async () => {
  const db = await buildDb();
  const a = await person(db, "甲");
  await person(db, "乙");
  await extraTask(db, a);
  assertEquals(await gapNames(db), ["乙"]);
  await db.close();
});

Deno.test("單位裡只剩被排除的人：整件缺口消失（由 seed 既有的收回機制收回）", async () => {
  const db = await buildDb();
  const a = await person(db, "甲");
  assertEquals((await gaps(db)).length, 1);
  await extraTask(db, a);
  assertEquals((await gaps(db)).length, 0);
  await db.close();
});

Deno.test("任務結案後仍缺號次，缺口回來；不是 cec_roster_extra／不是這個型別／別人的紀錄的任務不影響", async () => {
  const db = await buildDb();
  const a = await person(db, "甲");
  const b = await person(db, "乙");
  const c = await person(db, "丙");
  const d = await person(db, "丁");
  await extraTask(db, a, { status: "closed" });
  await extraTask(db, b, { origin: "auto" });
  await extraTask(db, c, { type: "profile_gap" });
  await extraTask(db, 99999); // 別筆紀錄
  assertEquals(await gapNames(db), ["丁", "乙", "丙", "甲"].sort());
  await extraTask(db, d); // 丁有 open 的
  assertEquals(await gapNames(db), ["乙", "丙", "甲"].sort());
  await db.query(`UPDATE contribution_tasks SET status = 'closed', closed_at = now() WHERE target->>'politician_election_id' = $1`, [String(d)]);
  assertEquals(await gapNames(db), ["丁", "乙", "丙", "甲"].sort());
  await db.close();
});

Deno.test("不寫任何參選欄位：函式只讀，migration 只有一句 UPDATE 且只改 contribution_tasks", async () => {
  const db = await buildDb();
  const a = await person(db, "甲");
  await extraTask(db, a);
  const before = JSON.stringify((await db.query(`SELECT * FROM politician_elections ORDER BY id`)).rows);
  await gaps(db);
  assertEquals(JSON.stringify((await db.query(`SELECT * FROM politician_elections ORDER BY id`)).rows), before);
  const code = codeOnly(M);
  assertEquals([...code.matchAll(/\bUPDATE\s+(\w+)/g)].map((m) => m[1]), ["contribution_tasks"]);
  assert(!/INSERT\s+INTO\s+politician_elections|DELETE\s+FROM/i.test(code));
  await db.close();
});

Deno.test("現有任務補說明（冪等、只動 open 的 cec_roster_extra），新開的任務函式也帶同一段", async () => {
  const db = new PGlite();
  await db.exec(`CREATE TABLE contribution_tasks (id serial PRIMARY KEY, description text, task_type text, status text, target jsonb)`);
  await db.exec(`INSERT INTO contribution_tasks (description, task_type, status, target) VALUES
    ('A', 'candidate_status_stale', 'open', '{"origin":"cec_roster_extra"}'),
    ('B', 'candidate_status_stale', 'closed', '{"origin":"cec_roster_extra"}'),
    ('C', 'candidate_status_stale', 'open', '{"origin":"auto"}'),
    ('D', 'profile_gap', 'open', '{"origin":"cec_roster_extra"}')`);
  const upd = M.slice(M.lastIndexOf("UPDATE contribution_tasks"));
  await db.exec(upd);
  await db.exec(upd); // 冪等
  const r = (await db.query<{ description: string }>(`SELECT description FROM contribution_tasks ORDER BY id`)).rows.map((x) => x.description);
  assert(r[0].startsWith("A") && r[0].includes("號次也在這張交") && r[0].includes("candidacy") && r[0].includes("cand_no"));
  assertEquals(r[0].split("號次也在這張交").length, 2, "重跑不重複補");
  assertEquals([r[1], r[2], r[3]], ["B", "C", "D"]);
  const create = fnOf(M, "cec_extra_status_tasks_create");
  assertStringIncludes(create, "號次也在這張交");
  const para = (s: string) => s.match(/號次也在這張交[^']*/)![0];
  assertEquals(para(create), para(upd));
  await db.close();
});

Deno.test("TS／文件端：candidate_status_stale 收 candidacy（骨架、指引、協議），版號不低於 1.112.0", async () => {
  assertEquals(TASK_BRANCHES.candidate_status_stale, ["correction", "candidacy", "no_change"]);
  const t = buildBranchTemplates("candidate_status_stale", {
    politician_id: "00000000-0000-4000-8000-000000000001", politician_election_id: 35070, election_id: 2026,
    election_type: "縣市議員", region: "台北市", origin: "cec_roster_extra",
  }, "00000000-0000-4000-8000-0000000000aa");
  assert(t && "candidacy" in t && "correction" in t && "no_change" in t, "三條路的骨架都要送出去");
  assertStringIncludes(TASK_GUIDANCE.candidate_status_stale, "cec_roster_extra");
  assertStringIncludes(TASK_GUIDANCE.candidate_status_stale, "cand_no");
  const doc = await readSkillWithTypes();
  assert(doc.includes("candidate_status_stale") && doc.includes("連號次一起交"), "skill-types 要講");
  const [maj, min] = PROTOCOL_VERSION.split(".").map(Number);
  assert(maj > 1 || min >= 112);
});

Deno.test("還原驗證：拿掉排除條件，被排除的人又進缺口（「單位裡只剩被排除的人」會紅）", async () => {
  const db = await buildDb((s) => mutate(s, EXCLUDE, "AND false)"));
  const a = await person(db, "甲");
  await extraTask(db, a);
  assertEquals((await gaps(db)).length, 1, "排除條件拿掉＝缺口又出現");
  await db.close();
});

Deno.test("還原驗證：拿掉 open 條件，結案的任務也會排除（「結案後缺口回來」會紅）", async () => {
  const db = await buildDb((s) => mutate(s, "AND cs.status = 'open'", "AND true"));
  const a = await person(db, "甲");
  await extraTask(db, a, { status: "closed" });
  assertEquals((await gaps(db)).length, 0, "拿掉 open 條件＝結案後缺口回不來");
  await db.close();
});
