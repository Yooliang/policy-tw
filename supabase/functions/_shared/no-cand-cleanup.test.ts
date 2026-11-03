/**
 * scripts/no-cand-cleanup-2026.sql（policy-ops#182）的守門：2026 已登記沒號次一次改狀態的一次性腳本。
 * PGlite 上跑真的腳本（結尾 ROLLBACK 換成 COMMIT）與還原腳本。
 *
 * 守住：
 *   1. 條件全成立：只改「已登記、沒號次、是 extra」的人，改成 withdrawn＋withdrawn_after_filing=false（不是觸發器寫的 true），
 *      留快照、edit_history（agent_name 標記）、收掉他們的查參選狀態任務，改完 cec_roster_diff 歸零；其他人一個字不動
 *   2. 任一條件不成立（缺人、帶號次的 extra、已登記沒號次卻不是 extra）整段退回，什麼都沒改、沒留快照表
 *   3. 還原腳本把狀態、任務改回去
 *   4. 預設（沒換 COMMIT）是演練：什麼都不留
 * 還原驗證：拿掉缺人檢查，「缺人」那個案例就不再被條件檢查擋下。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, mutate, readMig } from "./arms-pglite.ts";

const M = await readMig("20261031160000_cec_roster_2026.sql");
const HINT = await readMig("20261031140000_cand_no_cec_json_hint.sql");
const DROP = await readMig("20261007140000_candidacy_drop_legacy.sql");
const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\r\n/g, "\n");
const SCRIPT = await read("../../../scripts/no-cand-cleanup-2026.sql");
const RESTORE = await read("../../../scripts/no-cand-cleanup-2026-restore.sql");
const section = (sql: string, name: string) => {
  const a = sql.indexOf(`-- ▼▼ SECTION: ${name} ▼▼`);
  const b = sql.indexOf(`-- ▲▲ SECTION: ${name} ▲▲`);
  assert(a >= 0 && b > a, `找不到段落 ${name}`);
  return sql.slice(a, b);
};
const strip = (s: string) => s.replace(/^(REVOKE|GRANT)\b[^;]*;\s*$/gm, "");
const commit = (s: string) => {
  assert(/^ROLLBACK;/m.test(s), "腳本結尾應是 ROLLBACK 演練");
  return s.replace(/^ROLLBACK;.*$/m, "COMMIT;");
};

const SCHEMA = `
CREATE TABLE politicians (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, party text, region text, sub_region text, merged_into uuid);
CREATE TABLE regions (id serial PRIMARY KEY, region text, sub_region text, village text);
CREATE TABLE politician_elections (id serial PRIMARY KEY, election_id integer NOT NULL, election_type text, politician_id uuid NOT NULL,
  region_id integer, candidacy_status text, cand_no integer, withdrawn_after_filing boolean, source_note text,
  CONSTRAINT politician_elections_withdrawn_after_filing_check CHECK (withdrawn_after_filing IS NULL OR candidacy_status = 'withdrawn'));
CREATE TABLE edit_history (id bigserial PRIMARY KEY, table_name text NOT NULL, record_id text NOT NULL, field text NOT NULL, old_value jsonb, new_value jsonb,
  contribution_id uuid, agent_name text, applied_at timestamptz NOT NULL DEFAULT now(), reverted_at timestamptz, reverted_by text);
CREATE TABLE contribution_tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, task_type text, target jsonb, status text NOT NULL DEFAULT 'open',
  source text, closed_at timestamptz);
`;

async function buildDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  // 退選旗標觸發器：正式庫的原樣（filed → withdrawn 會自動寫 true）
  await db.exec(fnText(DROP, "politician_elections_withdrawn_flag"));
  await db.exec(`CREATE TRIGGER trg_politician_elections_withdrawn_flag BEFORE INSERT OR UPDATE OF candidacy_status ON politician_elections
    FOR EACH ROW EXECUTE FUNCTION politician_elections_withdrawn_flag();`);
  for (const f of ["cec_name_norm", "cec_name_key", "roster_name_fold", "roster_name_key", "ballot_number_unit"]) await db.exec(await latestFn(f));
  await db.exec(HINT.slice(0, HINT.indexOf("CREATE OR REPLACE FUNCTION contribution_auto_tasks_ballot_numbers()")));
  const REG = await readMig("20261008130000_cec_registrations.sql");
  await db.exec(REG.slice(0, REG.indexOf("CREATE OR REPLACE FUNCTION roster_registration_gap(")));
  for (const s of ["tables", "match", "mirror", "reconcile", "source", "gap"]) await db.exec(strip(section(M, s)));
  return db;
}

async function region(db: PGlite, r: string, sub: string): Promise<number> {
  const ex = await db.query<{ id: number }>(`SELECT id FROM regions WHERE region = $1 AND sub_region = $2`, [r, sub]);
  if (ex.rows[0]) return ex.rows[0].id;
  return (await db.query<{ id: number }>(`INSERT INTO regions (region, sub_region) VALUES ($1, $2) RETURNING id`, [r, sub])).rows[0].id;
}
async function ours(db: PGlite, name: string, no: number | null, status = "filed", county = "台北市", sub = "第07選舉區"): Promise<number> {
  const pid = (await db.query<{ id: string }>(`INSERT INTO politicians (name, region) VALUES ($1, $2) RETURNING id`, [name, county])).rows[0].id;
  const rid = await region(db, county, sub);
  return (await db.query<{ id: number }>(
    `INSERT INTO politician_elections (election_id, election_type, politician_id, region_id, candidacy_status, cand_no) VALUES (2026, '縣市議員', $1, $2, $3, $4) RETURNING id`,
    [pid, rid, status, no],
  )).rows[0].id;
}
async function task(db: PGlite, peId: number, origin = "cec_roster_extra") {
  await db.query(
    `INSERT INTO contribution_tasks (title, task_type, target, source) VALUES ('查', 'candidate_status_stale', $1::jsonb, 'manual')`,
    [JSON.stringify({ politician_election_id: peId, origin })]);
}
const T_URL = "https://info.cec.gov.tw/vote2026/static/json/cand/T/63000.json";
async function loadCouncil(db: PGlite, rows: { name: string; no: number }[]) {
  await db.query(`SELECT cec_roster_seed_units()`);
  const res = await db.query<{ r: string }>(`SELECT cec_roster_replace_unit($1, 200, $2::jsonb) AS r`, [
    T_URL, JSON.stringify(rows.map((r) => ({ name: r.name, cand_no: r.no, party: "無", birth: "0600101", home: "", district: "臺北市第7選舉區", area_code: "07", dept_code: "", li_code: "" }))),
  ]);
  assertEquals(res.rows[0].r, "ok");
}

/** 條件成立的基本盤：兩位對得上、兩位已登記沒號次且名單查無（extra）、一位退選 */
async function base(db: PGlite, roster = [{ name: "王小明", no: 1 }, { name: "李大華", no: 2 }]) {
  await ours(db, "王小明", 1);
  await ours(db, "李大華", 2);
  const e1 = await ours(db, "林某某", null);
  const e2 = await ours(db, "陳某某", null);
  const w = await ours(db, "退選甲", null, "withdrawn");
  await task(db, e1);
  await task(db, e2);
  await task(db, e2, "other_origin"); // 不是這批來源的任務：不收
  await loadCouncil(db, roster);
  return { e1, e2, w };
}
const rows = async (db: PGlite) =>
  (await db.query<{ id: number; candidacy_status: string; withdrawn_after_filing: boolean | null }>(
    `SELECT id, candidacy_status, withdrawn_after_filing FROM politician_elections ORDER BY id`)).rows;
