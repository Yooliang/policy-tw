/**
 * 名單時程的日期搬成里程碑（2026-10-08，派工時間窗 P2，docs/PLAN-task-activation.md；migration 20261008140000_roster_milestones.sql）。
 *
 * candidacy_list_published() 改讀 election_milestones_all 的 list_published；roster_check_scope 剩下三個日期（資格審查完成日、抽號次日、直轄市長名單公告日）
 * 搬成里程碑（qualification_review、draw、list_published＋election_type＝直轄市長）；單一真相是里程碑表，scope 的五個日期欄由觸發器衍生（做法照 #446）。
 * 今天輸出必須逐件不變。只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）。
 *
 *   A. 文字層：candidacy_list_published 新定義＝前一版加一處替換；activity_health 新視圖＝現行版只換 milestone_scope_drift 一段；這支只動這幾樣（不碰任何臂、總表、seed、規則）
 *   B. PGlite（行為層）：P0／P1 跑真的，roster_check_scope 灌正式庫現況（2026 七列、五個日期都有值），再跑這支 migration
 *        1. 回填：三個新日期搬成里程碑（draw 7、qualification_review 7、直轄市長 list_published 1），scope 七列一個欄位都沒變
 *        2. candidacy_list_published 與舊函式在（選舉×職位×日期）上逐格相同；關鍵日 11-16／11-17；直轄市長的列不外漏到縣市長；整場的列職位相同的優先
 *        3. 衍生：改里程碑 → scope 欄位跟著變；直接寫 scope 的日期欄被擋；新增清查範圍從里程碑填、沒有里程碑就失敗；刪還在用的里程碑被擋
 *        4. 假時鐘 09-04 登記截止／10-16 資格審查／10-23 抽籤／11-12 直轄市長／11-17 名單公告：roster_schedule_text 與 candidacy_list_published 的開關
 *        5. activity_health：正常是空的；觸發器被停掉時五個欄位各自都偵測得到
 *        6. 每條守門都做還原驗證：把 migration 改壞一處（精確改一處，改不到就失敗），對應的守門必須紅；migration 自己的檢查也要擋得住
 *
 * 正式庫快照版的「逐件不變」見 scripts/roster-milestones-parity.ts（不進 CI：要唯讀快照；PR 說明附結果）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { buildArmsDb, fnText, latestFn, migrationNames, mutate, readMig, type Scope } from "./arms-pglite.ts";

export const MIG_NAME = "20261008140000_roster_milestones.sql";
const MIG = await readMig(MIG_NAME);
const BULLETIN = await readMig("20261008113000_bulletin_watch.sql");
const count = (s: string, sub: string) => s.split(sub).length - 1;

// ============================================================
// A. 文字層
// ============================================================
const PREV_FN = await latestFn("candidacy_list_published", MIG_NAME);
const NEW_FN = fnText(MIG, "candidacy_list_published");
const OLD_FRAG = `      OR EXISTS (SELECT 1 FROM roster_check_scope s
                  WHERE s.election_id = p_election_id AND s.election_type = p_election_type
                    AND s.list_announced_on IS NOT NULL AND s.list_announced_on <= p_on)`;
const NEW_FRAG = `      OR COALESCE((SELECT m.on_date <= p_on
                     FROM election_milestones_all m
                    WHERE m.election_id = p_election_id AND m.kind = 'list_published'
                      AND (m.election_type = p_election_type OR m.election_type IS NULL)
                    ORDER BY (m.election_type IS NULL)
                    LIMIT 1), false)`;
const isMechanicalFn = (fn: string) => {
  try {
    return mutate(fn, NEW_FRAG, OLD_FRAG) === PREV_FN;
  } catch {
    return false;
  }
};

const viewText = (sql: string) => sql.slice(sql.indexOf("CREATE OR REPLACE VIEW activity_health AS"), sql.indexOf(";\nCOMMENT ON VIEW activity_health"));
const driftBlock = (v: string) => v.slice(v.indexOf("  SELECT 'milestone_scope_drift'"), v.indexOf("  UNION ALL\n  SELECT 'arm_without_rule'"));
const PREV_VIEW = viewText(BULLETIN);
const NEW_VIEW = viewText(MIG);
const isMechanicalView = (v: string) => {
  try {
    return mutate(v, driftBlock(v), driftBlock(PREV_VIEW)) === PREV_VIEW;
  } catch {
    return false;
  }
};

Deno.test("A1 前一版是對的：candidacy_list_published 緊接在這支之前的定義是 20261006034500（與正式庫一字不差），之後沒有別人再改；activity_health 的現行版是 20261008113000", async () => {
  const defining = async (needle: string) => {
    const out: string[] = [];
    for (const n of await migrationNames()) if ((await readMig(n)).includes(needle)) out.push(n);
    return out;
  };
  const fn = await defining("CREATE OR REPLACE FUNCTION candidacy_list_published(");
  assertEquals(fn, ["20261006034500_candidacy_status.sql", MIG_NAME], "前一版變了或之後又有人改：要以最新那版為底重做機械式替換");
  const view = await defining("CREATE OR REPLACE VIEW activity_health AS");
  assertEquals(view.slice(-2), ["20261008113000_bulletin_watch.sql", MIG_NAME], "activity_health 的前一版應該是公報偵測那版；有人在中間改了，要以那一版為底重做");
});

Deno.test("A2 candidacy_list_published 新定義＝前一版加一處機械式替換（第二個 EXISTS 換成讀里程碑視圖），其餘一字不差", () => {
  assert(isMechanicalFn(NEW_FN));
  assertEquals(count(PREV_FN, OLD_FRAG), 1);
  assertEquals(count(NEW_FN, "roster_check_scope"), 0, "不再讀 roster_check_scope");
  assertEquals(count(NEW_FN, "election_milestones_all"), 1);
  // 簽名、回傳型別、語言、穩定度不動；投票日已到那一支也不動
  assertEquals(NEW_FN.split("\n").slice(0, 2).join("\n"), PREV_FN.split("\n").slice(0, 2).join("\n"));
  assert(NEW_FN.includes("SELECT EXISTS (SELECT 1 FROM elections e WHERE e.id = p_election_id AND e.election_date <= p_on)"));
  // 找里程碑：kind 限定 list_published、職位相同優先於整場
  assert(NEW_FN.includes("m.kind = 'list_published'") && NEW_FN.includes("ORDER BY (m.election_type IS NULL)"));
});

Deno.test("A3 這支只動名單時程這一組：不重寫任何臂／總表／seed／raw、不碰規則的資料、不改別的表的結構", () => {
  const code = MIG.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const defined = [...code.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+)\(/g)].map((m) => m[1]).sort();
  assertEquals(defined, ["candidacy_list_published", "roster_scope_derive_dates", "roster_scope_milestone_date", "roster_scope_sync_from_milestones"]);
  assert(!/FUNCTION (contribution_auto_tasks|seed_auto_task_queue)/.test(code), "不動任何臂、總表、seed");
  assert(!/(INSERT INTO|UPDATE|DELETE FROM) activity_(rules|overrides)/i.test(code), "不新增、不修改規則與覆寫（只放寬 CHECK 的用字）");
  assert(!/(UPDATE|DELETE FROM) election_milestones/i.test(code), "里程碑只新增（回填）");
  assertEquals([...code.matchAll(/ALTER TABLE ([a-z_]+)/g)].map((m) => m[1]).sort(), ["activity_rules", "activity_rules", "activity_rules", "activity_rules", "election_milestones", "election_milestones", "election_milestones", "election_milestones"]);
  assert(!/CREATE TABLE|DROP TABLE|DROP FUNCTION|DROP VIEW|TRUNCATE/i.test(code));
  // 新增的里程碑列：五種，全是 official，status 依日期
  assertEquals(count(code, "INSERT INTO election_milestones"), 5);
  assert(count(code, "'official'") >= 5);
  // 兩個 NOT NULL 欄、五個日期欄的 CHECK 放寬
  assert(code.includes("'qualification_review'") && code.includes("'直轄市長'"));
});

/** 換掉的那一段（milestone_scope_drift）必須五個日期欄都比 */
const driftComplete = (v: string) => {
  const d = driftBlock(v);
  return ["registration_close", "list_published", "qualification_review", "draw"].every((k) => d.includes(`'${k}'`)) &&
    ["registration_closed_on", "list_announced_on", "qualification_review_by", "ballot_draw_on", "municipal_mayor_list_on"].every((c) => d.includes(`s.${c} IS DISTINCT FROM roster_scope_milestone_date(`)) &&
    d.includes("'直轄市長', false");
};

