/**
 * 村里長／鄉鎮市民代表缺政見的網站請求在選舉公報還沒上架前停放（migration 20261028130000_park_village_policy_web_requests.sql，維護者 2026-10-28）。
 *   A. 文字層：臂本體＝前一版（20261008165000）加一段標了 >>> 的停放條件，拿掉那段一字不差
 *   B. PGlite：停放的範圍、公報上架就放出來、不碰的類別（縣市議員、缺人物資料、公民提問、已過的屆別）、既有派工列被收回
 *   C. 還原驗證：停放條件拿掉 → B 的劇本翻面
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261028130000_park_village_policy_web_requests.sql";
const MIG = await readMig(MIG_NAME);
const PREV = await readMig("20261008165000_manual_tasks_as_arm.sql");
const FIX = await readMig("20261028150000_park_uses_bulletin_date.sql");  // 預計上架日不是空的：改看「日期為空或還沒到」

Deno.test("A1 臂本體：新定義＝前一版加停放那一段，拿掉後一字不差", () => {
  const neu = fnText(MIG, "contribution_auto_tasks_manual");
  const open = "     -- >>> 停放（20261028130000）：村里長／鄉鎮市民代表缺政見、公報還沒上架\n";
  const close = "     -- <<< 停放\n";
  assertEquals(neu.split(open).length - 1, 1);
  const stripped = neu.slice(0, neu.indexOf(open)) + neu.slice(neu.indexOf(close) + close.length);
  assertEquals(stripped, fnText(PREV, "contribution_auto_tasks_manual"));
  assert(neu.slice(neu.indexOf(open), neu.indexOf(close)).includes("NOT web_request_parked(t.id)"));
});

const SCHEMA = `
CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, task_type text NOT NULL, source text NOT NULL DEFAULT 'manual', status text NOT NULL DEFAULT 'open',
  title text, description text, target jsonb NOT NULL DEFAULT '{}'::jsonb, hint_sources text[], reward integer, region text);
CREATE TABLE elections (id text PRIMARY KEY, election_date date NOT NULL, bulletin_published_on date);
CREATE TABLE politician_elections (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), politician_id uuid NOT NULL, election_id text NOT NULL, election_type text NOT NULL);
CREATE TABLE citizen_questions (id uuid PRIMARY KEY, answer_count integer NOT NULL DEFAULT 0, stance_up integer NOT NULL DEFAULT 0);
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id text, contribution_type text, status text NOT NULL DEFAULT 'pending');
CREATE TABLE task_dispatches (task_id text PRIMARY KEY);
CREATE FUNCTION uuid_or_null(p text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE AS $f$ BEGIN RETURN p::uuid; EXCEPTION WHEN others THEN RETURN NULL; END $f$;
CREATE FUNCTION question_answer_cap() RETURNS integer LANGUAGE sql IMMUTABLE AS $f$ SELECT 3 $f$;
CREATE FUNCTION manual_task_is_visitor(p_source TEXT, p_task_type TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $f$ SELECT COALESCE(p_source = 'web_request', false) OR COALESCE(p_task_type = 'question', false) $f$;
`;
let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

async function env(mutate: (s: string) => string = (s) => s, mutateFix: (s: string) => string = (s) => s): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec("INSERT INTO elections VALUES ('2026', current_date + 30, NULL), ('2022', current_date - 900, current_date - 920)");
  await db.exec(mutate(MIG));
  await db.exec(mutateFix(FIX));
  return db;
}
async function req(db: PGlite, o: { type?: string; source?: string; level?: string; election?: string }): Promise<string> {
  const id = uid(), pid = uid();
  await db.exec(`INSERT INTO contribution_tasks (id, task_type, source, target) VALUES ('${id}', '${o.type ?? "policy_missing"}', '${o.source ?? "web_request"}', '{"politician_id":"${pid}"}')`);
  await db.exec(`INSERT INTO politician_elections (politician_id, election_id, election_type) VALUES ('${pid}', '${o.election ?? "2026"}', '${o.level ?? "村里長"}')`);
  return id;
}
const visible = async (db: PGlite): Promise<Set<string>> =>
  new Set((await db.query<{ task_id: string }>("SELECT task_id FROM contribution_auto_tasks_manual(true)")).rows.map((r) => r.task_id));

Deno.test("B1 停放的範圍：村里長／鄉鎮市民代表 × 缺政見 × 公報未上架 → 不出現；其他類別照舊出現", async () => {
  const db = await env();
  const village = await req(db, { level: "村里長" });
  const rep = await req(db, { level: "鄉鎮市民代表" });
  const council = await req(db, { level: "縣市議員" });
  const mayor = await req(db, { level: "縣市長" });
  const profile = await req(db, { type: "profile_gap", level: "村里長" });
  const old = await req(db, { level: "村里長", election: "2022" });
  const manual = await req(db, { source: "manual", level: "村里長" });  // 維護者建的不是網站請求：不在 visitor 臂
  const v = await visible(db);
  assert(!v.has(village), "村里長缺政見：停放");
  assert(!v.has(rep), "鄉鎮市民代表缺政見：停放");
  for (const [name, id] of [["縣市議員", council], ["縣市長", mayor], ["缺人物資料", profile], ["已過的屆別（2022）", old]] as const) assert(v.has(id), `${name}：不停放`);
  assert(!v.has(manual), "維護者建的任務不在網站請求臂");
  // 手動任務臂（manual_open）完全不受影響
  const open = new Set((await db.query<{ task_id: string }>("SELECT task_id FROM contribution_auto_tasks_manual(false)")).rows.map((r) => r.task_id));
  assert(open.has(manual), "manual_open 不受影響");
  await db.close();
});

Deno.test("B2 公報上架日一填就放出來；任務本身一直是 open（網站上還在）", async () => {
  const db = await env();
  const village = await req(db, { level: "村里長" });
  assert(!(await visible(db)).has(village));
  assertEquals((await db.query<{ status: string }>(`SELECT status FROM contribution_tasks WHERE id = '${village}'`)).rows[0]!.status, "open");
  // 預計上架日（未來）不算上架：仍停放
  await db.exec("UPDATE elections SET bulletin_published_on = current_date + 10 WHERE id = '2026'");
  assert(!(await visible(db)).has(village), "預計上架日還沒到：仍停放");
  await db.exec("UPDATE elections SET bulletin_published_on = current_date WHERE id = '2026'");
  assert((await visible(db)).has(village), "公報上架日到了：放出來");
  await db.close();
});

Deno.test("B3 既有派工列：migration 內一次收回停放的請求（其他的不動）", async () => {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec("INSERT INTO elections VALUES ('2026', current_date + 30, NULL)");
  // 先蓋出任務與派工列，再套 migration
  const mk = async (level: string) => {
    const id = uid(), pid = uid();
    await db.exec(`INSERT INTO contribution_tasks (id, task_type, source, target) VALUES ('${id}', 'policy_missing', 'web_request', '{"politician_id":"${pid}"}')`);
    await db.exec(`INSERT INTO politician_elections (politician_id, election_id, election_type) VALUES ('${pid}', '2026', '${level}')`);
    await db.exec(`INSERT INTO task_dispatches (task_id) VALUES ('${id}')`);
    return id;
  };
  const village = await mk("村里長"), council = await mk("縣市議員");
  await db.exec("INSERT INTO task_dispatches (task_id) VALUES ('auto:profile_gap:1'), ('verify:abc')");
  await db.exec(MIG);
  await db.exec(FIX);
  const left = new Set((await db.query<{ task_id: string }>("SELECT task_id FROM task_dispatches")).rows.map((r) => r.task_id));
  assert(!left.has(village), "停放的收回");
  for (const id of [council, "auto:profile_gap:1", "verify:abc"]) assert(left.has(id), `${id} 不動`);
  await db.close();
});

Deno.test("C 還原驗證：拿掉停放條件／停放函式永遠回 false → B1 必須翻面", async () => {
  const noClause = (s: string) => s.replace("AND NOT web_request_parked(t.id)", "AND true");
  assert(noClause(MIG) !== MIG);
  const db = await env(noClause);
  const village = await req(db, { level: "村里長" });
  assert((await visible(db)).has(village), "拿掉條件：村里長請求又出現");
  await db.close();
  const noPark = (s: string) => s.replace("(e.bulletin_published_on IS NULL OR e.bulletin_published_on > CURRENT_DATE)", "false");
  assert(noPark(FIX) !== FIX);
  const db2 = await env(undefined, noPark);
  const v2 = await req(db2, { level: "村里長" });
  assert((await visible(db2)).has(v2), "停放函式永遠 false：村里長請求又出現");
  await db2.close();
});
