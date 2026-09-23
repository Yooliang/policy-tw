import { assert } from "jsr:@std/assert";

// 2026-09-23：contribution_votes.resolved_politician_id 是 TEXT（要能存 "new"），merge_politician 直接跟 UUID 參數比
// → text = uuid 報錯，全站合併從來沒有落庫成功過。守住最新那份定義一定有轉型。
Deno.test("merge_politician 比對票的指認欄位時要轉成 TEXT", async () => {
  const dir = new URL("../../migrations/", import.meta.url);
  const files: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.name.endsWith(".sql")) files.push(e.name);
  files.sort();
  let latest = "";
  for (const f of files) {
    const s = await Deno.readTextFile(new URL(f, dir));
    const i = s.indexOf("CREATE OR REPLACE FUNCTION merge_politician(");
    if (i >= 0) latest = s.slice(i);
  }
  assert(latest, "找不到 merge_politician 的定義");
  assert(latest.includes("resolved_politician_id = p_remove::TEXT"), "WHERE 要把 UUID 轉 TEXT");
  assert(latest.includes("SET resolved_politician_id = p_keep::TEXT"), "SET 要把 UUID 轉 TEXT");
});
