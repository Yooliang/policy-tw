/**
 * 系統票標籤 Jev → SystemOne 守門（migration 20261111240000）。
 * 前端 ModelQualityPanel 呼叫的是 model_vote_stats(p_days INTEGER)，不是區間版；漏掉哪個簽名，畫面上就還是舊字樣。
 * 這裡沒有資料庫，只守：每個會輸出系統票標籤的函式簽名都在這支 migration 重貼過、且只剩新標籤＋新舊都認的比對。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const sql = await read("20261111240000_system_vote_label_systemone.sql");

const HEADS = [
  "CREATE OR REPLACE FUNCTION model_vote_stats(p_days INTEGER DEFAULT 14)",
  "CREATE OR REPLACE FUNCTION model_vote_stats(p_since TIMESTAMPTZ, p_until TIMESTAMPTZ)",
  "CREATE OR REPLACE FUNCTION model_flow_stats(p_days INTEGER DEFAULT 14)",
  "CREATE OR REPLACE FUNCTION model_flow_paths(p_days INTEGER DEFAULT 14)",
  "CREATE OR REPLACE FUNCTION policy_jp.model_vote_stats(p_since TIMESTAMPTZ, p_until TIMESTAMPTZ)",
];

function bodyOf(head: string): string {
  const a = sql.indexOf(head);
  assert(a >= 0, `找不到 ${head}`);
  const b = sql.indexOf("\n$$;", a);
  assert(b > a, `${head} 沒有結尾`);
  return sql.slice(a, b);
}

Deno.test("五個簽名都重貼，各自標籤只剩新字串、比對新舊都認", () => {
  for (const h of HEADS) {
    const t = bodyOf(h);
    assert(t.includes("IN ('Jev（系統）', 'SystemOne（系統）') THEN '系統票（SystemOne）'"), `${h}：比對或輸出標籤不對`);
    assert(!t.includes("THEN '系統票（Jev）'"), `${h}：還會輸出舊標籤`);
  }
});

Deno.test("model_vote_stats(INTEGER)（前端 /stats 用的）沒被漏掉，而且只有一份", () => {
  assertEquals(sql.split("FUNCTION model_vote_stats(p_days INTEGER").length - 1, 1);
});

Deno.test("日本站沒有 (p_days) 版：不需要跟", async () => {
  assert(!/FUNCTION policy_jp\.model_\w+\(p_days/.test(sql));
  assert(!/FUNCTION policy_jp\.model_vote_stats\(p_days/.test(await read("20261009200000_policy_jp_public_stats.sql")));
});

Deno.test("這支 migration 的程式碼（註解除外）不輸出舊標籤", () => {
  const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  assert(!code.includes("THEN '系統票（Jev）'"));
});
