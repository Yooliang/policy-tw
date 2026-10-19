/**
 * main push 依改動路徑決定測試與部署範圍（2026-10-19）的守門。
 *
 * 前端類 push 略過 8 組後端測試，改跑 `_shared/frontend-guard-tests.txt` 列的那幾支——
 * 它們是「會讀前端檔」的後端測試。清單漏一支＝前端檔改壞了那支測試守的東西，CI 卻綠、直接上線。
 * 所以這裡：(1) 分類函式的案例；(2) 清單 == 從原始碼掃出來的集合；(3) ci.yml 的接線（需要的 job、條件、PR 不變）。
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "jsr:@std/assert@1";
import { classify, FRONTEND_PATTERNS } from "../../../scripts/ci-changed-paths.mjs";

const here = new URL("./", import.meta.url);
const lf = (s: string) => s.replace(/\r\n/g, "\n");

// ---- 1. 分類 ----

Deno.test("分類：只有前端類路徑 → 不是後端類", () => {
  for (const f of [
    "pages/Queue.vue", "components/PolicyCard.vue", "lib/task-labels.ts", "composables/useSupabase.ts", "router/index.ts",
    "data/2026/index.md", "styles/main.css", "cloudflare/ssr-worker.js", "public/images/a.png", "public/ads.txt", "public/robots.txt",
    "App.vue", "main.ts", "index.html", "types.ts", "entry-server.ts",
  ]) assertEquals(classify([f]).backend, false, f);
});

Deno.test("分類：協議文件、後端、工作流程、判斷不了的路徑 → 後端類", () => {
  for (const f of [
    "public/skill.md", "public/skill-types.md", "public/llms.txt", "public/llms-full.txt", "SKILL.md", "supabase/migrations/20261019000000_x.sql",
    "supabase/functions/_shared/protocol.ts", "supabase/functions/next/index.ts", "scripts/affected-functions.mjs", "scripts/ci-changed-paths.mjs",
    ".github/workflows/ci.yml", "docs/decisions/x.md", "docs/DECISIONS.md", "CLAUDE.md", "package.json", "pnpm-lock.yaml", "vite.config.ts",
    "firebase.json", "wrangler.toml", "tailwind.config.js", "some-new-top-level/file.txt", "pagesX/a.vue", "libs/a.ts", "publicity/a.txt",
  ]) assertEquals(classify([f]).backend, true, f);
});

Deno.test("分類：混合 → 後端類；空清單 → 前端類（沒改檔不需要後端）", () => {
  assertEquals(classify(["pages/A.vue", "supabase/migrations/1.sql"]).backend, true);
  assertEquals(classify(["pages/A.vue", "lib/b.ts"]).backend, false);
  assertEquals(classify([""]).backend, false);
  assertEquals(classify(["pages/A.vue", "public/skill.md"]).backend, true);
});

Deno.test("分類：前端白名單只列這幾條（新增前端資料夾要同時看過哪些後端測試會讀它）", () => {
  assertEquals(FRONTEND_PATTERNS.length, 3);
});

// ---- 2. 守門清單 ----

/** 會讀前端檔（或整個 repo 掃描）的後端測試：路徑以 ../../../ 指到前端資料夾／根目錄，或 import 它們。 */
const READS_FRONTEND = new RegExp(
  String.raw`new URL\(["'\x60](\.\./){3}["'\x60]|(\.\./){3}(pages|components|composables|lib|router|data|styles|cloudflare|types\.ts|env\.d\.ts|index\.html|entry-server|main\.ts|App\.vue)`,
);

/** 清單一行一支：「路徑」整支跑，「路徑 /正規式/」只跑名稱符合的測試。 */
async function readGuardList(): Promise<{ file: string; filter?: string }[]> {
  const lines = lf(await Deno.readTextFile(new URL("frontend-guard-tests.txt", here))).split("\n").filter(Boolean);
  return lines.map((l) => {
    const i = l.indexOf(" ");
    return i < 0 ? { file: l } : { file: l.slice(0, i), filter: l.slice(i + 1) };
  });
}

Deno.test("守門清單 frontend-guard-tests.txt 等於原始碼掃出來的「會讀前端檔」測試，且每支都存在", async () => {
  const entries = await readGuardList();
  const listed = entries.map((e) => e.file);
  assertEquals(listed, [...listed].sort(), "清單要排序（diff 好讀）");
  assertEquals(new Set(listed).size, listed.length, "清單有重複");
  for (const e of entries) {
    assertMatch(e.file, /^_shared\/[a-z0-9-]+\.test\.ts$/);
    if (e.filter !== undefined) assertMatch(e.filter, /^\/\^[A-Z]\d+ \/$/, "篩選只允許 /^A7 / 這種測試編號開頭的寫法");
  }
  const found: string[] = [];
  for await (const e of Deno.readDir(here)) {
    if (!e.isFile || !e.name.endsWith(".test.ts") || e.name === "ci-path-filter.test.ts") continue; // 這支自己的內文引用路徑樣式，不讀前端檔
    const text = await Deno.readTextFile(new URL(e.name, here));
    if (READS_FRONTEND.test(text)) found.push(`_shared/${e.name}`);
  }
  found.sort();
  assertEquals(listed, found, "有測試讀前端檔卻不在清單裡（前端類 push 不會跑它），或清單列了已不讀前端檔的測試：更新 frontend-guard-tests.txt");
  for (const f of listed) await Deno.stat(new URL(`../${f}`, here));
  assert(listed.length >= 20, "清單不該是空的");
});

