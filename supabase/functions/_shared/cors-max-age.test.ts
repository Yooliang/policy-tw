// 守門：所有 Edge Function 的 CORS 預檢（OPTIONS）回應都要帶 Access-Control-Max-Age: 7200。
// 理由（2026-11-27）：沒設 Max-Age 時瀏覽器每次都重發預檢，OPTIONS 佔閘道請求 16%、函式呼叫 13%。
// 做法：掃每支函式入口與 _shared 裡處理 OPTIONS 的檔案，OPTIONS 那一段回應必須含 Max-Age 7200，
// 且不能改動 Allow-Origin／Allow-Headers。新增函式照抄既有寫法即可通過。
import { assert, assertEquals } from "jsr:@std/assert@1";

const FUNCTIONS_DIR = new URL("../", import.meta.url);
const MAX_AGE = `"Access-Control-Max-Age": "7200"`;

async function sourcesWithPreflight(): Promise<{ path: string; src: string }[]> {
  const out: { path: string; src: string }[] = [];
  const visit = async (dir: URL) => {
    for await (const e of Deno.readDir(dir)) {
      if (e.name === "node_modules") continue;
      const child = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
      if (e.isDirectory) {
        await visit(child);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
        const src = await Deno.readTextFile(child);
        if (/req\.method === "OPTIONS"/.test(src)) out.push({ path: child.pathname, src });
      }
    }
  };
  await visit(FUNCTIONS_DIR);
  return out;
}

Deno.test("CORS 預檢：每個 OPTIONS 回應都帶 Access-Control-Max-Age 7200", async () => {
  const files = await sourcesWithPreflight();
  assert(files.length >= 30, `預期至少 30 個預檢處理檔，只找到 ${files.length}`);
  for (const { path, src } of files) {
    // 取 OPTIONS 判斷式起算的下一個 return（console-admin-handler 走 corsPreflight()，檢查該函式本體）
    const idx = src.indexOf('req.method === "OPTIONS"');
    const window = src.slice(idx, idx + 400);
    if (window.includes("corsPreflight()")) {
      const fn = src.slice(src.indexOf("export function corsPreflight"));
      assert(fn.slice(0, 300).includes(MAX_AGE), `${path} 的 corsPreflight 缺 Max-Age 7200`);
    } else {
      assert(window.includes(MAX_AGE), `${path} 的 OPTIONS 回應缺 Max-Age 7200`);
    }
  }
});

Deno.test("CORS 預檢：沒有任何檔案把 Max-Age 放進一般回應的共用標頭", async () => {
  // Max-Age 只屬於預檢；共用的 corsHeaders／CORS 常數不該含它，否則每個回應都多帶。
  const files = await sourcesWithPreflight();
  for (const { path, src } of files) {
    const m = src.match(/const (corsHeaders|CORS) = \{[^}]*\}/s);
    if (m) assertEquals(m[0].includes("Max-Age"), false, `${path} 的共用標頭不該含 Max-Age`);
  }
});