Deno.test("A4 activity_health 新視圖＝現行版（20261008113000）只換 milestone_scope_drift 那一段；擴到五個日期欄", () => {
  assert(isMechanicalView(NEW_VIEW));
  assert(driftComplete(NEW_VIEW), "drift 要比五個日期欄，直轄市長名單不退回整場的名單公告日");
  // 其餘各段（含公報偵測加的那一段）一字不動
  assert(NEW_VIEW.includes("'bulletin_milestone_missing'") && NEW_VIEW.includes("'arm_without_rule'") && NEW_VIEW.includes("'clock_overridden'"));
});

Deno.test("A5 還原驗證（文字層）：動不該動的字、把舊來源放回去、少比一個欄位，A2／A4 都要紅", () => {
  assert(!isMechanicalFn(mutate(NEW_FN, "m.on_date <= p_on", "m.on_date < p_on")), "偷改比較");
  assert(!isMechanicalFn(mutate(NEW_FN, "e.election_date <= p_on", "e.election_date < p_on")), "偷改投票日那一支");
  assert(!isMechanicalFn(mutate(NEW_FN, NEW_FRAG, OLD_FRAG.replace("s.list_announced_on <= p_on)", "s.list_announced_on < p_on)"))), "舊來源放回去又改了一點");
  assert(!isMechanicalFn(PREV_FN), "前一版本身不是「新的」");
  assert(!driftComplete(mutate(NEW_VIEW, "OR s.ballot_draw_on IS DISTINCT FROM", "OR s.ballot_draw_on IS NOT DISTINCT FROM")), "把漂移檢查改壞");
  assert(!driftComplete(mutate(NEW_VIEW, "'直轄市長', false)", "'直轄市長', true)")), "直轄市長名單退回整場");
  assert(!isMechanicalView(mutate(NEW_VIEW, "SELECT 'arm_without_rule', a.arm,", "SELECT 'arm_without_rule2', a.arm,")), "偷改別的段");
  assert(!driftComplete(PREV_VIEW), "前一版本身不是「新的」（drift 只比兩個日期）");
});

// ============================================================
// B. PGlite（行為層）
// ============================================================
const TYPES7 = ["村里長", "直轄市山地原住民區民代表", "直轄市山地原住民區長", "縣市議員", "縣市長", "鄉鎮市民代表", "鄉鎮市長"];
/** 正式庫現況（2026-10-08 唯讀）：2026 七列、五個日期都有值 */
const scope7 = (): Scope[] =>
  TYPES7.map((t) => ({
    election_id: 2026, election_type: t, registration_closed_on: "2026-09-04", list_announced_on: "2026-11-17",
    qualification_review_by: "2026-10-16", ballot_draw_on: "2026-10-23", municipal_mayor_list_on: "2026-11-12",
  }));

