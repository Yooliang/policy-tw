/**
 * 插隊改天級（migration 20261114020000_boost_days_level.sql，維護者 2026-11-14 拍板；網站請求依目標選舉階段分選前／選後，小良哥 #683）。
 *
 *   boost_seconds（/boost）5 年→30 天、manual_front_seconds（維護者建的）5 年→30 天；
 *   網站請求／公民提問：目標選舉投票日 ≥ 今天＝選前 100 天（visitor_front_pre_election_seconds），其餘（選後、沒有選舉）＝50 天（visitor_front_seconds）；
 *   既有佇列上的 boost_seconds 縮放（號次拉前的 20／25／30 年不縮；網站請求來源的 10 年依目標選舉階段）；
 *   號次拉前不再讀 visitor_front_seconds，改寫死原值。
 *
 *   A. 文字層：新值、四個讀 visitor_front_seconds 的函式只差登記的替換、號次函式只差一處、縮放規則
 *   B. PGlite：整支 migration 套用（設定、縮放、冪等）、visitor_front_seconds_for、號次值不動
 *   C. 排序：選前請求提前 100 天、選後 50 天、無選舉 50 天、/boost 30 天；跨屆次序
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261114020000_boost_days_level.sql";
const MIG = await readMig(MIG_NAME);
const DAY = 86400;

Deno.test("A1 設定新值與預設值：/boost 30 天、維護者建的 30 天、網站請求選後 50 天、選前 100 天；舊值記在 note", () => {
  assert(MIG.includes("ALTER COLUMN boost_seconds         SET DEFAULT 2592000"));
  assert(MIG.includes("ALTER COLUMN manual_front_seconds  SET DEFAULT 2592000"));
  assert(MIG.includes("ALTER COLUMN visitor_front_seconds SET DEFAULT 4320000"));
  assert(MIG.includes("visitor_front_pre_election_seconds BIGINT NOT NULL DEFAULT 8640000"));
  assert(MIG.includes("boost_seconds = 2592000, manual_front_seconds = 2592000, visitor_front_seconds = 4320000, visitor_front_pre_election_seconds = 8640000"));
  assert(MIG.includes("舊值 157680000／157680000／315360000"));
  assertEquals([4320000 / DAY, 8640000 / DAY], [50, 100]);
});

Deno.test("A2 號次拉前：只把 2×、3×、2.5× visitor_front_seconds 換成寫死的原值，其餘與上一版逐字相同", async () => {
  const prev = await latestFn("cand_no_front_pull", MIG_NAME);
  const neu = fnText(MIG, "cand_no_front_pull");
  const stripped = neu.replace(/  -- >>> 插隊改天級[^\n]*\n[\s\S]*?  -- <<< 插隊改天級\n/, "  SELECT 2 * q.visitor_front_seconds, 3 * q.visitor_front_seconds, 5 * q.visitor_front_seconds / 2\n    INTO v_boost, v_top, v_seq FROM queue_settings q WHERE q.id = 1;\n");
  assertEquals(stripped, prev);
  assert(neu.includes("v_boost := 630720000; v_top := 946080000; v_seq := 788400000;"));
  assertEquals(2 * 315360000, 630720000);
  assertEquals(3 * 315360000, 946080000);
  assertEquals(5 * 315360000 / 2, 788400000);
});

const MARK = "  -- 依目標選舉階段（20261114020000）";
const REVERSE: Record<string, Array<[string, string]>> = {
  manual_front_seconds: [["THEN visitor_front_seconds_for(t.target)" + MARK, "THEN q.visitor_front_seconds"]],
  manual_front_pull: [
    ["SET boost_seconds = visitor_front_seconds_for(d.target)" + MARK + "\n", "SET boost_seconds = q.visitor_front_seconds\n"],
    ["AND d.boost_seconds < visitor_front_seconds_for(d.target)\n", "AND d.boost_seconds < q.visitor_front_seconds\n"],
  ],
  web_request_gap_boost: [
    ["WITH fresh AS (", "WITH s AS (SELECT q.visitor_front_seconds AS secs FROM queue_settings q WHERE q.id = 1),\n  fresh AS ("],
    ["FROM fresh f\n", "FROM fresh f CROSS JOIN s\n"],
    ["GREATEST(d.boost_seconds, visitor_front_seconds_for(d.target))," + MARK, "GREATEST(d.boost_seconds, s.secs),"],
  ],
  work_card_attach: [
    ["SET boost_seconds = GREATEST(d.boost_seconds, visitor_front_seconds_for(d.target))" + MARK, "SET boost_seconds = GREATEST(d.boost_seconds, (SELECT q.visitor_front_seconds FROM queue_settings q WHERE q.id = 1))"],
    ["AND d.boost_seconds < visitor_front_seconds_for(d.target);", "AND d.boost_seconds < (SELECT q.visitor_front_seconds FROM queue_settings q WHERE q.id = 1);"],
  ],
};
for (const [name, edits] of Object.entries(REVERSE)) {
  Deno.test(`A3 ${name}：只把讀 visitor_front_seconds 的地方換成 visitor_front_seconds_for（依目標選舉階段），其餘與上一版逐字相同`, async () => {
    const prev = await latestFn(name, MIG_NAME);
    let neu = fnText(MIG, name);
    for (const [to, from] of edits) {
      assertEquals(neu.split(to).length - 1, 1, `${to.slice(0, 50)} 要剛好出現一次`);
      neu = neu.replace(to, () => from);
    }
    assertEquals(neu, prev);
    assert(!/q\.visitor_front_seconds/.test(fnText(MIG, name).replace(/--[^\n]*/g, "")), "不再直接讀 visitor_front_seconds");
  });
}

