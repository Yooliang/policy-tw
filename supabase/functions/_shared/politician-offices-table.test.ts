/**
 * 任期存成正式資料：politician_offices 表（#345 第一階段之二，migration 20261006034510）。
 *
 * SQL 另外在 PGlite（WASM Postgres）灌 10-06 線上唯讀快照實跑過（見 PR 說明：回填 8,560 列、現任 8,544 位的職稱
 * 跟舊視圖逐人一致、觸發器與換屆模擬）；這裡沒有資料庫，守住「改掉就會出錯、而且不會報錯」的條件：
 *   1. 第一階段網站的職稱不變：舊視圖改名保留、人物視圖不重建；之後誰照抄舊定義重建人物視圖，不能默默改讀新表
 *   2. 現任＝已就任而且卸任日為空；卸任日只寫已經發生的
 *   3. 觸發器只認我們標的當選（走流程核過的），不自動拿中選會名單長新列
 *   4. 任期起訖跟舊視圖同一支函式、年份取投票日不取 id
 *   5. 回填跟舊視圖對不上要整支退回
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const FILE = "20261006034510_politician_offices_table.sql";
const sql = await Deno.readTextFile(new URL(FILE, MIGRATIONS));
/** 去掉 SQL 註解（Windows 檢出是 CRLF，先切掉 \r） */
const code = (s: string) => s.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");
const body = code(sql);
function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  assert(i >= 0, `找不到「${start}」`);
  const j = text.indexOf(end, i + start.length);
  assert(j >= 0, `找不到「${end}」`);
  return text.slice(i, j);
}
const trigger = between(body, "CREATE OR REPLACE FUNCTION sync_politician_office_from_election()", "COMMENT ON FUNCTION sync_politician_office_from_election");
const closeFn = between(body, "CREATE OR REPLACE FUNCTION politician_offices_close_ended(", "COMMENT ON FUNCTION politician_offices_close_ended");

Deno.test("舊視圖改名保留、人物視圖不重建：這一步網站的職稱一個字都不變", () => {
  assertMatch(body, /ALTER VIEW politician_offices RENAME TO politician_offices_derived;/);
  assertEquals(/DROP VIEW[^;]*politician_offices/.test(body), false, "第一階段不刪舊視圖");
  assertEquals(/CREATE (OR REPLACE )?VIEW politicians_with_elections/.test(body), false, "這支不重建人物視圖（它照物件編號讀改名後的舊視圖）");
});

Deno.test("之後重建人物視圖，不能照抄舊定義默默改讀新表（第二階段要切就明寫）", async () => {
  for await (const e of Deno.readDir(MIGRATIONS)) {
    if (!e.name.endsWith(".sql") || e.name <= FILE) continue;
    const text = await Deno.readTextFile(new URL(e.name, MIGRATIONS));
    if (!/CREATE (OR REPLACE )?VIEW politicians_with_elections/.test(text)) continue;
    assert(
      text.includes("politician_offices_derived") || text.includes("#345 第二階段：職稱改讀任期表"),
      `${e.name} 重建了 politicians_with_elections，但 offices 沒有讀 politician_offices_derived——照抄 20261005004300 的「FROM politician_offices o」會變成讀任期表。要切就在註解寫「#345 第二階段：職稱改讀任期表」並更新這支測試`,
    );
  }
});

Deno.test("任期表：九種職位、卸任日與原因成對、現任＝已就任而且卸任日為空", () => {
  const table = between(body, "CREATE TABLE IF NOT EXISTS politician_offices", ");\n");
  for (const t of ["總統副總統", "立法委員", "縣市長", "縣市議員", "鄉鎮市長", "直轄市山地原住民區長", "鄉鎮市民代表", "直轄市山地原住民區民代表", "村里長"]) {
    assert(table.includes(`'${t}'`), `職位少了 ${t}`);
  }
  assertMatch(table, /CHECK \(\(end_date IS NULL\) = \(end_reason IS NULL\)\)/);
  assertMatch(table, /basis TEXT NOT NULL CHECK \(basis IN \('election_result', 'cec_candidates'\)\)/);
  assertMatch(table, /politician_election_id INTEGER REFERENCES politician_elections\(id\) ON DELETE CASCADE/);
  // 兩邊差異的判斷、回填核對都用同一個「現任」定義
  const current = body.match(/o\.end_date IS NULL AND o\.start_date <= CURRENT_DATE/g) ?? [];
  assert(current.length >= 3, `現任的定義（end_date 為空＋已就任）只出現 ${current.length} 次`);
  assertMatch(body, /CREATE POLICY "Public read" ON politician_offices FOR SELECT USING \(true\)/);
});