const PRE_SQL = `
ALTER TABLE elections ADD COLUMN bulletin_dir text;
${await latestFn("candidacy_list_published", MIG_NAME)}
-- 舊版的複本：新舊逐格比對用
${(await latestFn("candidacy_list_published", MIG_NAME)).replace("FUNCTION candidacy_list_published(", "FUNCTION legacy_candidacy_list_published(")}
${await latestFn("roster_schedule_text")}
`;

type Db = PGlite;
const rows = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T> => (await rows<T>(db, sql, params))[0];
const num = async (db: Db, sql: string) => (await one<{ n: number }>(db, sql)).n;
const clock = (db: Db, day: string) => db.exec(`SET app.activity_today = '${day}'`);
const fails = async (db: Db, sql: string, pattern?: RegExp): Promise<boolean> => {
  await db.exec("SAVEPOINT s");
  try {
    await db.exec(sql);
    await db.exec("ROLLBACK TO s");
    return false;
  } catch (e) {
    await db.exec("ROLLBACK TO s");
    return pattern ? pattern.test(String((e as Error).message)) : true;
  }
};

async function build(o: { mutate?: (s: string) => string; scope?: Scope[]; skipMig?: boolean; before?: string } = {}): Promise<Db> {
  const db = await buildArmsDb({ scope: o.scope ?? scope7(), afterP1Sql: PRE_SQL });
  if (o.before) await db.exec(o.before);
  if (!o.skipMig) {
    await db.exec("SET app.activity_today = '2026-10-08'");
    await db.exec((o.mutate ?? ((s) => s))(MIG));
    await db.exec("RESET app.activity_today");
  }
  return db;
}

const scopeJson = async (db: Db) => (await one<{ j: string }>(db, `SELECT jsonb_agg(to_jsonb(s) ORDER BY election_id, election_type)::text AS j FROM roster_check_scope s`)).j;
const SCOPE_BEFORE = await (async () => {
  const db = await build({ skipMig: true });
  const j = await scopeJson(db);
  await db.close();
  return j;
})();

type Verdicts = Record<string, boolean>;
async function guard(out: Verdicts, db: Db, name: string, f: () => Promise<boolean>) {
  await db.exec("BEGIN");
  try {
    out[name] = await f();
  } catch (_e) {
    out[name] = false;
  } finally {
    try {
      await db.exec("ROLLBACK");
    } catch { /* 已經回滾 */ }
  }
}

const sched = (db: Db, day: string, type = "縣市長") =>
  one<{ t: string }>(db, `SELECT roster_schedule_text(registration_closed_on, list_announced_on, municipal_mayor_list_on, qualification_review_by, ballot_draw_on, DATE '${day}') AS t
                           FROM roster_check_scope WHERE election_id = 2026 AND election_type = '${type}'`).then((r) => r.t);
const E2028 = `INSERT INTO elections (id, election_key, election_date, election_reason, election_types) VALUES (2028, '2028-01-15_national', '2028-01-15', 'regular', ARRAY['總統副總統', '立法委員'])`;
const ms = (kind: string, type: string | null, day: string, eid = 2026) =>
  `INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status) VALUES (${eid}, '${kind}', ${type === null ? "NULL" : `'${type}'`}, '${day}', 'official', 'announced')`;

