/**
 * 站點網址收成環境變數（盤點 #7，2026-10-07 維護者同意）。
 *
 * 起因：前端用 正見.tw、Edge Function 十幾處寫死 policy-tw.web.app（2026-09-22 換網域時只換了前端一半），
 * 代理拿到的人物頁／政見頁連結與分享出去的不是同一個網域。
 *
 * 守的事：
 *   1. 給人點的網站連結（人物頁、政見頁、任務看板）走 siteUrl()（環境變數 SITE_URL，預設 正見.tw），Edge 程式碼不再寫死
 *   2. **PROTOCOL_URL 不動**（版本握手的一部分，protocol-guard.test 守）；回應的 docs 欄位與錯誤訊息裡的 skill.md 改引用它——值沒變
 *   3. 網址的預設值只有一個：Edge、前端 lib/site.ts、建置後腳本、index.html 的靜態標籤全對得上（環境變數碰不到 index.html，所以用測試釘）
 *   4. 送給第三方網站的 User-Agent（cec-verify、source-archive）維持原樣：那是給對方辨識我們的字串，改了對方若有照 UA 放行就會斷
 */
import { assert, assertEquals, assertMatch, assertNotMatch } from "jsr:@std/assert@1";
import { DEFAULT_SITE_URL, parseSiteUrl, siteUrl } from "./site.ts";
import { PROTOCOL_URL } from "./protocol.ts";
import { resolveSiteUrl, DEFAULT_SITE_URL as FRONT_DEFAULT } from "../../../lib/site.ts";
import { summarizeContribution } from "./contribution-summary.ts";

const FUNCTIONS = new URL("../", import.meta.url);
const REPO = new URL("../../../", import.meta.url);

Deno.test("siteUrl：沒設＝正見.tw；有設就用；寫錯（沒 https、帶路徑、空字串）一律退回預設", () => {
  assertEquals(DEFAULT_SITE_URL, "https://xn--2lw665d.tw");
  assertEquals(siteUrl(() => undefined), "https://xn--2lw665d.tw");
  assertEquals(siteUrl(() => ""), "https://xn--2lw665d.tw");
  assertEquals(siteUrl((n) => (n === "SITE_URL" ? "https://example.test" : undefined)), "https://example.test");
  assertEquals(siteUrl(() => "https://example.test/"), "https://example.test", "結尾斜線去掉");
  assertEquals(siteUrl(() => " https://example.test "), "https://example.test", "前後空白去掉");
  assertEquals(siteUrl(() => "https://正見.tw"), "https://xn--2lw665d.tw", "Unicode 網域正規化成 punycode，跟前端 canonical 同一個寫法");
  for (const bad of ["http://example.test", "example.test", "https://example.test/path", "https://example.test?x=1", "ftp://x.test", "https://", "javascript:alert(1)"]) {
    assertEquals(siteUrl(() => bad), DEFAULT_SITE_URL, bad);
  }
  assertEquals(parseSiteUrl(undefined), null);
  assertEquals(parseSiteUrl(42), null);
});

Deno.test("連結組法：人物頁、政見頁走 siteUrl()（預設 正見.tw）", () => {
  const s = summarizeContribution({ contribution_type: "policy", payload: { name: "陳素月", title: "長者健保全免" }, applied_policy_id: "p-1", applied_politician_id: "bcdfd014" });
  assertEquals(s.policy_url, "https://xn--2lw665d.tw/policy/p-1");
  assertEquals(s.politician_url, "https://xn--2lw665d.tw/politician/bcdfd014");
});

Deno.test("PROTOCOL_URL 不動；回應的 docs 欄位與「格式見 skill.md」錯誤訊息引用它，不再各自寫字面", async () => {
  assertEquals(PROTOCOL_URL, "https://policy-tw.web.app/skill.md");
  for (const f of ["tasks", "verifications", "contributions-feed"]) {
    const t = await Deno.readTextFile(new URL(`${f}/index.ts`, FUNCTIONS));
    assertMatch(t, /docs: PROTOCOL_URL,/, `${f}：docs 要引用 PROTOCOL_URL`);
    assertMatch(t, /import \{ PROTOCOL_URL \} from "\.\.\/_shared\/protocol\.ts";/);
  }
  for (const f of ["contribute", "report", "verify"]) {
    const t = await Deno.readTextFile(new URL(`${f}/index.ts`, FUNCTIONS));
    assertMatch(t, /`只接受 POST，格式見 \$\{PROTOCOL_URL\}`/, `${f}：錯誤訊息要引用 PROTOCOL_URL`);
  }
  const handler = await Deno.readTextFile(new URL("_shared/contribute-handler.ts", FUNCTIONS));
  assertEquals(handler.match(/docs: PROTOCOL_URL/g)?.length, 2);
  assertNotMatch(handler, /SITE_URL/);
  for (const f of ["contribution-status", "request-task"]) {
    const t = await Deno.readTextFile(new URL(`${f}/index.ts`, FUNCTIONS));
    assertMatch(t, /import \{ siteUrl \} from "\.\.\/_shared\/site\.ts";/, `${f}：連結要走 siteUrl()`);
    assertMatch(t, /siteUrl\(\)/);
  }
});

