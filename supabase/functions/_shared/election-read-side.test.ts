/**
 * #344 第二階段 A 的 migration（20261007030000_election_read_side.sql）守門。
 *
 * SQL 本身在 PGlite（WASM Postgres）實跑過（見 PR 說明：骨架＋線上三筆選舉與嘉義市資料，34 條斷言，核對的還原驗證 8 種弄壞方式全部退回）；
 * 這裡沒有資料庫，守住「改掉就會出錯、而且不會報錯」的條件：
 *   1. 不刪任何欄位或表、不改函式簽名（第二階段 A 只加不刪；刪的是 B）
 *   2. 「最新一屆」與 offices 的排序看投票日，不看 id
 *   3. 任期同步觸發器吃選舉本身（election_term_start／end），不把 election_id 當年份
 *   4. 嘉義市重行選舉的拆分：鍵、事由、職位、移動的範圍、可倒回的履歷
 *   5. 兩段核對（改函式之後、拆嘉義市之後）都在，而且是 RAISE EXCEPTION
 *   6. 補選、重行選舉的 cec-sync 排程
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const FILE = "20261007030000_election_read_side.sql";
const sql = (await Deno.readTextFile(new URL(FILE, MIGRATIONS))).replace(/\r\n/g, "\n");
/** 去掉 SQL 註解 */
const code = (s: string) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const body = code(sql);
function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  assert(i >= 0, `找不到「${start}」`);
  const j = text.indexOf(end, i + start.length);
  assert(j >= 0, `找不到「${end}」`);
  return text.slice(i, j);
}

/** 取兩個標記之間的片段（用含註解的原文找標記），再去掉註解 */
const section = (start: string, end: string): string => code(between(sql, start, end));

Deno.test("只加不刪：沒有 DROP COLUMN／DROP TABLE／刪視圖、沒有改欄位名或型別", () => {
  assertEquals(/DROP\s+(COLUMN|TABLE|VIEW|FUNCTION)\b/i.test(body.replace(/DROP TABLE IF EXISTS e344_old_(latest|offices);/g, "")), false);
  assertEquals(/ALTER\s+TABLE[^;]*(DROP|RENAME|ALTER\s+COLUMN)/i.test(body), false);
  // 函式簽名不變：舊的三支照舊簽名 CREATE OR REPLACE；新增的另取新名字
  assertMatch(body, /CREATE OR REPLACE FUNCTION politician_latest_election\(p_politician_id uuid\)\s*RETURNS TABLE\(election_id integer, candidate_status text, "position" text, slogan text, election_type text, region_id integer\)/);
  assertMatch(body, /CREATE OR REPLACE FUNCTION task_boost_matches\(p_filter jsonb\)\s*RETURNS TABLE\(task_id text, kind text\)/);
  assertMatch(body, /CREATE OR REPLACE FUNCTION politician_bulletins_for\(p_politician_id uuid\)/);
  assertEquals(/CREATE OR REPLACE FUNCTION (office_term_start|office_term_end|year_or_null)\b/.test(body), false, "舊函式不動（簽名與行為都留著）");
});

Deno.test("最新一屆與 offices 排序看投票日，不看 id", () => {
  const latest = section("CREATE OR REPLACE FUNCTION politician_latest_election", "CREATE OR REPLACE FUNCTION politician_bulletins_for");
  assertMatch(latest, /JOIN elections e ON e\.id = pe\.election_id/);
  assertMatch(latest, /ORDER BY \(COALESCE\(pe\.candidacy_status, ''\) = 'withdrawn'\), e\.election_date DESC, pe\.election_id DESC/);
  const bulletins = section("CREATE OR REPLACE FUNCTION politician_bulletins_for", "-- offices 陣列的排序");
  assertMatch(bulletins, /ORDER BY e\.election_date DESC, b\.election_id DESC/);
  const view = section("CREATE OR REPLACE VIEW politicians_with_elections", "ALTER VIEW politicians_with_elections");
  assertMatch(view, /ORDER BY oe\.election_date DESC, o\.election_id DESC/);
  assertEquals(/ORDER BY o\.election_id DESC\)/.test(view), false, "不能退回只看 id");
  assertMatch(sql, /ALTER VIEW politicians_with_elections SET \(security_invoker = on\);/);
});

