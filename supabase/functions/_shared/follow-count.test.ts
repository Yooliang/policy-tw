import { assert } from "jsr:@std/assert@1";

// 關注數＝把政見加進⭐的登入帳號數（user_checkpoints，2026-09-18）。
// 下面兩件事出錯時都不會報錯，只會讓卡片上的數字默默不對，所以盯住。

/** 同一支函式可能被好幾支 migration 重定義，取檔名排序最後一支 */
async function latestDefinition(fnName: string): Promise<string> {
  const dir = new URL("../../migrations/", import.meta.url);
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  let latest = "";
  for (const name of names.sort()) {
    const sql = await Deno.readTextFile(new URL(name, dir));
    const i = sql.indexOf(`CREATE OR REPLACE FUNCTION ${fnName}`);
    if (i >= 0) latest = sql.slice(i, sql.indexOf("$$;", i));
  }
  if (!latest) throw new Error(`找不到 ${fnName} 的定義`);
  return latest;
}

Deno.test("表態同步不再寫 stance_priority：那一欄是關注數，兩支 trigger 寫同一欄會互相蓋掉", async () => {
  const sql = await latestDefinition("policy_stances_sync");
  assert(!sql.includes("stance_priority"), "最新的 policy_stances_sync 還在寫 stance_priority");
});

Deno.test("關注數的 trigger 要以定義者身分執行：user_checkpoints 是登入者直接寫的，policies 對他只能讀", async () => {
  const sql = await latestDefinition("user_checkpoints_follow_sync");
  assert(sql.includes("stance_priority") && sql.includes("user_checkpoints"), "關注數要從 user_checkpoints 算");
  assert(/SECURITY DEFINER/.test(sql), "少了 SECURITY DEFINER：登入者按⭐時 UPDATE policies 會被 RLS 擋下，數字永遠不動");
  assert(/search_path\s*=\s*public/.test(sql), "SECURITY DEFINER 要固定 search_path");
});
