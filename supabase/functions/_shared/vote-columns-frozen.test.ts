/**
 * 得票數、得票率停止寫入（#345 第一階段；第二階段刪欄）。
 *
 * 站上不顯示票數、不排名次，留著沒人用的欄位遲早被誤用。第一階段只做「不再寫」：
 * 這支掃所有 Edge Function 原始碼，任何把 votes_received／vote_percentage 當成物件欄位寫出去的地方都會紅。
 * 例外只有中選會資料的形狀（_shared/cec-candidate.ts：中選會 API 回的逐位得票，fetch-cec-data 給代理看，不寫進我們的表）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";

const ROOT = new URL("../", import.meta.url);
const ALLOWED = new Set(["_shared/cec-candidate.ts"]);

async function* walk(dir: URL, prefix = ""): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const rel = prefix + e.name;
    if (e.isDirectory) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      yield* walk(new URL(e.name + "/", dir), rel + "/");
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      yield rel;
    }
  }
}

Deno.test("Edge Function 不再寫 votes_received／vote_percentage（#345）", async () => {
  const hits: string[] = [];
  let scanned = 0;
  for await (const rel of walk(ROOT)) {
    scanned++;
    if (ALLOWED.has(rel)) continue;
    const lines = (await Deno.readTextFile(new URL(rel, ROOT))).split(/\r?\n/);
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      // 物件欄位（寫入 payload／patch）或 .update／.insert 裡的 key
      if (/\b(votes_received|vote_percentage)\s*:/.test(code) || /["'](votes_received|vote_percentage)["']\s*:/.test(code)) {
        hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert(scanned > 100, `只掃到 ${scanned} 支檔案，路徑可能錯了`);
  assertEquals(hits, [], "這些地方還在寫票數欄位（#345 第一階段停止寫入）");
});
