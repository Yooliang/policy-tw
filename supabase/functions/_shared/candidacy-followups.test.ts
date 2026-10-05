/**
 * #345 第一階段的後續三項（協調者 10-06 裁定，migration 20261006060000）：
 *   ① confirmed 收窄（落庫端換值，見 confirmed-narrowing.test.ts；這支只動說明）
 *   ② 退選分兩種：withdrawn_after_filing（登記後退選／表態不參選／判斷不了）
 *   ③ 轉任卸任日標「推定」：politician_offices.end_basis
 * SQL 另外在 PGlite 灌 10-06 唯讀快照實跑過（見 PR 說明）。這裡守住：重定義的函式與視圖除了這次要加的東西，
 * 其餘跟上一版一字不差（照抄時漏一段不會報錯、只會默默壞掉）。
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const MIG = new URL("../../migrations/", import.meta.url);
const read = (f: string) => Deno.readTextFile(new URL(f, MIG));
const sql = await read("20261006060000_candidacy_followups.sql");
const prevStatus = await read("20261006034500_candidacy_status.sql");
const prevOffices = await read("20261006034510_politician_offices_table.sql");
const prevView = await read("20261005004300_council_district_flow.sql");

/** 去註解、壓空白（CRLF 也一樣） */
const norm = (s: string) => s.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n").replace(/\s+/g, " ").trim();
function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  assert(i >= 0, `找不到「${start}」`);
  const j = text.indexOf(end, i + start.length);
  assert(j >= 0, `找不到「${end}」`);
  return text.slice(i, j);
}

Deno.test("同步觸發器：原本的兩邊同步一字不差，只在最後多寫 withdrawn_after_filing", () => {
  const before = norm(between(prevStatus, "CREATE OR REPLACE FUNCTION sync_candidacy_status()", "COMMENT ON FUNCTION sync_candidacy_status"));
  const now = norm(between(sql, "CREATE OR REPLACE FUNCTION sync_candidacy_status()", "COMMENT ON FUNCTION sync_candidacy_status"));
  const added = norm(between(sql, "-- 退選分兩種（#345 後續）", "  RETURN NEW;\nEND;"));
  assert(added.length > 50);
  assertEquals(now.replace(added + " ", ""), before, "除了退選那段，其餘要跟 20261006034500 一樣");
});

Deno.test("退選分兩種：退選前是已登記 → true；考慮、表明、沒有狀態（傳聞）→ false；其他判斷不了；不是退選一律清空", () => {
  const block = norm(between(sql, "-- 退選分兩種（#345 後續）", "  RETURN NEW;\nEND;"));
  assertMatch(block, /IF NEW\.candidacy_status = 'withdrawn' THEN IF TG_OP = 'UPDATE' AND OLD\.candidacy_status IS DISTINCT FROM 'withdrawn' THEN/);
  assertMatch(block, /WHEN OLD\.candidacy_status = 'filed' THEN true/);
  assertMatch(block, /WHEN OLD\.candidacy_status IS NULL OR OLD\.candidacy_status IN \('considering', 'declared'\) THEN false END;/);
  assertMatch(block, /ELSE NEW\.withdrawn_after_filing := NULL; END IF;/);
  assertMatch(norm(sql), /CHECK \(withdrawn_after_filing IS NULL OR candidacy_status = 'withdrawn'\)/);
});

Deno.test("退選回填：照查核履歷，登記過（registered／qualified）→ true、有履歷沒登記過 → false；只補空的", () => {
  const fill = norm(between(sql, "UPDATE politician_elections pe\n   SET withdrawn_after_filing", "ALTER TABLE politician_elections DROP CONSTRAINT"));
  assertMatch(fill, /eh\.old_value #>> '\{\}' IN \('registered', 'qualified'\) OR eh\.new_value #>> '\{\}' IN \('registered', 'qualified'\)\) THEN true WHEN count\(eh\.id\) > 0 THEN false/);
  assertMatch(fill, /eh\.field = 'candidate_status'/);
  assertMatch(fill, /x\.candidacy_status = 'withdrawn'/);
  assertMatch(fill, /pe\.withdrawn_after_filing IS NULL AND h\.after_filing IS NOT NULL/);
  // 回填在掛 CHECK 之前、在重定義觸發器之前
  assert(sql.indexOf("SET withdrawn_after_filing") < sql.indexOf("ADD CONSTRAINT politician_elections_withdrawn_after_filing_check"));
  assert(sql.indexOf("SET withdrawn_after_filing") < sql.indexOf("CREATE OR REPLACE FUNCTION sync_candidacy_status()"));
});

Deno.test("卸任日的根據：轉任推定、屆滿依法；卸任日與根據成對；卸任排程其餘一字不差", () => {
  assertMatch(norm(sql), /CHECK \(\(end_date IS NULL\) = \(end_basis IS NULL\) AND \(end_basis IS NULL OR end_basis IN \('law', 'inferred', 'source'\)\)\)/);
  assertMatch(norm(sql), /SET end_basis = CASE end_reason WHEN 'term_expired' THEN 'law' WHEN 'took_other_office' THEN 'inferred' ELSE 'source' END WHERE end_date IS NOT NULL AND end_basis IS NULL/);
  const before = norm(between(prevOffices, "CREATE OR REPLACE FUNCTION politician_offices_close_ended(", "COMMENT ON FUNCTION politician_offices_close_ended"));
  const now = norm(between(sql, "CREATE OR REPLACE FUNCTION politician_offices_close_ended(", "COMMENT ON FUNCTION politician_offices_close_ended"));
  const line = "end_basis = CASE WHEN c.switched THEN 'inferred' ELSE 'law' END,";
  assert(now.includes(line));
  assertEquals(now.replace(line + " ", ""), before, "除了 end_basis 那行，其餘要跟 20261006034510 一樣");
});

Deno.test("人物視圖：只多兩個鍵、職稱照舊讀 politician_offices_derived，其餘跟 20261005004300 一字不差", () => {
  const before = norm(between(prevView, "CREATE OR REPLACE VIEW politicians_with_elections AS", "-- CREATE OR REPLACE VIEW 會把 reloptions 清掉"));
  const now = norm(between(sql, "CREATE OR REPLACE VIEW politicians_with_elections AS", "-- CREATE OR REPLACE VIEW 會把 reloptions 清掉"));
  const expected = before
    .replace("'candNo', pe.cand_no))", "'candNo', pe.cand_no, 'candidacyStatus', pe.candidacy_status, 'withdrawnAfterFiling', pe.withdrawn_after_filing))")
    .replace("FROM politician_offices o", "FROM politician_offices_derived o");
  assertEquals(now, expected);
  assertMatch(sql, /ALTER VIEW politicians_with_elections SET \(security_invoker = on\);/);
});
