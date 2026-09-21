#!/usr/bin/env node
/**
 * 部署 Edge Function 之前先檢查版本順序（使用者 2026-09-21）。
 *
 * CLAUDE.md 寫著「合併 → 等 Hosting 綠 → db push → 部署函式」，理由是：
 * 協議要求代理「版本不一樣就去重讀 skill.md」，如果函式先報新版號而 Hosting 還是舊的，
 * 代理會重讀→還是不一樣→再重讀，**卡在無限迴圈**。文件領先端點是安全方向，反過來不是。
 *
 * 但這條規則今天被違反了兩次，兩次都是我自己。使用者：
 *
 * > 為什麼不寫成一個 CI 的檢查規則？…這樣它就天然地阻止你做這個事情。
 *
 * 所以改成機械檢查：線上 skill.md 的版本落後程式的 PROTOCOL_VERSION 時，
 * 這支直接拒絕部署。靠人記得的規則今天證明了記不住。
 *
 * 2026-09-21：CI 的 deploy-functions job（.github/workflows/ci.yml）在 Hosting
 * 部署成功之後會自動呼叫這支，帶入 scripts/affected-functions.mjs 算出的受影響函式
 * 清單。CI 那邊已經用 `needs: [deploy]` 機械保證了順序，理論上這裡的版本檢查永遠會過；
 * 留著不拿掉是因為它同時也是「Hosting 部署的到底是不是這次 commit」的斷言，失敗
 * 代表兩邊對不上，這種時候本來就不該硬部署。CI 呼叫前會先 `supabase link`，所以
 * 下面 spawnSync 沿用不帶 --project-ref 的寫法一樣能動。
 *
 * 用法：node scripts/deploy-functions.mjs next tasks report
 *       node scripts/deploy-functions.mjs --force next   （知道自己在做什麼時才用）
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SKILL_URL = "https://policy-tw.web.app/skill.md";
const args = process.argv.slice(2);
const force = args.includes("--force");
const fns = args.filter((a) => !a.startsWith("--"));

if (fns.length === 0) {
  console.error("用法：node scripts/deploy-functions.mjs <function> [function...]");
  process.exit(2);
}

const codeVersion = readFileSync("supabase/functions/_shared/protocol.ts", "utf8")
  .match(/PROTOCOL_VERSION = "([0-9.]+)"/)?.[1];
if (!codeVersion) {
  console.error("讀不到 _shared/protocol.ts 的 PROTOCOL_VERSION");
  process.exit(2);
}

const cmp = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

let hostedVersion = null;
try {
  const res = await fetch(`${SKILL_URL}?nocache=${Date.now()}`, { cache: "no-store" });
  if (res.ok) hostedVersion = (await res.text()).match(/\*\*版本\*\*：([0-9.]+)/)?.[1] ?? null;
} catch (e) {
  console.error(`抓不到線上 skill.md（${e.message}）`);
}

if (!hostedVersion) {
  console.error("讀不到線上 skill.md 的版本——不確定順序對不對，先不部署。確定要的話加 --force。");
  if (!force) { process.exitCode = 1; process.exit(1); }
} else if (cmp(hostedVersion, codeVersion) < 0) {
  console.error(`
✖ 不能部署：線上 skill.md 是 ${hostedVersion}，程式的 PROTOCOL_VERSION 是 ${codeVersion}。

  函式先上去的話，/next 會回 ${codeVersion}，而代理照協議去重讀 skill.md 只會拿到
  ${hostedVersion}——版本永遠對不上，它會卡在「重讀→還是不一樣→再重讀」的迴圈。

  正確順序：合併 → 等 Hosting 綠（gh run watch）→ db push → 部署函式。
  Hosting 追上之後再跑一次這個指令。
`.trim());
  if (!force) { process.exitCode = 1; process.exit(1); }
  console.error("（--force：知道自己在做什麼，繼續）");
} else {
  console.log(`✔ 版本順序沒問題：線上 skill.md ${hostedVersion} ≥ 程式 ${codeVersion}`);
}

let failed = 0;
for (const fn of fns) {
  console.log(`\n→ 部署 ${fn}`);
  // --use-api：伺服器端打包，不需要本機（或 CI runner 上）有 Docker 在跑。
  const r = spawnSync("npx", ["supabase", "functions", "deploy", fn, "--use-api"], { stdio: "inherit", shell: true });
  if (r.status !== 0) { console.error(`✖ ${fn} 部署失敗`); failed++; }
}
process.exit(failed > 0 ? 1 : 0);
