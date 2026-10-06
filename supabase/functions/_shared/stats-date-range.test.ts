/**
 * 統計 RPC 的「日期區間」多載守門測試（migration 20261007160000；站務主控台要台灣日曆日精確區間）。
 *
 * 這裡沒有資料庫。SQL 本身在 PGlite 上實跑驗過（見 PR 說明：舊呼叫結果逐位元相同、昨日／今日／近 7／30 日區間正確）；
 * 這支守住「改壞了不會報錯」的幾件事：
 *   1. 只加不改：新 migration 不 DROP、不 ALTER 既有函式，只新增四個 (p_since, p_until) 多載
 *   2. 兩個參數都沒有預設值——有預設值會讓 f(7)、contribution_feed_summary 裡的 contribution_leaderboard(NULL) 變成「不唯一」而整支掛掉
 *   3. SECURITY DEFINER＋固定 search_path＋anon／authenticated 授權（匿名呼叫少了它只拿到 0 列）
 *   4. 新多載的本體跟舊 (p_days) 版逐字相同，只有「時間窗」那一句不同——兩份以後不會悄悄漂開
 */
import { assert, assertEquals } from "jsr:@std/assert@1";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const FILE = "20261007160000_stats_date_range.sql";
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const sql = await read(FILE);
const code = sql.replace(/--[^\n]*/g, "");

const NEW_SIG = "(p_since TIMESTAMPTZ, p_until TIMESTAMPTZ)";
const FUNCS = ["contribution_leaderboard", "model_contribution_stats", "model_vote_stats", "ai_reads_summary"];

/** 從 CREATE OR REPLACE FUNCTION name(...) 到結尾的 $$; */
function definition(text: string, header: string): string {
  const i = text.indexOf(header);
  assert(i >= 0, `找不到「${header}」`);
  const j = text.indexOf("\n$$;", i);
  assert(j >= 0, `「${header}」之後找不到 $$;`);
  return text.slice(i, j + 4);
}

/**
 * RETURNS（含回傳欄位，免得悄悄多出欄位）加上 AS $$ 之後的本體。
 * 中間的屬性（STABLE、SECURITY DEFINER…）舊版是另一支 migration 用 ALTER 補的，寫法不同，由上面的測試另外守。
 */
function normalized(def: string): string {
  const r = def.indexOf("RETURNS");
  const l = def.indexOf("LANGUAGE", r);
  const b = def.indexOf("AS $$", l);
  assert(r >= 0 && l > r && b > l, "函式定義格式變了，守門測試的正規化要跟著改");
  return (def.slice(r, l) + def.slice(b))
    // 時間窗：舊版與新版各自的那一句，統一換成記號
    .replace(/^since AS \(SELECT CASE WHEN p_days IS NULL[^\n]*\n/m, "")
    .replace(/^[ \t]*WHERE \(SELECT ts FROM since\) IS NULL OR created_at >= \(SELECT ts FROM since\)\n/gm, "  <WINDOW>\n")
    .replace(/^[ \t]*WHERE \(p_since IS NULL OR created_at >= p_since\) AND \(p_until IS NULL OR created_at < p_until\)\n/gm, "  <WINDOW>\n")
    .replace(/^[ \t]*WHERE [cv]\.created_at > now\(\)[^\n]*\n/gm, "     <WINDOW>\n")
    .replace(/^[ \t]*WHERE [cv]\.created_at >= GREATEST[^\n]*\n[ \t]*AND \(p_until IS NULL OR [cv]\.created_at < p_until\)\n/gm, "     <WINDOW>\n")
    .replace(/^[ \t]*WHERE r\.day > [^\n]*\n/gm, "   <WINDOW>\n")
    .replace(/^[ \t]*WHERE r\.day >= GREATEST[^\n]*\n[ \t]*AND \(p_until IS NULL OR r\.day <=[^\n]*\n/gm, "   <WINDOW>\n")
    .replace(/\s+/g, " ")
    .trim();
}

Deno.test("只加不改：不 DROP、不 ALTER、不改舊函式；只新增四個區間多載", () => {
  assert(!/\bDROP\s+FUNCTION\b/i.test(code), "不可以 DROP FUNCTION（改簽名要分兩次上）");
  assert(!/\bALTER\s+FUNCTION\b/i.test(code), "不可以 ALTER 既有函式");
  assert(!/\b(DROP|ALTER)\s+(TABLE|COLUMN)\b/i.test(code), "不動表");
  const created = [...code.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)\s*\(([^)]*)\)/gi)].map((m) => `${m[1]}(${m[2].replace(/\s+/g, " ").trim()})`);
  assertEquals(created.sort(), FUNCS.map((f) => `${f}${NEW_SIG}`).sort());
});

Deno.test("新簽名兩個參數都沒有預設值（有預設值會讓舊呼叫變成「不唯一」）", () => {
  assert(!/p_since\s+TIMESTAMPTZ\s+DEFAULT/i.test(code), "p_since 不可以有 DEFAULT");
  assert(!/p_until\s+TIMESTAMPTZ\s+DEFAULT/i.test(code), "p_until 不可以有 DEFAULT");
});

Deno.test("四個新多載：SECURITY DEFINER、固定 search_path、anon／authenticated 可執行", () => {
  for (const f of FUNCS) {
    const def = definition(sql, `CREATE OR REPLACE FUNCTION ${f}${NEW_SIG}`);
    assert(/SECURITY DEFINER/.test(def), `${f} 要 SECURITY DEFINER，不然匿名呼叫拿到的都是 0`);
    assert(/SET search_path = public/.test(def), `${f} 要固定 search_path`);
    assert(/\bSTABLE\b/.test(def), `${f} 要 STABLE`);
    assert(
      new RegExp(`GRANT EXECUTE ON FUNCTION ${f}\\(TIMESTAMPTZ, TIMESTAMPTZ\\) TO anon, authenticated`).test(code),
      `${f} 要授權 anon、authenticated`,
    );
  }
});

Deno.test("新多載的本體跟舊 (p_days) 版相同，只有時間窗那一句不同", async () => {
  const lb = await read("20260917000012_feed_summary_in_sql.sql");
  const mq = await read("20261003000003_model_quality_stats.sql");
  const ar = await read("20260924000009_stats_ranges.sql");
  const pairs: [string, string][] = [
    ["contribution_leaderboard", definition(lb, "CREATE OR REPLACE FUNCTION contribution_leaderboard(p_days INTEGER)")],
    ["model_contribution_stats", definition(mq, "CREATE OR REPLACE FUNCTION model_contribution_stats(p_days INTEGER DEFAULT 14)")],
    ["model_vote_stats", definition(mq, "CREATE OR REPLACE FUNCTION model_vote_stats(p_days INTEGER DEFAULT 14)")],
    ["ai_reads_summary", definition(ar, "CREATE OR REPLACE FUNCTION ai_reads_summary(p_days INTEGER DEFAULT 7)")],
  ];
  for (const [f, oldDef] of pairs) {
    const newDef = definition(sql, `CREATE OR REPLACE FUNCTION ${f}${NEW_SIG}`);
    const a = normalized(oldDef);
    const b = normalized(newDef);
    assert(a.includes("<WINDOW>") && b.includes("<WINDOW>"), `${f}：找不到時間窗那一句，守門測試的正規化要跟著改`);
    assertEquals(b, a, `${f}：新多載的本體跟舊版漂開了（除了時間窗以外都該一樣）`);
  }
});