async function runSuite(db: Db): Promise<Verdicts> {
  const v: Verdicts = {};
  const g = (name: string, f: () => Promise<boolean>) => guard(v, db, name, f);

  // ---- 1. 回填 ----
  await g("backfill_three_new_dates", async () => {
    const per = await rows<{ kind: string; n: number }>(db, `SELECT kind, count(*)::int AS n FROM election_milestones WHERE election_type IS DISTINCT FROM '直轄市長' GROUP BY kind ORDER BY kind`);
    const byKind = Object.fromEntries(per.map((r) => [r.kind, r.n]));
    const mayor = await rows<{ election_id: number; on_date: string; basis: string; status: string }>(db,
      `SELECT election_id, to_char(on_date, 'YYYY-MM-DD') AS on_date, basis, status FROM election_milestones WHERE kind = 'list_published' AND election_type = '直轄市長'`);
    const draw = await rows<{ t: string; d: string; status: string }>(db, `SELECT election_type AS t, to_char(on_date, 'YYYY-MM-DD') AS d, status FROM election_milestones WHERE kind = 'draw' ORDER BY 1`);
    const rev = await rows<{ d: string; status: string }>(db, `SELECT to_char(on_date, 'YYYY-MM-DD') AS d, status FROM election_milestones WHERE kind = 'qualification_review'`);
    return byKind.draw === 7 && byKind.qualification_review === 7 && byKind.registration_close === 7 && byKind.list_published === 7 &&
      mayor.length === 1 && mayor[0].election_id === 2026 && mayor[0].on_date === "2026-11-12" && mayor[0].basis === "official" && mayor[0].status === "announced" &&
      draw.length === 7 && draw.every((r) => r.d === "2026-10-23" && r.status === "announced") &&
      rev.length === 7 && rev.every((r) => r.d === "2026-10-16" && r.status === "announced");
  });
  await g("scope_columns_unchanged", async () => (await scopeJson(db)) === SCOPE_BEFORE);
  await g("health_empty", async () => (await rows(db, `SELECT * FROM activity_health`)).length === 0);

  // ---- 2. candidacy_list_published ----
  await g("candidacy_matches_legacy_on_grid", async () => {
    // 選舉×職位×日期：2026 八月到年底每一天；各屆投票日前後；2022～2028 每 30 天抽一格
    const bad = await num(db, `
      WITH days AS (
        SELECT d::date AS d FROM generate_series(DATE '2026-08-01', DATE '2026-12-31', '1 day') d
        UNION SELECT d::date FROM generate_series(DATE '2022-11-24', DATE '2022-11-28', '1 day') d
        UNION SELECT d::date FROM generate_series(DATE '2022-12-16', DATE '2022-12-20', '1 day') d
        UNION SELECT d::date FROM generate_series(DATE '2024-01-11', DATE '2024-01-15', '1 day') d
        UNION SELECT d::date FROM generate_series(DATE '2022-01-01', DATE '2028-12-31', '30 days') d
      ), els(id) AS (VALUES (4), (2022), (2024), (2026), (2099)),
      types(t) AS (VALUES ('總統副總統'), ('立法委員'), ('縣市長'), ('縣市議員'), ('鄉鎮市長'), ('直轄市山地原住民區長'), ('鄉鎮市民代表'), ('直轄市山地原住民區民代表'), ('村里長'), (NULL), ('不存在的職位'))
      SELECT count(*)::int AS n FROM days CROSS JOIN els CROSS JOIN types
       WHERE candidacy_list_published(els.id, types.t, days.d) IS DISTINCT FROM legacy_candidacy_list_published(els.id, types.t, days.d)`);
    const some = await num(db, `SELECT count(*)::int AS n FROM generate_series(DATE '2026-11-01', DATE '2026-11-30', '1 day') d WHERE candidacy_list_published(2026, '縣市長', d::date)`);
    return bad === 0 && some > 0 && some < 30;
  });
  await g("candidacy_key_days", async () => {
    const f = async (eid: number, type: string | null, day: string) => (await one<{ b: boolean }>(db, `SELECT candidacy_list_published($1, $2, $3) AS b`, [eid, type, day])).b;
    return !(await f(2026, "縣市長", "2026-11-16")) && (await f(2026, "縣市長", "2026-11-17")) &&
      !(await f(2026, "縣市議員", "2026-11-16")) && (await f(2026, "縣市議員", "2026-11-17")) &&
      !(await f(2026, "村里長", "2026-11-16")) && (await f(2026, "村里長", "2026-11-17")) &&
      // 直轄市長的 11-12 是細分職位的列：問「直轄市長」本身是 11-12 起，不外漏到縣市長（也不外漏到沒有清查範圍的職位）
      !(await f(2026, "直轄市長", "2026-11-11")) && (await f(2026, "直轄市長", "2026-11-12")) &&
      !(await f(2026, "縣市長", "2026-11-12")) && !(await f(2026, "縣市長", "2026-11-13")) && !(await f(2026, "不存在的職位", "2026-11-12")) &&
      // 沒有清查範圍的職位／選舉：只看投票日
      !(await f(2026, "不存在的職位", "2026-11-27")) && (await f(2026, "不存在的職位", "2026-11-28")) &&
      !(await f(2022, "縣市長", "2022-11-25")) && (await f(2022, "縣市長", "2022-11-26")) &&
      !(await f(4, "縣市長", "2022-12-17")) && (await f(4, "縣市長", "2022-12-18")) &&
      !(await f(2024, "立法委員", "2024-01-12")) && (await f(2024, "立法委員", "2024-01-13"));
  });
  await g("candidacy_whole_election_row_and_exact_wins", async () => {
    await db.exec(E2028);
    const f = async (type: string | null, day: string) => (await one<{ b: boolean }>(db, `SELECT candidacy_list_published(2028, $1, $2) AS b`, [type, day])).b;
    await db.exec(ms("list_published", null, "2027-12-20", 2028)); // 整場 12-20
    const whole = !(await f("縣市長", "2027-12-19")) && (await f("縣市長", "2027-12-20")) && (await f("立法委員", "2027-12-20")) && (await f(null, "2027-12-20"));
    await db.exec(ms("list_published", "縣市長", "2027-12-25", 2028)); // 縣市長另有一列 12-25：職位相同的優先（晚於整場，所以 12-20 不算）
    const exact = !(await f("縣市長", "2027-12-20")) && !(await f("縣市長", "2027-12-24")) && (await f("縣市長", "2027-12-25")) && (await f("立法委員", "2027-12-20"));
    return whole && exact;
  });

  // ---- 3. 衍生與守門 ----
  await g("derive_follows_milestone_changes", async () => {
    const col = (c: string, type = "縣市長") => one<{ d: string | null }>(db, `SELECT to_char(${c}, 'YYYY-MM-DD') AS d FROM roster_check_scope WHERE election_id = 2026 AND election_type = '${type}'`).then((r) => r.d);
    await db.exec(`UPDATE election_milestones SET on_date = '2026-10-30' WHERE kind = 'draw' AND election_type = '縣市長'`);
    const drawMoved = (await col("ballot_draw_on")) === "2026-10-30" && (await col("ballot_draw_on", "縣市議員")) === "2026-10-23";
    await db.exec(`UPDATE election_milestones SET on_date = '2026-10-19' WHERE kind = 'qualification_review' AND election_type = '縣市長'`);
    const revMoved = (await col("qualification_review_by")) === "2026-10-19";
    await db.exec(`UPDATE election_milestones SET on_date = '2026-11-18' WHERE kind = 'list_published' AND election_type = '縣市長'`);
    const listMoved = (await col("list_announced_on")) === "2026-11-18" && (await col("list_announced_on", "村里長")) === "2026-11-17";
    await db.exec(`UPDATE election_milestones SET on_date = '2026-09-05' WHERE kind = 'registration_close' AND election_type = '縣市長'`);
    const regMoved = (await col("registration_closed_on")) === "2026-09-05";
    // 直轄市長名單：整場一列，七個清查範圍列一起變
    await db.exec(`UPDATE election_milestones SET on_date = '2026-11-13' WHERE kind = 'list_published' AND election_type = '直轄市長'`);
    const mayorMoved = (await num(db, `SELECT count(*)::int AS n FROM roster_check_scope WHERE municipal_mayor_list_on = DATE '2026-11-13'`)) === 7;
    // 刪掉細分職位的 draw：退回整場的 draw（沒有就 NULL）
    await db.exec(`DELETE FROM election_milestones WHERE kind = 'draw' AND election_type = '縣市長'`);
    const drawNull = (await col("ballot_draw_on")) === null;
    await db.exec(ms("draw", null, "2026-10-25"));
    const drawWhole = (await col("ballot_draw_on")) === "2026-10-25" && (await col("ballot_draw_on", "縣市議員")) === "2026-10-23";
    // 刪掉直轄市長的列：七列都回到 NULL
    await db.exec(`DELETE FROM election_milestones WHERE kind = 'list_published' AND election_type = '直轄市長'`);
    const mayorNull = (await num(db, `SELECT count(*)::int AS n FROM roster_check_scope WHERE municipal_mayor_list_on IS NULL`)) === 7;
    return drawMoved && revMoved && listMoved && regMoved && mayorMoved && drawNull && drawWhole && mayorNull;
  });
  await g("direct_writes_blocked", async () => {
    const blocked = [
      `UPDATE roster_check_scope SET ballot_draw_on = '2026-10-30' WHERE election_type = '縣市長'`,
      `UPDATE roster_check_scope SET qualification_review_by = '2026-10-17' WHERE election_type = '縣市長'`,
      `UPDATE roster_check_scope SET list_announced_on = '2026-11-18' WHERE election_type = '縣市長'`,
      `UPDATE roster_check_scope SET registration_closed_on = '2026-09-05' WHERE election_type = '縣市長'`,
      `UPDATE roster_check_scope SET municipal_mayor_list_on = '2026-11-13' WHERE election_type = '縣市長'`,
      `UPDATE roster_check_scope SET ballot_draw_on = NULL WHERE election_type = '縣市長'`, // 清空衍生欄也不行
      `UPDATE roster_check_scope SET municipal_mayor_list_on = NULL`,
      `INSERT INTO roster_check_scope (election_id, election_type, list_announced_on, registration_closed_on, ballot_draw_on) VALUES (2026, '不存在的職位', '2026-11-17', '2026-09-04', '2026-10-01')`,
    ];
    for (const sql of blocked) if (!(await fails(db, sql))) return false;
    // 寫成跟里程碑一樣的值、或改別的欄位都可以
    await db.exec(`UPDATE roster_check_scope SET ballot_draw_on = '2026-10-23', list_announced_on = '2026-11-17' WHERE election_type = '縣市長'`);
    await db.exec(`UPDATE roster_check_scope SET enabled = false, recheck_days = 3, regions = ARRAY['台北市'] WHERE election_type = '縣市長'`);
    const r = await one<{ en: boolean; rd: number; d: string }>(db, `SELECT enabled AS en, recheck_days AS rd, to_char(ballot_draw_on, 'YYYY-MM-DD') AS d FROM roster_check_scope WHERE election_type = '縣市長'`);
    return r.en === false && r.rd === 3 && r.d === "2026-10-23";
  });
  await g("new_scope_row_fills_from_milestones", async () => {
    await db.exec(E2028);
    // 沒有里程碑 → 失敗（NOT NULL 的意思不變：強迫先有日期）
    const noMs = await fails(db, `INSERT INTO roster_check_scope (election_id, election_type) VALUES (2028, '立法委員')`, /沒有登記截止日里程碑/);
    await db.exec(ms("registration_close", "立法委員", "2027-12-01", 2028));
    const onlyReg = await fails(db, `INSERT INTO roster_check_scope (election_id, election_type) VALUES (2028, '立法委員')`, /沒有名單公告日里程碑/);
    await db.exec(ms("list_published", null, "2028-01-05", 2028)); // 整場的名單公告日
    await db.exec(ms("draw", "立法委員", "2027-12-20", 2028));
    await db.exec(`INSERT INTO roster_check_scope (election_id, election_type) VALUES (2028, '立法委員')`);
    const r = await one<{ reg: string; list: string; draw: string; review: string | null; mayor: string | null }>(db,
      `SELECT to_char(registration_closed_on, 'YYYY-MM-DD') AS reg, to_char(list_announced_on, 'YYYY-MM-DD') AS list, to_char(ballot_draw_on, 'YYYY-MM-DD') AS draw,
              qualification_review_by::text AS review, municipal_mayor_list_on::text AS mayor FROM roster_check_scope WHERE election_id = 2028`);
    // 給了日期而且跟里程碑一致也行；不一致就擋
    await db.exec(`INSERT INTO roster_check_scope (election_id, election_type, registration_closed_on, list_announced_on) VALUES (2028, '總統副總統', NULL, NULL)`).catch(() => {});
    return noMs && onlyReg && r.reg === "2027-12-01" && r.list === "2028-01-05" && r.draw === "2027-12-20" && r.review === null && r.mayor === null;
  });
  await g("deleting_a_milestone_still_in_use_is_blocked", async () => {
    const reg = await fails(db, `DELETE FROM election_milestones WHERE kind = 'registration_close' AND election_type = '縣市長'`, /登記截止日里程碑/);
    const list = await fails(db, `DELETE FROM election_milestones WHERE kind = 'list_published' AND election_type = '縣市長'`, /名單公告日里程碑/);
    // 清查範圍列先刪掉，里程碑就能刪
    await db.exec(`DELETE FROM roster_check_scope WHERE election_type = '縣市長'`);
    await db.exec(`DELETE FROM election_milestones WHERE kind IN ('registration_close', 'list_published') AND election_type = '縣市長'`);
    // 可為 NULL 的三個日期：刪里程碑只是回到 NULL，不擋
    await db.exec(`DELETE FROM election_milestones WHERE kind = 'qualification_review'`);
    const rev = await num(db, `SELECT count(*)::int AS n FROM roster_check_scope WHERE qualification_review_by IS NULL`);
    return reg && list && rev === 6;
  });

  // ---- 4. 假時鐘：關鍵日 ----
  await g("key_days_schedule_text", async () => {
    const closed = "登記已於 2026-09-04 截止，但官方候選人名單要到 2026-11-17 才公告";
    const t = async (day: string) => await sched(db, day);
    // 09-04 登記截止當天、10-16 資格審查完成當天（含）、10-23 抽號次當天（含）、11-12 直轄市長名單當天（含）、11-17 名單公告當天
    return (await t("2026-09-04")) === `${closed}（直轄市長是 11-12），資格審查 10-16 前完成、10-23 抽號次。` &&
      (await t("2026-10-16")) === `${closed}（直轄市長是 11-12），資格審查 10-16 前完成、10-23 抽號次。` &&
      (await t("2026-10-17")) === `${closed}（直轄市長是 11-12），10-23 抽號次。` &&
      (await t("2026-10-23")) === `${closed}（直轄市長是 11-12），10-23 抽號次。` &&
      (await t("2026-10-24")) === `${closed}（直轄市長是 11-12）。` &&
      (await t("2026-11-12")) === `${closed}（直轄市長是 11-12）。` &&
      (await t("2026-11-13")) === `${closed}。` &&
      (await t("2026-11-17")) === `${closed}。`;
  });
  await g("key_days_follow_a_moved_milestone", async () => {
    // 抽籤改到 10-30、直轄市長名單改到 11-14：說明跟著變（單一真相在里程碑）
    await db.exec(`UPDATE election_milestones SET on_date = '2026-10-30' WHERE kind = 'draw' AND election_type = '縣市長'`);
    await db.exec(`UPDATE election_milestones SET on_date = '2026-11-14' WHERE kind = 'list_published' AND election_type = '直轄市長'`);
    const closed = "登記已於 2026-09-04 截止，但官方候選人名單要到 2026-11-17 才公告";
    return (await sched(db, "2026-10-24")) === `${closed}（直轄市長是 11-14），10-30 抽號次。` &&
      (await sched(db, "2026-10-31")) === `${closed}（直轄市長是 11-14）。` &&
      (await sched(db, "2026-11-14")) === `${closed}（直轄市長是 11-14）。` &&
      (await sched(db, "2026-11-15")) === `${closed}。` &&
      // 縣市議員的抽籤日沒動（10-23 已過），只有全選舉共用的直轄市長名單日跟著動
      (await sched(db, "2026-10-24", "縣市議員")) === `${closed}（直轄市長是 11-14）。`;
  });
  await g("list_published_flips_on_key_days", async () => {
    const f = async (day: string) => (await one<{ b: boolean }>(db, `SELECT candidacy_list_published(2026, '縣市長', DATE '${day}') AS b`)).b;
    const sfx = [await f("2026-09-04"), await f("2026-10-16"), await f("2026-10-23"), await f("2026-11-12"), await f("2026-11-16"), await f("2026-11-17"), await f("2026-11-28"), await f("2026-11-29")];
    return JSON.stringify(sfx) === JSON.stringify([false, false, false, false, false, true, true, true]);
  });

  // ---- 5. 健康檢查 ----
  await g("health_detects_each_derived_column", async () => {
    await db.exec(`ALTER TABLE roster_check_scope DISABLE TRIGGER trg_roster_scope_derive_dates`);
    const cols = ["registration_closed_on", "list_announced_on", "qualification_review_by", "ballot_draw_on", "municipal_mayor_list_on"];
    const hits: boolean[] = [];
    for (const c of cols) {
      await db.exec("SAVEPOINT h");
      await db.exec(`UPDATE roster_check_scope SET ${c} = DATE '2030-01-01' WHERE election_type = '縣市議員'`);
      const h = await rows<{ subject: string }>(db, `SELECT subject FROM activity_health WHERE check_name = 'milestone_scope_drift'`);
      hits.push(h.length === 1 && h[0].subject === "2026 / 縣市議員");
      await db.exec("ROLLBACK TO h");
    }
    // 偏離回來之後健康檢查又是空的
    const clean = (await rows(db, `SELECT * FROM activity_health`)).length === 0;
    return hits.every((x) => x) && clean;
  });

  // ---- 6. 新字彙進得了規則 ----
  await g("new_vocabulary_accepted", async () => {
    const okKind = !(await fails(db, ms("qualification_review", "縣市議員", "2026-10-01", 2022)));
    const okType = !(await fails(db, ms("list_published", "直轄市長", "2026-10-01", 2022)));
    const badKind = await fails(db, ms("not_a_kind", null, "2026-10-01", 2022));
    const badType = await fails(db, ms("list_published", "不存在的職位", "2026-10-01", 2022));
    await db.exec(`INSERT INTO activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, note) VALUES ('test_activity', 'event', 'qualification_review', 1, 'draw', 0, 't')`);
    const open = async (day: string) => (await rows(db, `SELECT * FROM activity_open('test_activity', 2026, '縣市長', DATE '${day}')`)).length;
    // 資格審查 10-16 +1＝10-17 起、抽號次 10-23 止
    const win = (await open("2026-10-16")) === 0 && (await open("2026-10-17")) === 1 && (await open("2026-10-23")) === 1 && (await open("2026-10-24")) === 0;
    return okKind && okType && badKind && badType && win;
  });

  // ---- 7. 重跑 ----
  await g("rerunnable", async () => {
    const before = await num(db, `SELECT count(*)::int AS n FROM election_milestones`);
    const sj = await scopeJson(db);
    await db.exec(MIG);
    return before === (await num(db, `SELECT count(*)::int AS n FROM election_milestones`)) && sj === (await scopeJson(db)) &&
      (await rows(db, `SELECT * FROM activity_health`)).length === 0;
  });
  return v;
}

