/**
 * 貢獻榜的測試代號排除清單搬到表 excluded_agents（盤點 #5，2026-10-07 維護者同意；migration 20261008000010）。
 *
 * 起因：名單寫死在三支 SQL 函式（contribution_leaderboard 天數版與區間版、contribution_feed_summary）與 TS 各一份，
 * 每個新測試代號要改四處；貢獻榜是公開頁，漏一個就是榜被測試帳號污染。
 *
 * 守的事：
 *   1. 三支函式「現行」那一版都讀 excluded_agents，函式本體裡不再有寫死的代號
 *   2. 種子（所有 migration 對 excluded_agents 的 INSERT／DELETE 疊起來）＝TS 參考實作的預設 EXCLUDED_AGENTS（原本寫死的 10 個，一個不多一個不少）
 *   3. 表的形狀：代號是主鍵、有理由、RLS 公開讀、只有 service_role 能寫
 *   4. TS 參考實作可以注入名單（線上走 SQL，名單由表來）
 * SQL 另外在正式庫唯讀實跑：新舊兩版對 7 種視窗（總榜、30／7 天、三個區間、整份統計）輸出雜湊相同（見 PR 說明）。
 */
import { assert, assertEquals, assertMatch, assertNotMatch } from "jsr:@std/assert@1";
import { buildFeedSummary, buildLeaderboard, EXCLUDED_AGENTS } from "./contribution-summary.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const MIG = "20261008000010_excluded_agents.sql";

