/**
 * 插隊改天級（migration 20261114020000_boost_days_level.sql，維護者 2026-11-14 拍板）。
 *
 *   boost_seconds（/boost）5 年→30 天、manual_front_seconds（維護者建的）5 年→30 天、visitor_front_seconds（網站請求）10 年→60 天；
 *   既有佇列上的 boost_seconds 依 2592000 ÷ 157680000 縮放（號次拉前的 20／25／30 年不縮）；
 *   號次拉前不再讀 visitor_front_seconds，改寫死原值。
 *
 *   A. 文字層：新值、號次函式只差一處、縮放排除號次值
 *   B. PGlite：跑整支 migration（設定新值、縮放、冪等、號次值不動）
 *   C. 排序：網站請求件提前約 60 天、/boost 一次 30 天、2026 縣市長有請求排在 2022 村里長無請求前面
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261114020000_boost_days_level.sql";
const MIG = await readMig(MIG_NAME);
const DAY = 86400;

Deno.test("A1 設定新值與預設值：30 天、30 天、60 天；舊值記在 note", () => {
  assert(MIG.includes("ALTER COLUMN boost_seconds         SET DEFAULT 2592000"));
  assert(MIG.includes("ALTER COLUMN manual_front_seconds  SET DEFAULT 2592000"));
  assert(MIG.includes("ALTER COLUMN visitor_front_seconds SET DEFAULT 5184000"));
  assert(MIG.includes("boost_seconds = 2592000, manual_front_seconds = 2592000, visitor_front_seconds = 5184000"));
  assert(MIG.includes("舊值 157680000／157680000／315360000"));
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

Deno.test("A3 縮放排除號次拉前的 20／25／30 年，且有冪等標記", () => {
  assert(MIG.includes("NOT IN (630720000, 788400000, 946080000)"));
  assert(MIG.includes("boost_days_applied_at IS NOT NULL"));
  assert(MIG.includes("d.boost_seconds * 2592000 / 157680000"));
});

Deno.test("A4 沒有動協議版號與 TS", () => {
  assert(!/PROTOCOL_VERSION/.test(MIG));
});

const SCHEMA = `
CREATE TABLE queue_settings (id SMALLINT PRIMARY KEY, boost_seconds BIGINT NOT NULL DEFAULT 157680000, visitor_front_seconds BIGINT NOT NULL DEFAULT 315360000,
  manual_front_seconds BIGINT NOT NULL DEFAULT 157680000, note TEXT);
INSERT INTO queue_settings (id) VALUES (1);
CREATE TABLE task_dispatches (task_id TEXT PRIMARY KEY, boost_seconds BIGINT NOT NULL DEFAULT 0);
`;
const FIVE_Y = 157680000, TEN_Y = 315360000;

async function applied(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(`INSERT INTO task_dispatches VALUES ('auto:a', ${FIVE_Y}), ('auto:b', ${TEN_Y}), ('auto:c', ${3 * FIVE_Y}), ('auto:none', 0),
    ('verify:1', 630720000), ('verify:2', 788400000), ('verify:3', 946080000), ('verify:4', ${2 * FIVE_Y + 3000000})`);
  await db.exec(MIG);
  return db;
}
const boostOf = async (db: PGlite, id: string) => Number((await db.query<{ b: string }>(`SELECT boost_seconds AS b FROM task_dispatches WHERE task_id = '${id}'`)).rows[0]!.b);

Deno.test("B1 套用：設定變 30／30／60 天；5 年→30 天、10 年→60 天、15 年→90 天；號次值與 0 不動", async () => {
  const db = await applied();
  const s = (await db.query<{ b: string; m: string; v: string }>(`SELECT boost_seconds b, manual_front_seconds m, visitor_front_seconds v FROM queue_settings WHERE id = 1`)).rows[0]!;
  assertEquals([Number(s.b), Number(s.m), Number(s.v)], [30 * DAY, 30 * DAY, 60 * DAY]);
  assertEquals(await boostOf(db, "auto:a"), 30 * DAY);
  assertEquals(await boostOf(db, "auto:b"), 60 * DAY);
  assertEquals(await boostOf(db, "auto:c"), 90 * DAY);
  assertEquals(await boostOf(db, "auto:none"), 0);
  assertEquals(await boostOf(db, "verify:1"), 630720000, "20 年（號次）不縮");
  assertEquals(await boostOf(db, "verify:2"), 788400000, "25 年（號次）不縮");
  assertEquals(await boostOf(db, "verify:3"), 946080000, "30 年（號次）不縮");
  assert(await boostOf(db, "verify:4") > 60 * DAY && await boostOf(db, "verify:4") < 61 * DAY, "不是整數倍的照比例縮");
  await db.close();
});

Deno.test("B2 冪等：重跑不再縮；新建的欄位預設值是新值", async () => {
  const db = await applied();
  await db.exec(MIG);
  assertEquals(await boostOf(db, "auto:a"), 30 * DAY);
  assertEquals(await boostOf(db, "auto:b"), 60 * DAY);
  const d = (await db.query<{ column_name: string; column_default: string }>(
    `SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'queue_settings' AND column_name IN ('boost_seconds', 'visitor_front_seconds', 'manual_front_seconds') ORDER BY 1`)).rows;
  assertEquals(d.map((r) => r.column_default), ["2592000", "2592000", "5184000"]);
  await db.close();
});

Deno.test("B3 號次拉前不讀 visitor_front_seconds：改成 60 天後仍給 20／25／30 年", async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE queue_settings (id integer PRIMARY KEY, visitor_front_seconds bigint);
    INSERT INTO queue_settings VALUES (1, ${60 * DAY});
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
  assertEquals(b["auto:g3"], 788400000, "當前提前職位 25 年（清單第一個有缺口的職位）");
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
const settingsBoost = async (db: PGlite, col: string): Promise<number> =>
  Number((await db.query<{ v: string }>(`SELECT ${col} AS v FROM queue_settings WHERE id = 1`)).rows[0]!.v);

Deno.test("C1 網站請求件第一次進隊：排序鍵比沒插隊的同條件件提前 60 天，不是 10 年", async () => {
  const db = await keyEnv();
  const v = await settingsBoost(db, "visitor_front_seconds");
  const plain = await keyAt(db, 2603, 0);
  const req = await keyAt(db, 2603, v);
  assertEquals((plain - req) / DAY, 60);
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

Deno.test("C3 同時進隊：2026 縣市長（前段 3＋需求 2＋選舉年 2600＋類別 6，有網站請求）排在 2022 村里長（後段 −30＋選舉年 2200，無請求）前面", async () => {
  const db = await keyEnv();
  const v = await settingsBoost(db, "visitor_front_seconds");
  const mayor26 = await keyAt(db, 3 + 2 + 2600 + 6, v);
  const village22 = await keyAt(db, -30 + 2200, 0);
  assert(mayor26 < village22);
  assertEquals((village22 - mayor26) / DAY, 2611 + 60 - 2170);
  await db.close();
});

Deno.test("C4 後果：2022 的件即使有網站請求（60 天），仍排在沒插隊的 2026 件後面（選舉年差 400 天大於插隊 60 天）", async () => {
  const db = await keyEnv();
  const v = await settingsBoost(db, "visitor_front_seconds");
  const req22 = await keyAt(db, -30 + 2200, v);
  const plain26 = await keyAt(db, 3 + 2600, 0);
  assert(plain26 < req22, "2026 沒插隊的件比 2022 有請求的件先");
  await db.close();
});