Deno.test("A4 縮放規則：號次 20／25／30 年不縮、網站請求來源的 10 年依目標選舉階段、有冪等標記；不動協議版號", () => {
  assert(MIG.includes("NOT IN (630720000, 788400000, 946080000)"));
  assert(MIG.includes("boost_days_applied_at IS NOT NULL"));
  assert(MIG.includes("d.boost_seconds * 2592000 / 157680000"));
  assert(MIG.includes("SET boost_seconds = visitor_front_seconds_for(d.target)\n   WHERE d.boost_seconds = 315360000"));
  assert(!/PROTOCOL_VERSION/.test(MIG));
});

const SCHEMA = `
CREATE TABLE queue_settings (id SMALLINT PRIMARY KEY, boost_seconds BIGINT NOT NULL DEFAULT 157680000, visitor_front_seconds BIGINT NOT NULL DEFAULT 315360000,
  manual_front_seconds BIGINT NOT NULL DEFAULT 157680000, note TEXT);
INSERT INTO queue_settings (id) VALUES (1);
CREATE TABLE elections (id INTEGER PRIMARY KEY, election_date DATE NOT NULL);
INSERT INTO elections VALUES (2022, '2022-11-26'), (2026, '2026-11-28'), (2027, '2026-11-14'), (2028, '2026-11-13');
CREATE TABLE task_dispatches (task_id TEXT PRIMARY KEY, boost_seconds BIGINT NOT NULL DEFAULT 0, target JSONB NOT NULL DEFAULT '{}'::jsonb, opened_by JSONB);
CREATE TABLE contribution_tasks (id UUID PRIMARY KEY, source TEXT NOT NULL, task_type TEXT NOT NULL, created_by TEXT, target JSONB NOT NULL DEFAULT '{}'::jsonb);
CREATE FUNCTION manual_task_is_visitor(p_source TEXT, p_type TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $f$ SELECT p_source = 'web_request' OR p_type = 'question' $f$;
CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql AS $f$ SELECT date '2026-11-14' $f$;
`;
const FIVE_Y = 157680000, TEN_Y = 315360000;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function base(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(await latestFn("election_id_or_null", MIG_NAME));
  return db;
}
async function applied(): Promise<PGlite> {
  const db = await base();
  const ct = (n: number, src: string, type: string, target: string) => `INSERT INTO contribution_tasks VALUES ('${U(n)}', '${src}', '${type}', NULL, '${target}'::jsonb);`;
  await db.exec(ct(1, "web_request", "policy_missing", '{"election_id":2026}') + ct(2, "web_request", "policy_missing", '{"election_id":2022}') +
    ct(3, "web_request", "question", "{}") + ct(4, "manual", "audit", '{"election_id":2026}'));
  await db.exec(`INSERT INTO task_dispatches (task_id, boost_seconds, target, opened_by) VALUES
    ('auto:a', ${FIVE_Y}, '{}', NULL), ('auto:b', ${TEN_Y}, '{"election_id":2026}', NULL), ('auto:c', ${3 * FIVE_Y}, '{}', NULL), ('auto:none', 0, '{}', NULL),
    ('auto:gap', ${TEN_Y}, '{"election_id":2026}', '{"web_request_boost_ids":["x"]}'),
    ('${U(1)}', ${TEN_Y}, '{"election_id":2026}', NULL), ('${U(2)}', ${TEN_Y}, '{"election_id":2022}', NULL), ('${U(3)}', ${TEN_Y}, '{}', NULL),
    ('${U(4)}', ${FIVE_Y}, '{"election_id":2026}', NULL),
    ('verify:1', 630720000, '{}', NULL), ('verify:2', 788400000, '{}', NULL), ('verify:3', 946080000, '{}', NULL), ('verify:4', ${2 * FIVE_Y + 3000000}, '{}', NULL)`);
  await db.exec(MIG);
  return db;
}
const boostOf = async (db: PGlite, id: string) => Number((await db.query<{ b: string }>(`SELECT boost_seconds AS b FROM task_dispatches WHERE task_id = '${id}'`)).rows[0]!.b);

