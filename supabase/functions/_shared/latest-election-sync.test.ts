/**
 * 人物「最新一屆」衍生欄位的同步規則（migration 20261005004020；2026-10-05）。
 *
 * 原本的觸發器用 `IF v_latest IS NOT NULL`——紀錄型別的 IS NOT NULL 要每個欄位都非空才成立，口號幾乎都是空的，
 * 所以 16,214 位裡 16,213 位從來沒同步過。SQL 在 PGlite 上灌 10-05 線上唯讀快照實跑驗過（見 PR 說明）；
 * 這裡守住「改掉就會出錯、而且不會報錯」的條件：
 *   1. 判斷有沒有找到紀錄用 FOUND，不用紀錄型別的 IS NOT NULL
 *   2. 「最新一屆」＝最近一屆有在選的（表態不參選排最後），觸發器與重算用同一支函式，不各寫一份
 *   3. 只改人物的四個衍生欄位，不改參選紀錄；每個改動的欄位都留 edit_history
 *   4. 前端組人物職稱的規則（mapPolitician）跟這裡一致：最近一筆非 not_running
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const sql = await Deno.readTextFile(new URL("20261005004020_latest_election_sync.sql", MIGRATIONS));

function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  assert(i >= 0, `找不到「${start}」`);
  const j = text.indexOf(end, i + start.length);
  return text.slice(i, j < 0 ? undefined : j);
}
/** 去掉 SQL 註解，免得註解裡的舊寫法被當成程式 */
// （Windows 檢出是 CRLF：先切掉 \r，不然 `.` 碰到 \r 就停、註解拿不掉）
const code = (s: string) => s.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");

const latestFn = code(between(sql, "CREATE OR REPLACE FUNCTION politician_latest_election(", "COMMENT ON FUNCTION politician_latest_election"));
const trigger = code(between(sql, "CREATE OR REPLACE FUNCTION sync_politician_latest_election()", "COMMENT ON FUNCTION sync_politician_latest_election"));
const backfill = code(sql.slice(sql.indexOf("DO $$")));

Deno.test("觸發器判斷有沒有找到紀錄用 FOUND，不用紀錄型別的 IS NOT NULL（口號空的那屆整筆不同步）", () => {
  assertEquals(/v_latest\s+IS\s+NOT\s+NULL/i.test(trigger), false);
  assertMatch(trigger, /IF FOUND THEN/);
});

Deno.test("最新一屆：表態不參選排最後、同順位取最近一屆", () => {
  assertMatch(latestFn, /ORDER BY \(COALESCE\(pe\.candidate_status, ''\) = 'not_running'\), pe\.election_id DESC\s+LIMIT 1/);
});

Deno.test("觸發器與重算用同一支 politician_latest_election()，不各自寫一份排序", () => {
  assert(trigger.includes("FROM politician_latest_election(v_id)"));
  assert(backfill.includes("CROSS JOIN LATERAL politician_latest_election(p.id) l"));
  for (const [name, body] of [["觸發器", trigger], ["重算", backfill]] as const) {
    assertEquals(/ORDER BY/.test(body), false, `${name}自己又寫了一份排序`);
  }
});

Deno.test("有值才寫、空的保留人物現值（四個欄位都一樣），觸發器與重算同一套", () => {
  for (const col of ["position", "slogan", "region_id"]) {
    assert(new RegExp(`${col}\\s*=\\s*COALESCE\\(v_latest\\.${col}, p\\.${col}\\)`).test(trigger), `觸發器 ${col}`);
    assert(new RegExp(`COALESCE\\(l\\.${col}, p\\.${col}\\) AS new_${col}`).test(backfill), `重算 ${col}`);
  }
  assert(/election_type = COALESCE\(v_latest\.election_type, p\.election_type::TEXT\)/.test(trigger));
  assert(/COALESCE\(l\.election_type, p\.election_type::TEXT\) AS new_election_type/.test(backfill));
});

Deno.test("值沒變就不 UPDATE（不必要地觸發人物表的統計與身份觸發器）；換人時新舊兩位都重算", () => {
  assert(/WHERE p\.id = v_id\s+AND \(p\.position IS DISTINCT FROM/.test(trigger));
  assert(/ARRAY\[NEW\.politician_id, OLD\.politician_id\]/.test(trigger));
  assert(/DELETE FROM _latest_sync s\s+WHERE s\.old_position IS NOT DISTINCT FROM s\.new_position/.test(backfill));
});

Deno.test("只改人物的四個衍生欄位，不改參選紀錄；每個改動的欄位都寫 edit_history", () => {
  const body = code(sql);
  assertEquals(/UPDATE\s+politician_elections/i.test(body), false, "不可以改參選紀錄本身");
  assertEquals(/DELETE\s+FROM\s+politician_elections/i.test(body), false);
  assertMatch(backfill, /UPDATE politicians p\s+SET position = s\.new_position, slogan = s\.new_slogan, election_type = s\.new_election_type, region_id = s\.new_region_id/);
  for (const f of ["position", "slogan", "election_type", "region_id"]) {
    assert(backfill.includes(`('${f}',`), `edit_history 要記 ${f}`);
  }
  assert(backfill.includes("WHERE f.old_value IS DISTINCT FROM f.new_value"));
  assert(backfill.includes("'latest-election-sync'"));
});

Deno.test("統計觸發器新長出來的地區列：只刪這次新建、落在 region_audit、沒有任何資料指著的", () => {
  const del = between(backfill, "DELETE FROM regions r", "RETURNING r.*");
  assert(del.includes("r.id > v_max_region"));
  assert(del.includes("r.id IN (SELECT a.id FROM region_audit a)"));
  assert(del.includes("NOT EXISTS (SELECT 1 FROM politician_elections pe WHERE pe.region_id = r.id)"));
  assert(del.includes("NOT EXISTS (SELECT 1 FROM politicians p WHERE p.region_id = r.id)"));
  // 記下最大 id 要在改人物之前
  assert(backfill.indexOf("SELECT COALESCE(max(id), 0) INTO v_max_region FROM regions") < backfill.indexOf("UPDATE politicians p"));
});

Deno.test("函式輸出欄的 \"position\" 加引號（SQL 關鍵字，不加是語法錯誤）", () => {
  assertMatch(latestFn, /RETURNS TABLE \(election_id INTEGER, candidate_status TEXT, "position" TEXT,/);
});

Deno.test("前端組人物職稱用的也是「最近一筆非退選（舊的 not_running）」（兩邊規則一致）", async () => {
  const src = await Deno.readTextFile(new URL("../../../composables/useSupabase.ts", import.meta.url));
  // 最近一屆看投票日（newerFirst：有 electionDate 比投票日，沒有才退回 id；#344 第二階段 A），跟資料庫 politician_latest_election 的排序一致
  assertMatch(src, /filter\(e => e\.candidacyStatus !== 'withdrawn'\)\.sort\(newerFirst\)\[0\]/);
});