async function migrations(): Promise<Array<{ name: string; sql: string }>> {
  const out: Array<{ name: string; sql: string }> = [];
  for await (const e of Deno.readDir(MIGRATIONS)) {
    if (e.isFile && e.name.endsWith(".sql")) out.push({ name: e.name, sql: (await Deno.readTextFile(new URL(e.name, MIGRATIONS))).replace(/\r/g, "") });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 某個函式（signature 開頭）「現行」的定義：掃所有 migration，取最後一次 CREATE OR REPLACE FUNCTION 到結尾的 $$; */
async function latestDef(nameAndArgs: string): Promise<{ file: string; def: string }> {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION (?:public\\.)?${nameAndArgs}`);
  let found: { file: string; def: string } | null = null;
  for (const m of await migrations()) {
    let from = 0;
    for (;;) {
      const i = m.sql.slice(from).search(re);
      if (i < 0) break;
      const start = from + i;
      const end = m.sql.indexOf("\n$$;", start);
      assert(end > 0, `${m.name}：找不到 ${nameAndArgs} 的結尾`);
      found = { file: m.name, def: m.sql.slice(start, end + 4) };
      from = end + 4;
    }
  }
  if (!found) throw new Error(`找不到 ${nameAndArgs}`);
  return found;
}

Deno.test("三支統計函式（現行版）都讀 excluded_agents，本體裡沒有寫死的測試代號", async () => {
  for (const sig of ["contribution_leaderboard\\(p_days", "contribution_leaderboard\\(p_since", "contribution_feed_summary\\("]) {
    const { file, def } = await latestDef(sig);
    assert(file >= MIG, `${sig} 現行版在 ${file}，應該是 ${MIG} 或更新（還在讀寫死的名單）`);
    assertMatch(def, /excluded AS \(\s*(?:--[^\n]*\n\s*)?SELECT agent_name FROM excluded_agents\s*\)/, `${sig}：excluded 要讀 excluded_agents`);
    assertNotMatch(def, /'test-(deepseek|claude|gemini)|'xiaoliang-/, `${sig}：函式裡又寫死了測試代號`);
    assertNotMatch(def, /unnest\(ARRAY\[/, `${sig}：不要再用 ARRAY 寫死名單`);
    // 其餘規則照舊
    assert(def.includes("SECURITY DEFINER"), `${sig}：要 SECURITY DEFINER（匿名呼叫不然只拿到 0）`);
    assertMatch(def, /search_path\s*(=|TO)\s*'?public'?/, `${sig}：SECURITY DEFINER 要固定 search_path`);
  }
});

Deno.test("種子＝原本寫死的 10 個代號：所有 migration 對 excluded_agents 的 INSERT／DELETE 疊起來，等於 TS 參考實作的預設", async () => {
  const names = new Set<string>();
  for (const m of await migrations()) {
    for (const ins of m.sql.matchAll(/INSERT INTO excluded_agents\s*\([^)]*\)\s*VALUES([\s\S]*?)(?:ON CONFLICT[^;]*)?;/g)) {
      for (const row of ins[1].matchAll(/^\s*\(\s*'([^']+)'/gm)) names.add(row[1]);
    }
    for (const del of m.sql.matchAll(/DELETE FROM excluded_agents WHERE agent_name\s*=\s*'([^']+)'/g)) names.delete(del[1]);
  }
  assertEquals([...names].sort(), [...EXCLUDED_AGENTS].sort());
  assertEquals(names.size, 10, "原本寫死的是 10 個；之後新增請走 INSERT INTO excluded_agents（並同步 TS 預設與這個數字）");
  // 舊的 10 個逐字（拿掉任何一個＝榜上多一個測試帳號）
  for (const n of ["test-deepseek", "test-deepseek-1", "test-deepseek-2", "test-deepseek-3", "test-deepseek-4", "test-deepseek-5", "test-claude", "test-gemini", "xiaoliang-roster", "xiaoliang-probe"]) {
    assert(names.has(n), n);
  }
});

Deno.test("表的形狀：代號是主鍵且不含前後空白、有理由、RLS 公開讀、只有 service_role 能寫", async () => {
  const sql = (await Deno.readTextFile(new URL(MIG, MIGRATIONS))).replace(/\r/g, "");
  const table = /CREATE TABLE IF NOT EXISTS excluded_agents \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? "";
  assertMatch(table, /agent_name TEXT PRIMARY KEY CHECK \(agent_name = btrim\(agent_name\) AND agent_name <> ''\)/);
  assertMatch(table, /reason TEXT NOT NULL/);
  assertMatch(table, /added_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
  assert(sql.includes("ALTER TABLE excluded_agents ENABLE ROW LEVEL SECURITY;"));
  assertMatch(sql, /CREATE POLICY "Public read" ON excluded_agents FOR SELECT USING \(true\);/);
  assertMatch(sql, /CREATE POLICY "Service role write" ON excluded_agents FOR ALL USING \(auth\.role\(\) = 'service_role'\);/);
  assert(sql.includes("GRANT SELECT ON excluded_agents TO anon, authenticated;"));
  assertNotMatch(sql, /GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*excluded_agents[^;]*(anon|authenticated)/, "匿名與登入者不能寫");
  // 種子逐列有理由
  const rows = [...sql.matchAll(/^\s*\('([^']+)',\s*'([^']+)',\s*TIMESTAMPTZ '[^']+'\)/gm)];
  assertEquals(rows.length, 10);
  for (const r of rows) assert(r[2].length > 0, r[1]);
});

Deno.test("TS 參考實作可以注入排除名單（線上名單來自表）：注入的生效、預設不再硬套", () => {
  const now = Date.parse("2026-10-07T12:00:00+08:00");
  const at = new Date(now - 3600_000).toISOString();
  const rows = [
    { status: "applied", agent_name: "real-agent", created_at: at },
    { status: "applied", agent_name: "test-claude", created_at: at },
    { status: "applied", agent_name: "new-probe", created_at: at },
  ];
  const byDefault = buildFeedSummary(rows, [], now);
  assertEquals(byDefault.leaderboard.map((r) => r.agent_name).sort(), ["new-probe", "real-agent"], "預設只排除種子裡的代號");
  const fromTable = new Set([...EXCLUDED_AGENTS, "new-probe"]);
  const injected = buildFeedSummary(rows, [], now, 0, fromTable);
  assertEquals(injected.leaderboard.map((r) => r.agent_name), ["real-agent"]);
  assertEquals(injected.contributors_total, 1);
  assertEquals(injected.contributors_30d, 1);
  assertEquals(buildLeaderboard(rows, [], 7, now, fromTable).map((r) => r.agent_name), ["real-agent"]);
  assertEquals(buildLeaderboard(rows, [], null, now, new Set()).length, 3, "名單空的就誰都不排除");
});