const ALL_GUARDS = [
  "backfill_three_new_dates", "scope_columns_unchanged", "health_empty", "candidacy_matches_legacy_on_grid", "candidacy_key_days",
  "candidacy_whole_election_row_and_exact_wins", "derive_follows_milestone_changes", "direct_writes_blocked", "new_scope_row_fills_from_milestones",
  "deleting_a_milestone_still_in_use_is_blocked", "key_days_schedule_text", "key_days_follow_a_moved_milestone", "list_published_flips_on_key_days",
  "health_detects_each_derived_column", "new_vocabulary_accepted", "rerunnable",
];

Deno.test("B1 這支 migration 在 PGlite 上整支跑得動；全部守門都綠（回填、舊新逐格相同、衍生、直接寫入被擋、關鍵日、健康檢查、新字彙、重跑）", async () => {
  const db = await build();
  const v = await runSuite(db);
  const red = ALL_GUARDS.filter((g) => v[g] !== true);
  assertEquals(red, [], `這些守門是紅的：${red.join("、")}`);
  assertEquals(Object.keys(v).sort(), [...ALL_GUARDS].sort(), "守門清單與實際跑的要一致");
  await db.close();
});

Deno.test("B2 migration 擋住對不上的資料：已有的里程碑跟 scope 不一致、直轄市長名單日在同一場選舉的幾列不一致，都整支失敗（不替人決定誰對）", async () => {
  // P0 回填的里程碑被人改過：scope 說 11-17、里程碑說 11-16
  let failed = false;
  try {
    const db = await build({ before: `UPDATE election_milestones SET on_date = '2026-11-16' WHERE kind = 'list_published' AND election_type = '縣市長'` });
    await db.close();
  } catch (e) {
    failed = /對不上/.test((e as Error).message);
  }
  assert(failed, "里程碑與 scope 不一致時 migration 要失敗");
  failed = false;
  try {
    const s = scope7();
    s[0].municipal_mayor_list_on = "2026-11-13";
    const db = await build({ scope: s });
    await db.close();
  } catch (e) {
    failed = /不一致/.test((e as Error).message);
  }
  assert(failed, "同一場選舉直轄市長名單日不一致時 migration 要失敗");
  failed = false;
  try {
    const s = scope7();
    s[0].municipal_mayor_list_on = null as unknown as string;
    const db = await build({ scope: s });
    await db.close();
  } catch (e) {
    failed = /不一致/.test((e as Error).message);
  }
  assert(failed, "有的列有直轄市長名單日、有的沒有，也不能搬");
});