Deno.test("B1 套用：設定變 30／30 天、選後 50 天、選前 100 天；5 年→30 天、15 年→90 天；號次值與 0 不動", async () => {
  const db = await applied();
  const s = (await db.query<{ b: string; m: string; v: string; p: string }>(
    `SELECT boost_seconds b, manual_front_seconds m, visitor_front_seconds v, visitor_front_pre_election_seconds p FROM queue_settings WHERE id = 1`)).rows[0]!;
  assertEquals([Number(s.b), Number(s.m), Number(s.v), Number(s.p)], [30 * DAY, 30 * DAY, 50 * DAY, 100 * DAY]);
  assertEquals(await boostOf(db, "auto:a"), 30 * DAY);
  assertEquals(await boostOf(db, "auto:c"), 90 * DAY);
  assertEquals(await boostOf(db, "auto:none"), 0);
  assertEquals(await boostOf(db, U(4)), 30 * DAY, "維護者建的 5 年→30 天");
  assertEquals(await boostOf(db, "verify:1"), 630720000, "20 年（號次）不縮");
  assertEquals(await boostOf(db, "verify:2"), 788400000, "25 年（號次）不縮");
  assertEquals(await boostOf(db, "verify:3"), 946080000, "30 年（號次）不縮");
  const v4 = await boostOf(db, "verify:4");
  assert(v4 > 60 * DAY && v4 < 61 * DAY, "不是整數倍的 10 年多一點，按 /boost 比例縮");
  await db.close();
});

Deno.test("B2 10 年的列：網站請求來源依目標選舉階段（選前 100／選後與無選舉 50），分不出來源的按 /boost 比例縮成 60 天", async () => {
  const db = await applied();
  assertEquals(await boostOf(db, U(1)), 100 * DAY, "網站請求、目標 2026（投票日 11-28 ≥ 今天）→ 選前");
  assertEquals(await boostOf(db, U(2)), 50 * DAY, "網站請求、目標 2022（已投票）→ 選後");
  assertEquals(await boostOf(db, U(3)), 50 * DAY, "公民提問、沒有選舉 → 50 天");
  assertEquals(await boostOf(db, "auto:gap"), 100 * DAY, "缺口列標了 web_request_boost_ids、目標 2026 → 選前");
  assertEquals(await boostOf(db, "auto:b"), 60 * DAY, "分不出來源的 10 年（可能兩次 /boost）→ 60 天");
  await db.close();
});