const tableExists = async (db: PGlite, t: string) =>
  (await db.query<{ n: number }>(`SELECT count(*)::int n FROM pg_tables WHERE tablename = $1`, [t])).rows[0].n === 1;
async function failsWith(db: PGlite, sql: string, needle: string) {
  const err = await assertRejects(() => db.exec(sql));
  assert(String((err as Error).message).includes(needle), `訊息應含「${needle}」：${(err as Error).message}`);
  await db.exec("ROLLBACK").catch(() => {});
}

Deno.test("條件成立：只改已登記沒號次的 extra，旗標寫 false、留快照與履歷、收任務、對帳歸零", async () => {
  const db = await buildDb();
  const { e1, e2, w } = await base(db);
  await db.exec(commit(SCRIPT));
  const r = await rows(db);
  for (const id of [e1, e2]) {
    const x = r.find((y) => y.id === id)!;
    assertEquals([x.candidacy_status, x.withdrawn_after_filing], ["withdrawn", false]);
  }
  assertEquals(r.filter((y) => y.candidacy_status === "filed").length, 2); // 有號次的兩位沒動
  assertEquals(r.find((y) => y.id === w)!.withdrawn_after_filing, null);   // 本來就退選的沒動
  const snap = await db.query<{ id: number; candidacy_status: string }>(`SELECT id, candidacy_status FROM politician_elections_no_cand_snapshot_20261103 ORDER BY id`);
  assertEquals(snap.rows.map((x) => [x.id, x.candidacy_status]), [[e1, "filed"], [e2, "filed"]]);
  const h = await db.query<{ n: number }>(`SELECT count(*)::int n FROM edit_history WHERE agent_name = 'no-cand-cleanup-2026-11' AND contribution_id IS NULL`);
  assertEquals(h.rows[0].n, 4);
  const t = await db.query<{ status: string; o: string }>(`SELECT status, target->>'origin' o FROM contribution_tasks ORDER BY o, status`);
  assertEquals(t.rows.map((x) => `${x.o}:${x.status}`), ["cec_roster_extra:closed", "cec_roster_extra:closed", "other_origin:open"]);
  const d = await db.query<{ n: number }>(`SELECT count(*)::int n FROM cec_roster_diff()`);
  assertEquals(d.rows[0].n, 0);
});