Deno.test("B3 舊欄位是 NULL 的選舉（沒有資格審查、抽號次、直轄市長名單）也搬得動：不建那幾種里程碑，scope 欄位維持 NULL", async () => {
  const s = scope7().map((r) => ({ ...r, qualification_review_by: null, ballot_draw_on: null, municipal_mayor_list_on: null }) as unknown as Scope);
  const db = await build({ scope: s });
  assertEquals(await num(db, `SELECT count(*)::int AS n FROM election_milestones WHERE kind IN ('draw', 'qualification_review') OR election_type = '直轄市長'`), 0);
  assertEquals(await num(db, `SELECT count(*)::int AS n FROM roster_check_scope WHERE ballot_draw_on IS NOT NULL OR qualification_review_by IS NOT NULL OR municipal_mayor_list_on IS NOT NULL`), 0);
  assertEquals((await rows(db, `SELECT * FROM activity_health`)).length, 0);
  await db.close();
});

// ---- 還原驗證：migration 文字改壞一處（精確改一處），對應的守門必須紅；有 migration 自己的檢查擋住的，要「整支失敗」 ----
const TRIG_DERIVE = `DROP TRIGGER IF EXISTS trg_roster_scope_derive_dates ON roster_check_scope;
CREATE TRIGGER trg_roster_scope_derive_dates BEFORE INSERT OR UPDATE ON roster_check_scope
  FOR EACH ROW EXECUTE FUNCTION roster_scope_derive_dates();`;