Deno.test("B3 冪等：重跑不再縮；新建欄位預設值是新值", async () => {
  const db = await applied();
  await db.exec(MIG);
  assertEquals(await boostOf(db, "auto:a"), 30 * DAY);
  assertEquals(await boostOf(db, U(1)), 100 * DAY);
  assertEquals(await boostOf(db, "auto:b"), 60 * DAY);
  const d = (await db.query<{ column_name: string; column_default: string }>(
    `SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'queue_settings'
      AND column_name IN ('boost_seconds', 'visitor_front_seconds', 'manual_front_seconds', 'visitor_front_pre_election_seconds') ORDER BY 1`)).rows;
  assertEquals(d.map((r) => [r.column_name, r.column_default]), [
    ["boost_seconds", "2592000"], ["manual_front_seconds", "2592000"], ["visitor_front_pre_election_seconds", "8640000"], ["visitor_front_seconds", "4320000"]]);
  await db.close();
});

Deno.test("B4 visitor_front_seconds_for：選前 100 天；投票日當天算選前；投票日已過、沒有選舉、查無這場選舉都是 50 天；兩個值都能 UPDATE", async () => {
  const db = await applied();
  const f = async (t: string) => Number((await db.query<{ s: string }>(`SELECT visitor_front_seconds_for('${t}'::jsonb) AS s`)).rows[0]!.s) / DAY;
  assertEquals(await f('{"election_id":2026}'), 100);
  assertEquals(await f('{"election_id":"2026"}'), 100, "election_id 是字串也行");
  assertEquals(await f('{"election_id":2027}'), 100, "投票日＝今天（11-14）算選前");
  assertEquals(await f('{"election_id":2028}'), 50, "投票日昨天（11-13）算選後");
  assertEquals(await f('{"election_id":2022}'), 50);
  assertEquals(await f("{}"), 50);
  assertEquals(await f('{"election_id":999}'), 50, "查無這場選舉");
  await db.exec(`UPDATE queue_settings SET visitor_front_pre_election_seconds = ${120 * DAY}, visitor_front_seconds = ${40 * DAY} WHERE id = 1`);
  assertEquals(await f('{"election_id":2026}'), 120);
  assertEquals(await f("{}"), 40);
  await db.close();
});

Deno.test("B5 manual_front_seconds：網站請求依目標選舉階段、維護者建的 30 天、投太多輪的 0", async () => {
  const db = await applied();
  await db.exec(`INSERT INTO contribution_tasks VALUES ('${U(5)}', 'manual', 'adjudicate', 'auto-overvoted', '{}'::jsonb)`);
  const m = async (n: number) => Number((await db.query<{ s: string }>(`SELECT manual_front_seconds('${U(n)}') AS s`)).rows[0]!.s) / DAY;
  assertEquals(await m(1), 100, "網站請求、目標 2026 → 選前");
  assertEquals(await m(2), 50, "網站請求、目標 2022 → 選後");
  assertEquals(await m(3), 50, "公民提問、沒有選舉");
  assertEquals(await m(4), 30, "維護者建的手動任務");
  assertEquals(await m(5), 0, "投太多輪的裁決任務");
  await db.close();
});