Deno.test("Edge Function 的程式碼裡不再寫死 policy-tw.web.app（只有 PROTOCOL_URL 與給第三方看的 User-Agent）", async () => {
  // 例外都是有理由的：protocol.ts＝PROTOCOL_URL；cec-verify／source-archive＝送給第三方網站的 User-Agent；self-hosts.ts＝「出處不得引用正見自己」的網域封鎖清單（#486，不是給人點的連結）
  const ALLOWED = new Set(["_shared/protocol.ts", "cec-verify/index.ts", "_shared/source-archive.ts", "_shared/self-hosts.ts"]);
  const hits: string[] = [];
  async function walk(dir: URL, rel: string) {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) {
        if (e.name !== "node_modules" && !e.name.startsWith(".")) await walk(new URL(e.name + "/", dir), rel + e.name + "/");
        continue;
      }
      if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
      const text = (await Deno.readTextFile(new URL(e.name, dir))).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
      if (/policy-tw\.web\.app/.test(text) && !ALLOWED.has(rel + e.name)) hits.push(rel + e.name);
    }
  }
  await walk(FUNCTIONS, "");
  assertEquals(hits, [], "對外的網站連結請用 siteUrl()（_shared/site.ts）、協議網址請用 PROTOCOL_URL");
  // 例外的兩個 User-Agent 照舊
  assertMatch(await Deno.readTextFile(new URL("cec-verify/index.ts", FUNCTIONS)), /PolicyTracker\/1\.0; \+https:\/\/policy-tw\.web\.app\)/);
  assertMatch(await Deno.readTextFile(new URL("_shared/source-archive.ts", FUNCTIONS)), /policy-tw-source-archive\/1\.0 \(\+https:\/\/policy-tw\.web\.app\/sources\)/);
});

Deno.test("預設網址只有一個：Edge、前端 lib/site.ts、建置後腳本、index.html 的靜態標籤全是 正見.tw", async () => {
  assertEquals(FRONT_DEFAULT, DEFAULT_SITE_URL, "前端與 Edge 的預設網址要一樣");
  // 前端：VITE_SITE_URL（沒設＝預設；寫錯＝預設）
  assertEquals(resolveSiteUrl(undefined), DEFAULT_SITE_URL);
  assertEquals(resolveSiteUrl("https://example.test/"), "https://example.test");
  assertEquals(resolveSiteUrl("http://example.test"), DEFAULT_SITE_URL);
  assertEquals(resolveSiteUrl("https://example.test/x"), DEFAULT_SITE_URL);
  // usePageHead 不另寫一份，從 lib/site 拿
  const head = await Deno.readTextFile(new URL("composables/usePageHead.ts", REPO));
  assertMatch(head, /from '\.\.\/lib\/site'/);
  assertNotMatch(head.replace(/sameAs:[^\n]*/, ""), /xn--2lw665d|policy-tw\.web\.app/, "usePageHead 不再寫死網址（sameAs 列的是「同一個站的別名」，刻意兩個都列）");
  // 建置後腳本（sitemap）：同一個環境變數、同一個預設
  const post = await Deno.readTextFile(new URL("scripts/postbuild-ssg.mjs", REPO));
  assertMatch(post, /loadEnv\('production', ROOT, 'VITE_'\)\.VITE_SITE_URL/);
  assertStringIncludesDefault(post);
  // index.html 的 og 標籤是靜態的，環境變數碰不到：預設網址換了要一起改
  const html = await Deno.readTextFile(new URL("index.html", REPO));
  for (const m of html.matchAll(/(?:og:url|og:image|twitter:image)" content="(https:\/\/[^/"]+)/g)) assertEquals(m[1], DEFAULT_SITE_URL, "index.html 的 og 標籤網域要跟預設一致");
  assert([...html.matchAll(/og:url/g)].length >= 1);
});

function assertStringIncludesDefault(text: string) {
  assert(text.includes(`'${DEFAULT_SITE_URL}'`), "postbuild-ssg.mjs 的預設網址要跟 lib/site.ts 一致");
}