const TRIG_SYNC = `DROP TRIGGER IF EXISTS trg_election_milestones_roster_scope_sync ON election_milestones;
CREATE TRIGGER trg_election_milestones_roster_scope_sync AFTER INSERT OR UPDATE OR DELETE ON election_milestones
  FOR EACH ROW EXECUTE FUNCTION roster_scope_sync_from_milestones();`;
const MUTATIONS: { name: string; breaks: string[]; edit: (sql: string) => string; buildFails?: boolean }[] = [
  { name: "名單公告日比較 <= 改成 <（公告當天還說沒公告）", breaks: ["candidacy_matches_legacy_on_grid", "candidacy_key_days", "list_published_flips_on_key_days", "candidacy_whole_election_row_and_exact_wins"],
    edit: (s) => mutate(s, "m.on_date <= p_on", "m.on_date < p_on") },
  { name: "不退回整場的列", breaks: ["candidacy_whole_election_row_and_exact_wins"],
    edit: (s) => mutate(s, "AND (m.election_type = p_election_type OR m.election_type IS NULL)\n                    ORDER BY", "AND m.election_type = p_election_type\n                    ORDER BY") },
  { name: "整場的列排在職位相同的前面", breaks: ["candidacy_whole_election_row_and_exact_wins"],
    edit: (s) => mutate(s, "ORDER BY (m.election_type IS NULL)\n                    LIMIT 1), false)", "ORDER BY (m.election_type IS NOT NULL)\n                    LIMIT 1), false)") },
  { name: "kind 不限 list_published（抽號次、登記截止也算名單公告）", breaks: ["candidacy_matches_legacy_on_grid", "candidacy_key_days", "list_published_flips_on_key_days"],
    edit: (s) => mutate(s, "AND m.kind = 'list_published'\n                      AND (m.election_type", "AND m.kind IN ('list_published', 'draw', 'registration_close')\n                      AND (m.election_type") },
  { name: "拿掉 BEFORE 觸發器（日期欄不再從里程碑算）", breaks: ["derive_follows_milestone_changes", "direct_writes_blocked", "new_scope_row_fills_from_milestones", "deleting_a_milestone_still_in_use_is_blocked", "health_detects_each_derived_column"],
    edit: (s) => mutate(s, TRIG_DERIVE, "") },
  { name: "拿掉 AFTER 觸發器（里程碑一變，scope 欄位不跟著變）", breaks: ["derive_follows_milestone_changes", "key_days_follow_a_moved_milestone", "deleting_a_milestone_still_in_use_is_blocked"],
    edit: (s) => mutate(s, TRIG_SYNC, "") },
  { name: "守門永遠放行（pg_trigger_depth() < 2 改成 false）：直接寫成別的值不再被擋", breaks: ["direct_writes_blocked"],
    edit: (s) => mutate(s, "IF pg_trigger_depth() < 2 THEN", "IF false THEN") },
  { name: "里程碑只改日期時不重算（早退條件寫反）", breaks: ["derive_follows_milestone_changes", "key_days_follow_a_moved_milestone"],
    edit: (s) => mutate(s, "OLD.on_date = NEW.on_date THEN", "true THEN") },
  { name: "直轄市長名單退回整場的名單公告日（p_whole 沒關）", breaks: ["new_scope_row_fills_from_milestones"], // 整場有名單公告日、沒有直轄市長列時，欄位會變成整場的名單公告日
    edit: (s) => mutate(s, "v_mayor  DATE := roster_scope_milestone_date(NEW.election_id, 'list_published', '直轄市長', false);", "v_mayor  DATE := roster_scope_milestone_date(NEW.election_id, 'list_published', '直轄市長', true);") },
  { name: "健康檢查漏比抽號次日", breaks: ["health_detects_each_derived_column"],
    edit: (s) => mutate(s, "      OR s.ballot_draw_on IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'draw', s.election_type)\n", "") },
  { name: "健康檢查漏比直轄市長名單日", breaks: ["health_detects_each_derived_column"],
    edit: (s) => mutate(s, "\n      OR s.municipal_mayor_list_on IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'list_published', '直轄市長', false)\n  UNION ALL\n  SELECT 'arm_without_rule'", "\n  UNION ALL\n  SELECT 'arm_without_rule'") },
  // migration 自己的檢查：回填漏了、字彙沒放行就整支失敗（寧可不上線）
  { name: "漏掉直轄市長的回填，migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(s, "INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status, note)\nSELECT DISTINCT s.election_id, 'list_published', '直轄市長', s.municipal_mayor_list_on,", "SELECT 1 WHERE false AND 'x' = 'x' UNION ALL\nSELECT DISTINCT s.election_id, 'list_published', '直轄市長', s.municipal_mayor_list_on,") },
  { name: "回填把直轄市長寫成整場（election_type 空），migration 自己的檢查要擋住", breaks: [], buildFails: true,
    edit: (s) => mutate(s, "SELECT DISTINCT s.election_id, 'list_published', '直轄市長', s.municipal_mayor_list_on,", "SELECT DISTINCT s.election_id, 'list_published', NULL, s.municipal_mayor_list_on,") },
  { name: "kind 的 CHECK 沒放行 qualification_review", breaks: [], buildFails: true,
    edit: (s) => mutate(s, "CHECK (kind IN ('announced', 'registration_open', 'registration_close', 'list_published', 'draw', 'qualification_review',\n                  'bulletin_published'", "CHECK (kind IN ('announced', 'registration_open', 'registration_close', 'list_published', 'draw',\n                  'bulletin_published'") },
  { name: "職位的 CHECK 沒放行直轄市長", breaks: [], buildFails: true,
    edit: (s) => mutate(s, "'縣市長', '直轄市長', '縣市議員', '鄉鎮市長',\n                                                    '直轄市山地原住民區長'", "'縣市長', '縣市議員', '鄉鎮市長',\n                                                    '直轄市山地原住民區長'") },
  { name: "規則的 from_kind 沒放行 qualification_review", breaks: ["new_vocabulary_accepted"],
    edit: (s) => mutate(s, "CHECK (from_kind IS NULL OR from_kind IN ('announced', 'registration_open', 'registration_close', 'list_published', 'draw', 'qualification_review',", "CHECK (from_kind IS NULL OR from_kind IN ('announced', 'registration_open', 'registration_close', 'list_published', 'draw',") },
];

for (const m of MUTATIONS) {
  Deno.test(`B4 還原驗證：${m.name} → ${m.buildFails ? "migration 本身要失敗" : m.breaks.join("、") + " 必須紅"}`, async () => {
    if (m.buildFails) {
      let failed = false;
      try {
        const db = await build({ mutate: m.edit });
        await db.close();
      } catch {
        failed = true;
      }
      assert(failed, `改壞了「${m.name}」，migration 卻照樣跑完（它自己的檢查沒擋住）`);
      return;
    }
    const db = await build({ mutate: m.edit });
    const v = await runSuite(db);
    const red = ALL_GUARDS.filter((g) => v[g] !== true).sort();
    for (const b of m.breaks) assert(red.includes(b), `改壞了「${m.name}」，守門 ${b} 卻沒紅（紅的：${red.join("、") || "無"}）`);
    await db.close();
  });
}