Deno.test("預設是演練：結尾 ROLLBACK，什麼都不留", async () => {
  const db = await buildDb();
  await base(db);
  await db.exec(SCRIPT);
  assertEquals((await rows(db)).filter((y) => y.candidacy_status === "filed").length, 4);
  assertEquals(await tableExists(db, "politician_elections_no_cand_snapshot_20261103"), false);
  assertEquals((await db.query(`SELECT 1 FROM edit_history`)).rows.length, 0);
});

Deno.test("條件不成立整段退回：缺人、帶號次的 extra、已登記沒號次卻不是 extra", async () => {
  const cases: [string, (db: PGlite) => Promise<void>, string][] = [
    ["缺人", async (db) => { await loadCouncil(db, [{ name: "王小明", no: 1 }, { name: "李大華", no: 2 }, { name: "吳九", no: 7 }]); }, "missing=1"],
    ["帶號次的 extra", async (db) => { await ours(db, "趙某某", 9); }, "帶號次的 extra=1"],
    ["已登記沒號次但單位沒抓（不是 extra）", async (db) => { await ours(db, "高雄人", null, "filed", "高雄市", "第01選舉區"); }, "不是 extra"],
  ];
  for (const [name, tweak, needle] of cases) {
    const db = await buildDb();
    await base(db);
    await tweak(db);
    await failsWith(db, commit(SCRIPT), needle);
    const left = (await rows(db)).filter((y) => y.candidacy_status === "withdrawn").length;
    assertEquals(left, 1, `${name}：不該有任何人被改（只有原本退選的那位）`);
    assertEquals(await tableExists(db, "politician_elections_no_cand_snapshot_20261103"), false, name);
  }
});

Deno.test("還原驗證：拿掉 missing 檢查，缺人的案例就不再被條件檢查擋下", async () => {
  const db = await buildDb();
  await base(db, [{ name: "王小明", no: 1 }, { name: "李大華", no: 2 }, { name: "吳九", no: 7 }]);
  const weak = commit(mutate(SCRIPT, "IF v_missing <> 0 THEN", "IF false THEN"));
  // 缺人時帶號次人數也對不上名單，這條還是會擋；但 missing 那一項訊息不該再出現
  const err = await assertRejects(() => db.exec(weak));
  const msg = String((err as Error).message);
  assert(!msg.includes("missing="), msg);
  await db.exec("ROLLBACK").catch(() => {});
});

Deno.test("還原腳本：狀態與任務改回去；之後被別人改過的不蓋", async () => {
  const db = await buildDb();
  const { e1, e2 } = await base(db);
  await db.exec(commit(SCRIPT));
  await db.query(`UPDATE politician_elections SET candidacy_status = 'declared' WHERE id = $1`, [e2]); // 之後有人改過
  await db.exec(commit(RESTORE));
  const r = await rows(db);
  const x = r.find((y) => y.id === e1)!;
  assertEquals([x.candidacy_status, x.withdrawn_after_filing], ["filed", null]);
  assertEquals(r.find((y) => y.id === e2)!.candidacy_status, "declared");
  const t = await db.query<{ status: string }>(`SELECT status FROM contribution_tasks WHERE target->>'origin' = 'cec_roster_extra'`);
  assertEquals(t.rows.map((y) => y.status), ["open", "open"]);
  const rev = await db.query<{ n: number }>(`SELECT count(*)::int n FROM edit_history WHERE agent_name = 'no-cand-cleanup-2026-11' AND reverted_at IS NOT NULL`);
  assertEquals(rev.rows[0].n, 2); // e1 的兩列
});
