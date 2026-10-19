#!/usr/bin/env node
/**
 * main push 時，依改動路徑決定要不要跑完整的後端測試與 Supabase 部署（2026-10-19 維護者：「本來就該這樣的呀」）。
 *
 * 只改前端（頁面、元件、lib、data、靜態檔）的提交，8 組 Edge Function 與協議守門測試白跑 5 分鐘以上。
 * 這裡把改動分成兩類：
 *   前端類：FRONTEND_PATTERNS 明列的路徑——只跑型別檢查與建置、lib/ cloudflare/ 測試，
 *           以及「會讀這些前端檔的後端守門測試」（清單在 supabase/functions/_shared/frontend-guard-tests.txt），然後部署 Hosting。
 *   後端類：其餘全部（supabase/、scripts/、.github/、docs/、public/skill*.md、public/llms.txt、SKILL.md、package.json……）。
 * 只要有一個檔案不在前端白名單內就算後端類（混合＝後端類；判斷不了＝後端類）。判不準一律往「多測、多部署」倒。
 *
 * 用法：node scripts/ci-changed-paths.mjs <基準1> [<基準2> ...] <head>
 *   每個基準都跟 head 比一次，任何一個比出後端類就是後端類。CI 傳兩個基準：
 *   - 上次成功部署函式的 tag（edge-functions-deployed）：連續合併時中間被略過的提交、或上次部署失敗的後端改動，都算進來
 *   - 這次 push 的 before：第一次 push（全 0）、force push 之後 before 不在歷史裡 → git diff 失敗 → 後端類
 *   基準是空字串或 0000… 一律當後端類。
 * 輸出：寫入 $GITHUB_OUTPUT 的 backend=true|false（沒有 $GITHUB_OUTPUT 就印在標準輸出）。
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** 前端類路徑（整條路徑從頭比對）。新增前端資料夾時加在這裡；沒加＝當後端類（保守）。 */
export const FRONTEND_PATTERNS = [
  /^(pages|components|composables|lib|router|styles|data|cloudflare)\//,
  // public/ 底下除了協議文件（skill*.md、llms.txt）都是前端靜態檔
  /^public\/(?!skill[^/]*\.md$|llms\.txt$)/,
  // 根目錄的前端進入點
  /^(App\.vue|main\.ts|entry-server\.ts|index\.html|types\.ts|env\.d\.ts)$/,
];

export function isFrontendPath(path) {
  return FRONTEND_PATTERNS.some((re) => re.test(path));
}

/** @param {string[]} files */
export function classify(files) {
  const names = files.map((f) => f.trim()).filter(Boolean);
  const backendFiles = names.filter((f) => !isFrontendPath(f));
  return { backend: backendFiles.length > 0, backendFiles, frontendFiles: names.filter(isFrontendPath) };
}

function diffNames(base, head) {
  if (!base || /^0+$/.test(base)) return null;
  try {
    // --no-renames：改名會同時列出舊路徑與新路徑，從後端搬到前端（或反過來）不會被藏起來
    const out = execFileSync("git", ["diff", "--name-only", "--no-renames", base, head], { encoding: "utf8" });
    return out.split("\n");
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const head = args.pop();
  if (!head) {
    console.error("用法：node scripts/ci-changed-paths.mjs <基準1> [<基準2> ...] <head>");
    process.exit(2);
  }
  let backend = false;
  for (const base of args) {
    const names = diffNames(base, head);
    if (names === null) {
      console.log(`基準「${base || "（空）"}」比不出差異 → 當後端類`);
      backend = true;
      continue;
    }
    const r = classify(names);
    console.log(`${base.slice(0, 10)}..${head.slice(0, 10)}：${names.filter(Boolean).length} 個檔，前端類 ${r.frontendFiles.length}、後端類 ${r.backendFiles.length}`);
    for (const f of r.backendFiles.slice(0, 20)) console.log(`  後端類：${f}`);
    if (r.backend) backend = true;
  }
  if (args.length === 0) backend = true;
  console.log(backend ? "→ 後端類：跑完整測試，再 db push、部署函式、部署 Hosting" : "→ 只有前端類：跑建置與前端相關測試，直接部署 Hosting");
  const line = `backend=${backend}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
