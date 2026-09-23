#!/usr/bin/env node
/**
 * 算出兩個 commit 之間，supabase/functions/ 下「真的被改動影響」的函式清單。
 *
 * 背景：35 支函式共用 _shared/ 底下的模組，一次 push 通常只碰一兩支，但 _shared 是
 * transitive 的（例如 dispatch.ts import consensus.ts），沒人手動追蹤誰依賴誰。
 * 全部重部一次不是不行，只是每次 push 都要重部 35 支、拉長時間也拉高單次失敗機率。
 * 這裡改成:一支函式的 index.ts 自己動了、或是它 transitively import 到的 _shared
 * 檔案動了，才算「受影響」，其餘的維持線上原樣不重部。
 *
 * 注意這裡只認得到 `import ... from "./x.ts"` / `"../_shared/x.ts"` 這種相對路徑
 * import；jsr:／npm: 之類的外部套件本來就不是本地依賴，不用管。目前 supabase/functions/
 * 底下每支函式都只有一個 index.ts、只 import _shared 或外部套件，彼此不互相 import
 * （用 `grep` 驗證過），所以不需要處理函式互相依賴的情況。
 *
 * 用法：node scripts/affected-functions.mjs <base-sha-or-空字串> <head-sha>
 *   base 留空字串代表「沒有基準」（第一次跑、或找不到上次成功部署的 tag）→ 全部視為受影響，
 *   交由呼叫端決定要不要真的全部重部（通常第一次跑就是要全部重部一次來建立基準）。
 * 輸出：受影響的函式名稱，一行一個，給 shell 用 `$(...)` 或 `readarray` 接。
 *
 * 判不準的時候一律往「多部署」倒，不往「少部署」倒：少部署就是這次要修的事故的形狀
 * （改了 _shared/contribute-handler.ts，10 支函式受影響，只要漏判其中一支就是同一種
 * 「線上端點對不上」），多部署只是慢幾十秒。所以下面 diff 比對的那一段包在 try/catch
 * 裡——git 指令失敗、tag 指到讀不到的 commit、_shared 目錄讀不出來，任何算不出差量
 * 範圍的情況，都直接印出「全部函式」再結束（exit code 0，讓呼叫端當作正常的全量部署，
 * 不要當成失敗擋下來）。真正致命到連函式清單都列不出來（listFunctionDirs 本身失敗）
 * 不在這個安全網內，因為那種情況下連「全部」是哪些都不知道，直接讓它整個噴出來才對。
 */
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative } from "node:path";

const FUNCTIONS_DIR = "supabase/functions";
const [base, head] = process.argv.slice(2);

if (!head) {
  console.error("用法：node scripts/affected-functions.mjs <base-sha-or-空字串> <head-sha>");
  process.exit(2);
}

function listFunctionDirs() {
  return readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "_shared")
    .map((e) => e.name)
    .sort();
}

// 從一個檔案抓出它 import 的本地相對路徑（只認 "./x.ts" / "../x/y.ts" 這種相對路徑）
// 只吞「檔案不存在」（ENOENT）：這是正常情況（這個 diff 裡本來就刪掉了它）。
// 其他錯誤（權限、編碼壞掉…）不吞，讓它往上炸給最外層的安全網接住，
// 不要在這裡默默回傳 [] 假裝「沒有 import」——那會讓真正的依賴被漏判。
function localImportsOf(relPath) {
  let text;
  try {
    text = readFileSync(join(FUNCTIONS_DIR, relPath), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const specs = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  return specs
    .filter((s) => s.startsWith("./") || s.startsWith("../"))
    .map((s) => relative(FUNCTIONS_DIR, join(FUNCTIONS_DIR, dirname(relPath), s)).replace(/\\/g, "/"))
    .filter((s) => s.endsWith(".ts")); // 目前只有兩個 fixtures/*.json import，都在 *.test.ts 裡，本來就不會被走到
}

// 建 _shared 內部的 import 圖（key/value 都是相對 FUNCTIONS_DIR 的路徑，如 "_shared/dispatch.ts"）
// 排除 *.test.ts：測試檔不會被任何 index.ts import，改動它們不該觸發重部
// _shared 目錄讀不到不是正常情況（跟上面單一檔案不同），不吞，讓它往上炸。
function buildSharedGraph() {
  const graph = new Map();
  const entries = readdirSync(join(FUNCTIONS_DIR, "_shared"));
  for (const name of entries) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const rel = `_shared/${name}`;
    graph.set(rel, localImportsOf(rel));
  }
  return graph;
}

// 從函式的 index.ts 出發，展開它 transitively 依賴的所有 _shared 檔案
function sharedDepsOf(fnName, sharedGraph) {
  const seen = new Set();
  const queue = localImportsOf(`${fnName}/index.ts`).filter((p) => p.startsWith("_shared/"));
  while (queue.length) {
    const cur = queue.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of sharedGraph.get(cur) ?? []) {
      if (next.startsWith("_shared/") && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

function changedFiles(base, head) {
  const out = execFileSync("git", ["diff", "--name-only", base, head], { encoding: "utf8" });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

// 拿不到函式清單本身是更嚴重的問題（例如根本不在對的目錄），不在下面的安全網裡，
// 讓它直接炸出來，不要假裝算出了一份「全部」清單。
const allFns = listFunctionDirs();

let affectedFns;
if (!base) {
  // 沒有上次成功部署的紀錄 → 全部視為受影響，交由呼叫端決定要不要真的全部重部一次
  affectedFns = allFns;
} else {
  try {
    const sharedGraph = buildSharedGraph();
    const changedRel = new Set(
      changedFiles(base, head)
        .filter((f) => f.startsWith(`${FUNCTIONS_DIR}/`))
        .map((f) => relative(FUNCTIONS_DIR, f).replace(/\\/g, "/"))
    );
    // 先收集完再一次印出：計算中途才噴例外的話，不要留下「印了一半」的殘餘輸出，
    // 讓下面的 catch 乾淨地補上「全部」，不要兩份混在一起變成重複。
    affectedFns = allFns.filter((fn) => {
      const deps = sharedDepsOf(fn, sharedGraph);
      return changedRel.has(`${fn}/index.ts`) || [...deps].some((d) => changedRel.has(d));
    });
  } catch (e) {
    console.error(`算不出 ${base}..${head} 的差量範圍（${e.message}）。判不準就當全部受影響，全部重部。`);
    affectedFns = allFns;
  }
}

for (const fn of affectedFns) console.log(fn);
