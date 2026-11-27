/**
 * 派工缺口事件風暴守門（migration 20261127130000_gap_star_storm.sql）。
 *
 * 實測（正式庫 2026-11-27 20:20）：每輪 seed 之後，六支名單族臂同一秒收到 scope_key='*'、kind='update'。
 * 源頭：regions 的語句層級觸發器 trg_dispatch_gap_regions_stmt 沒限定欄位，policies／politicians 的統計觸發器、
 * regions_elected_policy_count_refresh() 只改統計欄的 UPDATE 也觸發。
 *
 * 用 PGlite 載入真的入列函式與 dispatch_gap_on_stmt()（從遷移原文抽出），regions 用只有必要欄位的等價表：
 *   A 重現：掛上 20261127093000 版觸發器（舊），只改統計欄就入六支臂的 '*'
 *   B 修後：同樣的寫入者不再入列；ON CONFLICT DO UPDATE、沒影響到列的 UPDATE 也不入列
 *   C 真正改名（SET region／sub_region／village）與 DELETE 仍入六支臂的 '*'
 *   D 遷移文字守門：時間戳晚於 20261127120000、觸發器名稱與欄位清單、回滾段
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText } from "./arms-pglite.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const PR1 = await read("20261126170000_dispatch_gaps_phase0.sql");
const PR2 = await read("20261126180000_dispatch_gaps_phase0b.sql");
const PH2B = await read("20261127093000_dispatch_gaps_phase2b.sql");
const MIG_NAME = "20261127130000_gap_star_storm.sql";
const MIG = await read(MIG_NAME);

const SIX = [
  "ballot_numbers|*|update",
  "raw:roster_check|*|update",
  "roster_cec_gap|*|update",
  "roster_gap_units|*|update",
  "roster_unit_findings|*|update",
  "roster_villages|*|update",
];

// 20261127093000 版的觸發器（舊）；下面會比對它真的在遷移原文裡
const OLD_TRIGGER = `CREATE TRIGGER trg_dispatch_gap_regions_stmt
  AFTER UPDATE OR DELETE ON regions FOR EACH STATEMENT EXECUTE FUNCTION dispatch_gap_on_stmt();`;

const ENV = `
CREATE TABLE dispatch_gap_settings (id INTEGER PRIMARY KEY, events_enabled BOOLEAN NOT NULL DEFAULT true);
INSERT INTO dispatch_gap_settings VALUES (1, true);
CREATE TABLE dispatch_gap_arm_keys (arm TEXT PRIMARY KEY);
INSERT INTO dispatch_gap_arm_keys VALUES ('roster_unit_findings'), ('roster_gap_units'), ('ballot_numbers'), ('roster_cec_gap'), ('raw:roster_check'), ('roster_villages');
CREATE TABLE dispatch_gap_events (
  id BIGSERIAL PRIMARY KEY, arm TEXT NOT NULL, scope_key TEXT NOT NULL, kind TEXT NOT NULL CHECK (btrim(kind) <> ''),
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);
CREATE UNIQUE INDEX dispatch_gap_events_pending_uidx ON dispatch_gap_events (arm, scope_key) WHERE processed_at IS NULL;
${fnText(PR1, "dispatch_gap_events_enabled")}
${fnText(PR1, "dispatch_gap_enqueue")}
${fnText(PR2, "dispatch_gap_enqueue_reg")}
${fnText(PH2B, "dispatch_gap_on_stmt")}
CREATE TABLE regions (
  id SERIAL PRIMARY KEY, region TEXT NOT NULL, sub_region TEXT, village TEXT,
  policy_count INTEGER NOT NULL DEFAULT 0, total_politicians INTEGER NOT NULL DEFAULT 0,
  elected_policy_count INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (region, sub_region, village));
INSERT INTO regions (region, sub_region, village) VALUES ('臺北市', NULL, NULL), ('臺北市', '大安區', NULL), ('花蓮縣', '花蓮市', '國盛里');
`;

async function freshDb(o: { fixed: boolean }): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ENV);
  await db.exec(OLD_TRIGGER);
  if (o.fixed) await db.exec(MIG);
  await clear(db);
  return db;
}
const clear = (db: PGlite) => db.exec("DELETE FROM dispatch_gap_events");
const pending = async (db: PGlite) =>
  (await db.query<{ v: string }>("SELECT arm || '|' || scope_key || '|' || kind AS v FROM dispatch_gap_events WHERE processed_at IS NULL ORDER BY 1")).rows.map((r) => r.v);

// 三種只動統計欄的寫入者（對應正式庫的 update_policy_stats／update_region_stats／regions_elected_policy_count_refresh）
const STAT_WRITERS: Record<string, string> = {
  "政見統計 UPDATE policy_count、updated_at": "UPDATE regions SET policy_count = policy_count + 1, updated_at = now() WHERE region = '臺北市' AND sub_region IS NULL",
  "人物統計 UPDATE total_politicians、updated_at": "UPDATE regions SET total_politicians = total_politicians + 1, updated_at = now() WHERE id = 2",
  "每 10 分鐘重算 UPDATE elected_policy_count": "UPDATE regions r SET elected_policy_count = 5 WHERE r.elected_policy_count IS DISTINCT FROM 5",
  "重算沒有任何列要改（語句仍會執行）": "UPDATE regions SET elected_policy_count = 0 WHERE false",
  "政見新增 INSERT ON CONFLICT DO UPDATE SET policy_count": `INSERT INTO regions (region, sub_region, village, policy_count) VALUES ('臺北市', '大安區', NULL, 1)
     ON CONFLICT (region, sub_region, village) DO UPDATE SET policy_count = regions.policy_count + 1, updated_at = now()`,
};

Deno.test("A 重現：舊觸發器下，只改統計欄的寫入者各自入六支臂的整臂 '*'", async () => {
  for (const [name, sql] of Object.entries(STAT_WRITERS)) {
    const db = await freshDb({ fixed: false });
    await db.exec(sql);
    assertEquals(await pending(db), SIX, `舊版應重現事件風暴：${name}`);
  }
});

Deno.test("A0 舊觸發器定義就是 20261127093000 遷移裡那一句（重現的前提）", () => {
  const head = "CREATE TRIGGER trg_dispatch_gap_regions_stmt\n  AFTER UPDATE OR DELETE ON regions FOR EACH STATEMENT EXECUTE FUNCTION dispatch_gap_on_stmt();";
  assert(OLD_TRIGGER === head && PH2B.includes(head), "舊定義不在 20261127093000");
});

Deno.test("B 修後：只改統計欄的寫入者不再入列", async () => {
  for (const [name, sql] of Object.entries(STAT_WRITERS)) {
    const db = await freshDb({ fixed: true });
    await db.exec(sql);
    assertEquals(await pending(db), [], `修後不該入列：${name}`);
  }
});

Deno.test("C 真正改名與刪除仍入六支臂的整臂 '*'", async () => {
  for (const sql of [
    "UPDATE regions SET sub_region = '大安區第01選舉區' WHERE id = 2",
    "UPDATE regions SET region = '台北市' WHERE id = 1",
    "UPDATE regions SET village = '新里' WHERE id = 3",
    "UPDATE regions SET sub_region = '松山區', policy_count = 9 WHERE id = 2",
  ]) {
    const db = await freshDb({ fixed: true });
    await db.exec(sql);
    assertEquals(await pending(db), SIX, sql);
  }
  const db = await freshDb({ fixed: true });
  await db.exec("DELETE FROM regions WHERE id = 3");
  assertEquals(await pending(db), SIX.map((s) => s.replace("|update", "|delete")), "DELETE 仍入列");
  await clear(db);
  await db.exec("INSERT INTO regions (region, sub_region, village) VALUES ('宜蘭縣', NULL, NULL)");
  assertEquals(await pending(db), [], "INSERT 本來就不掛");
});

Deno.test("C2 修後觸發器的欄位清單真的是 UPDATE OF region, sub_region, village（含 DELETE）", async () => {
  const db = await freshDb({ fixed: true });
  const r = await db.query<{ def: string }>("SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = 'trg_dispatch_gap_regions_stmt'");
  assertEquals(r.rows.length, 1);
  const def = r.rows[0].def;
  assert(/UPDATE OF region, sub_region, village/.test(def), def);
  assert(/DELETE/.test(def), def);
  assert(/FOR EACH STATEMENT/.test(def), def);
});

Deno.test("D 遷移文字守門", () => {
  const ts = MIG_NAME.slice(0, 14);
  assert(ts > "20261127120000", `時間戳要晚於 #1076 的 20261127120000：${ts}`);
  assert(/DROP TRIGGER IF EXISTS trg_dispatch_gap_regions_stmt ON regions;/.test(MIG));
  assert(/AFTER UPDATE OF region, sub_region, village OR DELETE ON regions FOR EACH STATEMENT/.test(MIG));
  assert(/回滾/.test(MIG) && /20261127093000_dispatch_gaps_phase2b\.sql/.test(MIG), "要寫回滾與前一版定義檔名");
  assert(/每日呼叫量變化：0/.test(MIG), "要寫每日呼叫量變化：0");
  assert(!/CREATE OR REPLACE FUNCTION/.test(MIG), "不改任何函式本體（避免與 seed 的 PR 衝突）");
});