Deno.test("B6 號次拉前不讀 visitor 設定：改成 50／100 天後仍給 20／25／30 年", async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE queue_settings (id integer PRIMARY KEY, visitor_front_seconds bigint);
    INSERT INTO queue_settings VALUES (1, ${50 * DAY});
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, target jsonb, boost_seconds bigint NOT NULL DEFAULT 0, cooling boolean NOT NULL DEFAULT true, cool_until timestamptz);
    CREATE TABLE contributions (id integer PRIMARY KEY, status text, contribution_type text, payload jsonb);
    CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql AS $$ SELECT date '2026-11-14' $$;
    CREATE FUNCTION task_in_check_cooldown(p TEXT) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    ${fnText(MIG, "cand_no_front_pull")}`);
  await db.exec(`INSERT INTO task_dispatches (task_id, target) VALUES
    ('auto:g1', '{"kind":"cand_no","election_type":"縣市長"}'), ('auto:g2', '{"kind":"cand_no","election_type":"村里長"}'), ('auto:g3', '{"kind":"cand_no","election_type":"鄉鎮市長"}')`);
  await db.exec("SELECT cand_no_front_pull()");
  const b = Object.fromEntries((await db.query<{ task_id: string; b: string }>(`SELECT task_id, boost_seconds b FROM task_dispatches`)).rows.map((r) => [r.task_id, Number(r.b)]));
  assertEquals(b["auto:g1"], 946080000, "縣市長 30 年");
  assertEquals(b["auto:g2"], 630720000, "其他職位 20 年");
  assertEquals(b["auto:g3"], 788400000, "當前提前職位 25 年");
  await db.close();
});

// ------------------------------------------------------------
// C. 排序：排序鍵＝GREATEST(進隊 − 優先秒數, 冷卻結束) − 插隊秒數（task_queue_key 一字不動）
// ------------------------------------------------------------
async function keyEnv(): Promise<PGlite> {
  const db = await applied();
  await db.exec(await latestFn("task_queue_key", MIG_NAME));
  return db;
}
const ENTERED = "2026-11-14T00:00:00Z";
const keyAt = async (db: PGlite, prioDays: number, boostSeconds: number): Promise<number> =>
  Number((await db.query<{ t: string }>(`SELECT extract(epoch FROM task_queue_key('${ENTERED}'::timestamptz, ${prioDays * DAY}, NULL, ${boostSeconds}))::BIGINT AS t`)).rows[0]!.t);
const front = async (db: PGlite, target: string): Promise<number> =>
  Number((await db.query<{ s: string }>(`SELECT visitor_front_seconds_for('${target}'::jsonb) AS s`)).rows[0]!.s);
const settingsBoost = async (db: PGlite, col: string): Promise<number> =>
  Number((await db.query<{ v: string }>(`SELECT ${col} AS v FROM queue_settings WHERE id = 1`)).rows[0]!.v);

Deno.test("C1 網站請求件：選前排序鍵提前 100 天、選後 50 天、沒有選舉 50 天（不是 10 年）", async () => {
  const db = await keyEnv();
  const plain = await keyAt(db, 2603, 0);
  assertEquals((plain - await keyAt(db, 2603, await front(db, '{"election_id":2026}'))) / DAY, 100);
  assertEquals((plain - await keyAt(db, 2603, await front(db, '{"election_id":2022}'))) / DAY, 50);
  assertEquals((plain - await keyAt(db, 2603, await front(db, "{}"))) / DAY, 50);
  await db.close();
});

Deno.test("C2 /boost 一次：提前 30 天；插兩次 60 天", async () => {
  const db = await keyEnv();
  const b = await settingsBoost(db, "boost_seconds");
  const plain = await keyAt(db, 2603, 0);
  assertEquals((plain - await keyAt(db, 2603, b)) / DAY, 30);
  assertEquals((plain - await keyAt(db, 2603, 2 * b)) / DAY, 60);
  await db.close();
});

Deno.test("C3 同時進隊：2026 縣市長（前段 3＋需求 2＋選舉年 2600＋類別 6，有網站請求 100 天）排在 2022 村里長（後段 −30＋選舉年 2200，無請求）前面", async () => {
  const db = await keyEnv();
  const mayor26 = await keyAt(db, 3 + 2 + 2600 + 6, await front(db, '{"election_id":2026}'));
  const village22 = await keyAt(db, -30 + 2200, 0);
  assert(mayor26 < village22);
  assertEquals((village22 - mayor26) / DAY, 2611 + 100 - 2170);
  await db.close();
});

Deno.test("C4 跨屆次序：2022 有請求（50 天）的件，排在 2026 沒請求的件後面，但在 2022 沒請求的件前面", async () => {
  const db = await keyEnv();
  const req22 = await keyAt(db, -30 + 2200, await front(db, '{"election_id":2022}'));
  const plain22 = await keyAt(db, -30 + 2200, 0);
  const plain26 = await keyAt(db, 3 + 2600, 0);
  assert(plain26 < req22, "2026 沒請求的件比 2022 有請求的件先（選舉年差 400 天大於 50 天）");
  assert(req22 < plain22, "2022 有請求的件比 2022 沒請求的件先");
  await db.close();
});
