/**
 * 補號次缺口：不在中選會抽籤後名冊的人不派（2026-11-09，migration 20261109190000_cand_no_ladder_and_off_roster.sql）。
 * 根因：登記彙總表有、候選人 JSON 沒有的人（登記後退出、資格不符）永遠不會有號次，舊版把他列進缺口、整個單位反覆重派（實例：苗栗縣頭份市 黃世男）。
 *   1. 名冊（cec_roster_2026）有這個單位的資料、而他的姓名不在名冊上 → 不進缺口
 *   2. 在名冊上（含造字代碼萬用字元）→ 照派；名冊沒有這個單位（沒抓到）→ 照派（不能因為沒資料就排除）
 *   3. 村里長按縣市＋鄉鎮比對，別的鄉鎮有名冊不影響這個鄉鎮；單位裡只剩被排除的人時整件缺口消失
 *   4. 只讀：不寫任何參選欄位；還原驗證：拿掉排除條件，第 1 項必須紅
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { latestFn, mutate, readMig } from "./arms-pglite.ts";

const M = await readMig("20261109190000_cand_no_ladder_and_off_roster.sql");
const fnOf = (sql: string, name: string) => {
  const a = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert(a >= 0, `找不到 ${name}`);
  return sql.slice(a, sql.indexOf("\n$$;", a) + 4);
};
const MARK = "AND NOT (rk.election_id = 2026";

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
    CREATE TABLE cec_roster_2026 (id serial PRIMARY KEY, election_type text, county text, town text DEFAULT '', name text, name_key text);
    CREATE FUNCTION roster_name_key(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT p $$;
    ${await latestFn("cec_name_fuzzy_eq")}
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
async function person(db: PGlite, name: string, town: string | null = "頭份市", village = "珊湖里"): Promise<number> {
  const id = nextId++;
  const pid = `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
  const rid = 1000 + id;
  await db.query(`INSERT INTO regions VALUES ($1, '苗栗縣', $2, $3)`, [rid, town, village]);
  await db.query(`INSERT INTO politicians VALUES ($1, $2, '苗栗縣', NULL)`, [pid, name]);
  await db.query(`INSERT INTO politician_elections VALUES ($1, 2026, $2, '村里長', $3, 'filed', NULL)`, [id, pid, rid]);
  return id;
}
const roster = (db: PGlite, name: string, town = "頭份市") =>
  db.query(`INSERT INTO cec_roster_2026 (election_type, county, town, name, name_key) VALUES ('村里長', '苗栗縣', $1, $2, $2)`, [town, name]);
// deno-lint-ignore no-explicit-any
const gaps = async (db: PGlite) => (await db.query<{ task_id: string; target: Record<string, any> }>(`SELECT task_id, target FROM contribution_auto_tasks_ballot_numbers() ORDER BY task_id`)).rows;
// deno-lint-ignore no-explicit-any
const gapNames = async (db: PGlite) => (await gaps(db)).flatMap((g) => g.target.items ?? []).map((i: any) => i.name as string).sort();

Deno.test("名冊有這個單位、他不在名冊上：不派（黃世男型）；在名冊上的照派", async () => {
  const db = await buildDb();
  await person(db, "黃世男");
  await person(db, "朱妍菲");
  await roster(db, "朱妍菲");
  await roster(db, "別人");
  assertEquals(await gapNames(db), ["朱妍菲"]);
  await db.close();
});

Deno.test("名冊沒有這個單位的資料（沒抓到）：照派，不因沒資料而排除；別的鄉鎮有名冊也不影響", async () => {
  const db = await buildDb();
  await person(db, "黃世男");
  assertEquals(await gapNames(db), ["黃世男"]);
  await roster(db, "別人", "竹南鎮");
  assertEquals(await gapNames(db), ["黃世男"]);
  await roster(db, "別人", "頭份市");
  assertEquals(await gapNames(db), []);
  await db.close();
});

Deno.test("造字代碼萬用字元視為同一人；參選紀錄沒記到鄉鎮（算不出單位）不排除", async () => {
  const db = await buildDb();
  await person(db, "王小明");
  await roster(db, "王@2F97F@明");
  await person(db, "無鄉鎮", null);
  await roster(db, "別人");
  assertEquals(await gapNames(db), ["無鄉鎮", "王小明"].sort());
  await db.close();
});

Deno.test("單位裡只剩被排除的人：整件缺口消失；只讀不寫參選欄位", async () => {
  const db = await buildDb();
  await person(db, "黃世男");
  await roster(db, "朱妍菲");
  const before = JSON.stringify((await db.query(`SELECT * FROM politician_elections ORDER BY id`)).rows);
  assertEquals((await gaps(db)).length, 0);
  assertEquals(JSON.stringify((await db.query(`SELECT * FROM politician_elections ORDER BY id`)).rows), before);
  await db.close();
});

Deno.test("還原驗證：拿掉排除條件，黃世男型就回到缺口（測試會紅）", async () => {
  const db = await buildDb((s) => mutate(s, MARK, "AND NOT (false AND rk.election_id = 2026"));
  await person(db, "黃世男");
  await roster(db, "朱妍菲");
  assertEquals(await gapNames(db), ["黃世男"]);
  await db.close();
});
