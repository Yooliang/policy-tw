// 記錄代理從哪個端點進來（2026-09-21）。
//
// 協議第 0 節寫著「你只要記兩個端點」，但另外還有四個舊端點開著。
// 小良哥的裁示是「派發是唯一的工作來源」，所以 /verifications 這種可以自己挑的要退場。
// 退場之前要看得到還有誰在用——直接斷線會斷掉不知道是誰的線。
//
// 這支守的是「分得出來」：兩個端點都寫同一個 via 的話，這張表就什麼都答不出來。
import { assert, assertEquals } from "jsr:@std/assert@1";

async function src(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, import.meta.url));
}

Deno.test("每一個寫入端點都標自己的名字，而且彼此不同——標一樣就分不出誰在用", async () => {
  const seen = new Map<string, string>();
  for (const [file, expected] of [
    ["../report/index.ts", "report"],
    ["../contribute/index.ts", "contribute"],
    ["../verify/index.ts", "verify"],
  ] as const) {
    const code = await src(file);
    // report 明確傳；contribute／verify 用 handler 的預設值
    const passes = code.includes(`"${expected}"`) ||
      (!code.includes('handleContribute(supabase, supabaseUrl, body, ipHash, undefined,') &&
       !code.includes('handleVerify(supabase, body, ipHash, undefined,'));
    assert(passes, `${file} 沒有標成 ${expected}`);
    assert(!seen.has(expected), `${expected} 被兩個端點用了`);
    seen.set(expected, file);
  }
  assertEquals(seen.size, 3);
});

Deno.test("handler 的預設值就是舊端點的名字——舊端點不必改也標得對", async () => {
  const c = await src("./contribute-handler.ts");
  const v = await src("./verify-handler.ts");
  assert(c.includes('via = "contribute"'), "handleContribute 的預設 via 要是 contribute");
  assert(v.includes('via = "verify"'), "handleVerify 的預設 via 要是 verify");
});

Deno.test("via 真的被寫進資料列，不是收了就丟", async () => {
  const c = await src("./contribute-handler.ts");
  const v = await src("./verify-handler.ts");
  // 插入的物件字面值裡要有 via
  assert(/payload_hash: hash,\s*\n\s*\/\/[^\n]*\n\s*via,/.test(c), "contributions 的插入要帶 via");
  assert(/resolved_politician_id: input\.resolved_politician_id \?\? null,\s*\n\s*\/\/[^\n]*\n\s*via,/.test(v), "contribution_votes 的插入要帶 via");
});

Deno.test("DB 有 via 欄位與 endpoint_usage 檢視表——收掉舊端點之前要看得出誰在用", async () => {
  const dir = new URL("../../migrations/", import.meta.url);
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  let sql = "";
  for (const n of names.sort()) sql += await Deno.readTextFile(new URL(n, dir));
  assert(sql.includes("ALTER TABLE contributions ADD COLUMN IF NOT EXISTS via"), "contributions 缺 via 欄位");
  assert(sql.includes("ALTER TABLE contribution_votes ADD COLUMN IF NOT EXISTS via"), "contribution_votes 缺 via 欄位");
  assert(sql.includes("CREATE OR REPLACE VIEW endpoint_usage"), "缺 endpoint_usage 檢視表");
});