Deno.test("任期起訖：吃 elections.id，看投票日與事由；任期觸發器用它、不再自己從 election_id 推年份", () => {
  const start = section("CREATE OR REPLACE FUNCTION election_term_start", "CREATE OR REPLACE FUNCTION election_term_end");
  assertMatch(start, /WHEN 'by_election' THEN e\.election_date/);
  assertMatch(start, /WHEN 'recall' THEN NULL/);
  assertMatch(start, /ELSE office_term_start\(EXTRACT\(YEAR FROM e\.election_date\)::INTEGER, p_election_type\)/);
  const end = section("CREATE OR REPLACE FUNCTION election_term_end", "GRANT EXECUTE ON FUNCTION election_term_start");
  assertMatch(end, /ELSE office_term_end\(EXTRACT\(YEAR FROM e\.election_date\)::INTEGER, p_election_type\)/);
  assertMatch(end, /總統副總統', '立法委員'\) THEN 2024 ELSE 2022/, "補選：總統與立委 2024 起每四年、地方 2022 起每四年");
  const trigger = section("CREATE OR REPLACE FUNCTION sync_politician_office_from_election()", "COMMENT ON FUNCTION sync_politician_office_from_election");
  assertMatch(trigger, /v_start := election_term_start\(NEW\.election_id, NEW\.election_type\);/);
  assertMatch(trigger, /v_end := election_term_end\(NEW\.election_id, NEW\.election_type\);/);
  assertEquals(/office_term_(start|end)\(v_year/.test(trigger), false, "不再用 v_year（從 election_id／日期推的年份）");
  assertMatch(trigger, /v_start IS NULL OR v_end IS NULL/, "罷免投票不選人：算不出任期就不建");
});

Deno.test("插隊篩選：election_id 吃任何正整數，不再要求四位數年份", () => {
  const fn = section("CREATE OR REPLACE FUNCTION election_id_or_null", "CREATE OR REPLACE FUNCTION task_boost_matches");
  assertMatch(fn, /\^\\d\{1,9\}\$/);
  const boost = section("CREATE OR REPLACE FUNCTION task_boost_matches", "-- ── 核對一");
  assertEquals(/year_or_null\(/.test(boost), false, "task_boost_matches 不能再用 year_or_null");
  assertEquals((boost.match(/election_id_or_null\(/g) ?? []).length, 3, "三處（自動缺口、手動任務、待驗證）");
});

Deno.test("嘉義市 2022 縣市長重行選舉：鍵、事由、職位、搬的範圍、履歷", () => {
  const split = section("-- ── ④ 嘉義市 2022", "-- ── 核對二");
  assertMatch(split, /'2022-12-18_rerun_10020'/);
  assertMatch(split, /'rerun', ARRAY\['縣市長'\]/);
  assertMatch(split, /DATE '2022-12-18'/);
  // 只搬嘉義市的縣市長、而且只搬 2022 底下的
  assertMatch(split, /r\.region = '嘉義市' AND pe\.election_id = 2022 AND pe\.election_type = '縣市長'/);
  assertMatch(split, /UPDATE election_districts SET election_id = v_id\s+WHERE election_id = 2022 AND election_type = '縣市長' AND region = '嘉義市'/);
  assertMatch(split, /UPDATE cec_candidates SET election_id = v_id\s+WHERE election_id = 2022 AND election_type = '縣市長' AND region = '嘉義市'/);
  // 每一筆移動都留可倒回的履歷
  assertEquals((split.match(/'election-split-344'/g) ?? []).length, 2, "參選紀錄、選舉區各一組");
  assertMatch(split, /to_jsonb\(2022\), to_jsonb\(v_id\)/);
  // 不動政見（可能是議員等其他選舉的），只告知
  assertEquals(/UPDATE policies/i.test(split), false);
  // 冪等：拆過就略過
  assertMatch(split, /IF EXISTS \(SELECT 1 FROM elections WHERE election_key = '2022-12-18_rerun_10020'\) THEN/);
});

Deno.test("兩段核對都在、都是 RAISE EXCEPTION（對不上整支退回）", () => {
  const snap = section("CREATE TEMP TABLE e344_old_latest", "-- ── ① 任期起訖");
  assertMatch(snap, /politician_latest_election\(p\.id\)/);
  assertMatch(snap, /politicians_with_elections v/);
  const one = section("-- ── 核對一", "-- ── ④ 嘉義市");
  for (const needle of ["politician_latest_election 改看投票日後", "politicians_with_elections.offices 改看投票日排序後", "election_term_start／end 算出的任期跟現存", "election_term_start／end 跟舊的年份算法"]) {
    assert(one.includes(needle), `核對一少了「${needle}」`);
  }
  assertEquals((one.match(/RAISE EXCEPTION/g) ?? []).length >= 5, true);
  const two = section("-- ── 核對二", "-- ── ⑥");
  for (const needle of ["嘉義市重行選舉沒有建出來", "elections 現在應該是 4 筆", "底下還有", "不在移動名單上的人最新一屆變了", "現任公職陣列變了", "有任期掛在 2022 嘉義市縣市長上"]) {
    assert(two.includes(needle), `核對二少了「${needle}」`);
  }
});

Deno.test("補選、重行選舉的 cec-sync 排程：逐場逐職位、只打已投票的", () => {
  const cron = section("SELECT cron.schedule('cec-sync-offcycle-weekly'", "NOTIFY pgrst");
  assertMatch(cron, /'45 19 \* \* 6'/);
  assertMatch(cron, /jsonb_build_object\('election_id', e\.id, 'election_type', t\)/);
  assertMatch(cron, /e\.election_reason IN \('by_election', 'rerun'\) AND e\.election_date <= CURRENT_DATE/);
  assertMatch(body, /cron\.unschedule\('cec-sync-offcycle-weekly'\) WHERE EXISTS/);
});

Deno.test("2022 九合一的每週排程仍用 election_id=2022（嘉義市重行選舉不在其中，由 offcycle 排程接）", async () => {
  const text = (await Deno.readTextFile(new URL("20261005004000_cec_sync_rest_calls.sql", MIGRATIONS))).replace(/\r\n/g, "\n");
  assertMatch(text, /jsonb_build_object\('election_id', 2022, 'election_type', t\)/);
});