Deno.test("卸任日只寫已經發生的：屆滿看 < 今天、轉任看新任期已就任", () => {
  assertMatch(closeFn, /o2\.start_date > o\.start_date AND o2\.start_date <= p_today/);
  assertMatch(closeFn, /WHERE o\.scheduled_end_date < p_today\s+OR \(n\.next_start IS NOT NULL AND n\.next_start - 1 < o\.scheduled_end_date\)/);
  assertMatch(closeFn, /WHEN c\.switched THEN 'took_other_office' ELSE 'term_expired'/);
  assertMatch(closeFn, /WHERE o\.end_date IS NULL/);
  // 每日排程
  assertMatch(body, /cron\.schedule\('politician-offices-close-daily', '5 0 \* \* \*', \$\$SELECT politician_offices_close_ended\(\);\$\$\)/);
});

Deno.test("觸發器只認我們標的當選，不自動拿中選會名單長新列", () => {
  assertMatch(trigger, /IF NEW\.election_result = 'elected' THEN/);
  assertEquals(/cec_candidates/.test(trigger), false, "觸發器不碰中選會名單（那是系統比對、不是走流程核過的資料）");
  assertMatch(trigger, /'election_result', '參選紀錄標了當選'/);
  // 落選／退選、或當選被拿掉 → 刪
  assertMatch(trigger, /IF NEW\.election_result IS NOT NULL OR o\.basis = 'election_result' THEN\s+DELETE FROM politician_offices WHERE id = o\.id;/);
  assertMatch(body, /AFTER INSERT OR UPDATE OF election_result, election_type, region_id, politician_id, election_id ON politician_elections/);
  assert(sql.includes("FUNCTION sync_politician_office_from_election()\nRETURNS trigger LANGUAGE plpgsql SECURITY DEFINER") ||
    sql.includes("FUNCTION sync_politician_office_from_election()\r\nRETURNS trigger LANGUAGE plpgsql SECURITY DEFINER"), "觸發器要 SECURITY DEFINER（寫入端不一定有任期表的寫入權）");
  // 每個改動都留紀錄
  const logs = trigger.match(/INSERT INTO edit_history/g) ?? [];
  assertEquals(logs.length, 4, "建、改、刪、改人物或地區各記一筆");
});

Deno.test("任期起訖跟舊視圖同一支函式；年份取投票日，不從選舉 id 推", () => {
  assertMatch(trigger, /SELECT EXTRACT\(YEAR FROM e\.election_date\)::INTEGER INTO v_year FROM elections e WHERE e\.id = NEW\.election_id;/);
  assertMatch(trigger, /v_start := office_term_start\(v_year, NEW\.election_type\);/);
  assertMatch(trigger, /v_end := office_term_end\(v_year, NEW\.election_type\);/);
  assertEquals(/office_term_(start|end)\(NEW\.election_id/.test(trigger), false);
});

Deno.test("回填照舊視圖搬、跟舊視圖對不上整支退回；中選會那條附出處", () => {
  const backfill = between(body, "INSERT INTO politician_offices (politician_id, election_type, region_id, start_date, scheduled_end_date,", "SELECT politician_offices_close_ended(CURRENT_DATE);");
  assertMatch(backfill, /FROM politician_offices_derived d/);
  assertMatch(backfill, /d\.verified_by, c\.cec_theme_id, c\.cec_cand_id/);
  assertMatch(backfill, /WHERE NOT EXISTS \(SELECT 1 FROM politician_offices o WHERE o\.politician_election_id = d\.politician_election_id\)/);
  assertMatch(body, /RAISE EXCEPTION '#345 任期回填跟舊視圖對不上：少 % 列、多 % 列'/);
  // 跨屆都當選的，回填時就把前一個關掉（10-04 裁決：後面那個就任時前一個已經辭掉）
  assert(body.indexOf("SELECT politician_offices_close_ended(CURRENT_DATE);") > body.indexOf("INSERT INTO politician_offices (politician_id"));
});

Deno.test("兩邊差異看 politician_offices_gap：舊視圖每人只取最近一屆（跟網站顯示同一個集合）", () => {
  const gap = between(body, "CREATE OR REPLACE VIEW politician_offices_gap AS", "COMMENT ON VIEW politician_offices_gap");
  assertMatch(gap, /'missing'::TEXT AS gap/);
  assertMatch(gap, /'extra'/);
  const latestOnly = gap.match(/d2\.term_start > d\.term_start/g) ?? [];
  assertEquals(latestOnly.length, 2, "兩個方向都要排掉被後一屆取代的舊視圖列");
  assertMatch(body, /ALTER VIEW politician_offices_gap SET \(security_invoker = on\)/);
});