Deno.test("守門清單的篩選涵蓋該檔所有讀前端檔的測試（篩選只是為了跳過同檔的 PGlite 重放，不能漏掉讀前端檔的那幾個）", async () => {
  for (const { file, filter } of await readGuardList()) {
    if (filter === undefined) continue;
    const text = lf(await Deno.readTextFile(new URL(`../${file}`, here)));
    const parts = text.split(/\n(?=Deno\.test\()/);
    const prelude = parts[0];
    // 檔頭（第一個 Deno.test 之前）不能有 import 或頂層 await 讀前端檔；只允許 `const X = new URL("../../../", …)` 這種定義根目錄的宣告
    const rootIds: string[] = [];
    for (const line of prelude.split("\n")) {
      if (!READS_FRONTEND.test(line)) continue;
      const m = line.match(/^\s*(?:export )?const (\w+)\s*=\s*new URL\(/);
      assert(m, `${file} 檔頭有讀前端檔的 import／頂層讀取，不能用篩選：${line.trim().slice(0, 80)}`);
      rootIds.push(m![1]);
    }
    const re = new RegExp(filter.slice(1, -1));
    let matchedAny = false;
    for (const block of parts.slice(1)) {
      const name = block.match(/^Deno\.test\("([^"]*)"/)?.[1] ?? "";
      const reads = READS_FRONTEND.test(block) || rootIds.some((id) => new RegExp(`\\b${id}\\b`).test(block));
      if (re.test(name)) matchedAny = true;
      if (reads) assert(re.test(name), `${file} 的「${name.slice(0, 30)}」讀前端檔，但不在篩選 ${filter} 內`);
    }
    assert(matchedAny, `${file} 沒有任何測試符合篩選 ${filter}`);
  }
});

// ---- 3. ci.yml 接線 ----

const ci = lf(await Deno.readTextFile(new URL("../../../.github/workflows/ci.yml", import.meta.url)));
const jobBlock = (name: string) => {
  const m = ci.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:\\n|\\n*$)`));
  assert(m, `ci.yml 找不到 job ${name}`);
  return m![1];
};

Deno.test("ci.yml：changes job 用 ci-changed-paths.mjs 判斷，PR 一律 backend=true，基準含部署 tag 與 push 的 before", () => {
  const b = jobBlock("changes");
  assertStringIncludes(b, "node scripts/ci-changed-paths.mjs");
  assertStringIncludes(b, "edge-functions-deployed");
  assertStringIncludes(b, "github.event.before");
  assertStringIncludes(b, "fetch-depth: 0");
  assertMatch(b, /!= "push"[\s\S]*backend=true/);
});

Deno.test("ci.yml：edge-tests 只在後端類（或 PR）才跑，八片矩陣與發牌方式不變", () => {
  const b = jobBlock("edge-tests");
  assertStringIncludes(b, "needs: [changes]");
  assertStringIncludes(b, "if: needs.changes.outputs.backend == 'true'");
  assertStringIncludes(b, "shard: [1, 2, 3, 4, 5, 6, 7, 8]");
  assertStringIncludes(b, "awk 'NR % 8 == ${{ matrix.shard }} % 8'");
});

Deno.test("ci.yml：typecheck 與 frontend-tests 每次都跑；前端純函式、金鑰掃描、守門清單都在 frontend-tests", () => {
  assert(!/needs:|\n    if:/.test(jobBlock("typecheck")), "typecheck 不依賴 changes、不設 if");
  const f = jobBlock("frontend-tests");
  assert(!/\n    if:/.test(f.split("\n    steps:")[0]), "frontend-tests 這個 job 本身不能有 if（PR 與每次 push 都要跑）");
  assertMatch(f, /run: deno test --allow-read --node-modules-dir=auto --minimum-dependency-age=0 lib\/ cloudflare\/\s*\n/);
  assertStringIncludes(f, "scripts/scan-secrets.ts");
  assertStringIncludes(f, "if: needs.changes.outputs.backend != 'true'");
  assertStringIncludes(f, "_shared/frontend-guard-tests.txt");
  assertStringIncludes(f, '--filter "$flt"');
});

Deno.test("ci.yml：部署條件——測試失敗擋部署；後端類一定要 edge-tests 成功；略過的上游不連坐", () => {
  for (const name of ["deploy", "deploy-functions"]) {
    const b = jobBlock(name);
    assertStringIncludes(b, "always()", `${name} 要 always() 才不被略過的 edge-tests 連坐`);
    assertStringIncludes(b, "needs.typecheck.result == 'success'", name);
    assertStringIncludes(b, "needs.frontend-tests.result == 'success'", name);
    assertStringIncludes(b, "needs.changes.result == 'success'", name);
    assert(!/result == 'skipped'/.test(b), `${name}：略過不能當通過（edge-tests 被略過只允許在前端類）`);
  }
  assertStringIncludes(jobBlock("deploy"), "(needs.changes.outputs.backend != 'true' || needs.edge-tests.result == 'success')");
  const fn = jobBlock("deploy-functions");
  assertStringIncludes(fn, "needs.changes.outputs.backend == 'true'");
  assertStringIncludes(fn, "needs.edge-tests.result == 'success'");
});

Deno.test("ci.yml：部署順序沒動——migration 先、函式後；Worker 排在 Hosting 之後", () => {
  const fn = jobBlock("deploy-functions");
  assert(fn.indexOf("supabase db push") > 0 && fn.indexOf("supabase db push") < fn.indexOf("node scripts/deploy-functions.mjs"));
  assertStringIncludes(jobBlock("ssr-deploy"), "needs: [deploy]");
});
