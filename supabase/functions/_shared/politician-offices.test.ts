/**
 * politician_offices 的守門測試（migration 20261004000005；2026-10-04 維護者：「職稱可能有多種，把他跟參選狀況分開來」）。
 *
 * 現任的判定在資料庫，這裡沒辦法真的跑 SQL，所以守住幾個「改掉就會出錯」的條件：
 *   1. 不能用 elections.end_date 當任期結束——那一欄存的是投票日
 *   2. 中選會那條路要「唯一對上」而且 elected 為真，而且不能覆蓋已經寫成 not_elected 的紀錄
 *   3. 任期兩端都要擋（就任日、卸任日）
 *   4. 任期日期要跟前端那份一致（2022 地方 12/25 就任、2024 立委 2/1、總統 5/20）
 *   5. 視圖要公開可讀、以呼叫者身分執行
 */
import { assertEquals, assertMatch, assertStringIncludes } from "jsr:@std/assert@1";

const MIGRATION = new URL("../../migrations/20261004000005_politician_offices.sql", import.meta.url);
const sql = await Deno.readTextFile(MIGRATION);
/** 只看 politician_offices 的視圖定義（註解與 COMMENT 字串裡會提到 elections.end_date，那是在說「不要用它」） */
const view = sql.slice(sql.indexOf("CREATE OR REPLACE VIEW politician_offices"), sql.indexOf("COMMENT ON VIEW politician_offices"));

Deno.test("politician_offices：任期由屆別＋選舉別算，不碰 elections.end_date", () => {
  // elections.end_date 是投票日（2022 那列是 2022-11-26）。拿它當任期結束，2022 選出來的人隔天就不是現任了。
  assertEquals(/elections\s*\.\s*end_date/.test(view), false, "視圖不可以用 elections.end_date 當任期結束");
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION office_term_start");
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION office_term_end");
});

Deno.test("politician_offices：就任日照選舉別分（地方 12/25、立委 2/1、總統 5/20）", () => {
  const start = sql.slice(sql.indexOf("FUNCTION office_term_start"), sql.indexOf("FUNCTION office_term_end"));
  assertMatch(start, /'總統副總統'\s+THEN\s+make_date\(p_election_id,\s*5,\s*20\)/);
  assertMatch(start, /'立法委員'\s+THEN\s+make_date\(p_election_id,\s*2,\s*1\)/);
  assertMatch(start, /ELSE\s+make_date\(p_election_id,\s*12,\s*25\)/);
  // 卸任日＝四年後那一屆就任日的前一天，所以換屆那天不會新舊兩個職稱並列
  assertMatch(sql, /office_term_start\(p_election_id \+ 4, p_election_type\) - 1/);
});

Deno.test("politician_offices：任期兩端都要擋", () => {
  assertMatch(sql, /office_term_start\(pe\.election_id, pe\.election_type\) <= CURRENT_DATE/);
  assertMatch(sql, /office_term_end\(pe\.election_id, pe\.election_type\) >= CURRENT_DATE/);
});

Deno.test("politician_offices：兩條來源——我們標的當選，或中選會名單唯一對上且當選", () => {
  assertMatch(sql, /pe\.election_result = 'elected'/);
  // 唯一對上：同屆別＋同選舉別＋同正規化姓名＋同縣市只有一列
  assertStringIncludes(sql, "count(*) = 1 AND bool_and(c.elected)");
  assertStringIncludes(sql, "c.name_norm = cec_name_norm(p.name)");
  assertMatch(sql, /c\.election_id = pe\.election_id/);
  assertMatch(sql, /c\.election_type = pe\.election_type/);
  assertMatch(sql, /c\.region = COALESCE\(r\.region, p\.region\)/);
});

Deno.test("politician_offices：已經標成 not_elected 的不讓中選會翻盤", () => {
  // 中選會那條路只對「我們還不知道結果」的紀錄生效；有衝突要走 correction 改資料，不是在顯示層蓋掉
  assertStringIncludes(sql, "pe.election_result IS NULL");
});

Deno.test("politician_offices：合併掉的人物不算，視圖公開可讀且以呼叫者身分執行", () => {
  assertStringIncludes(sql, "p.merged_into IS NULL");
  assertStringIncludes(sql, "ALTER VIEW politician_offices SET (security_invoker = on)");
  assertStringIncludes(sql, "GRANT SELECT ON politician_offices TO anon, authenticated");
});

Deno.test("politician_offices：人物視圖要把 offices 帶出去（前端的職稱只讀這個）", () => {
  assertStringIncludes(sql, "CREATE OR REPLACE VIEW politicians_with_elections");
  assertStringIncludes(sql, "FROM politician_offices o");
  assertStringIncludes(sql, "AS offices");
  // politicians_with_policies 是 SELECT p.*，星號在建視圖時就展開了，不重跑就拿不到新欄位
  assertStringIncludes(sql, "CREATE OR REPLACE VIEW politicians_with_policies");
  // 新欄位一定要加在最後：CREATE OR REPLACE VIEW 不能改既有欄位的名稱與順序
  assertMatch(sql, /p\.merged_into,\s*\n\s*COALESCE\(\( SELECT json_agg\(json_build_object\('electionId', o\.election_id/);
});

Deno.test("換掉既有視圖之後要補回 security_invoker", () => {
  // CREATE OR REPLACE VIEW 會把 reloptions 清掉（本機實測），不補就退回「以建立者身分執行、底層表 RLS 不套呼叫者」
  assertStringIncludes(sql, "ALTER VIEW politicians_with_elections SET (security_invoker = on)");
  assertStringIncludes(sql, "ALTER VIEW politicians_with_policies SET (security_invoker = on)");
});
