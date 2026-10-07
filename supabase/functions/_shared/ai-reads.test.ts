import { assert, assertEquals } from "jsr:@std/assert";
// @ts-ignore: 純 JS 模組（Worker 用），這裡只測它的行為
import { AI_READ_KINDS, AI_READ_PATH_TYPES, classifyRead, pathTypeOf } from "../../../cloudflare/ai-reads.js";

// 2026-09-23：Worker 依 UA／Referer 分類「誰在讀正見」，背景呼叫 ai_read_hit()

Deno.test("AI 當場提問、AI 搜尋、訓練爬蟲、傳統搜尋分得開", () => {
  const ua = (s: string) => `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ${s}; +https://example.com/bot`;
  assertEquals(classifyRead(ua("ChatGPT-User/1.0"), "", "/policy/abc")?.kind, "ai_user");
  assertEquals(classifyRead(ua("Claude-User/1.0"), "", "/politician/abc")?.kind, "ai_user");
  // 2026-09-29：讀協議的是我們自己的貢獻代理，不算「AI 當場來讀」
  assertEquals(classifyRead(ua("Claude-User/1.0"), "", "/skill.md")?.kind, "agent_protocol");
  assertEquals(classifyRead(ua("ClaudeBot/1.0"), "", "/skill.md")?.kind, "ai_training", "爬蟲讀協議照原類別");
  assertEquals(classifyRead(ua("OAI-SearchBot/1.0"), "", "/")?.kind, "ai_search");
  assertEquals(classifyRead(ua("Claude-SearchBot/1.0"), "", "/")?.agent, "Claude-SearchBot", "要先比到 SearchBot，不能被 ClaudeBot 吃掉");
  assertEquals(classifyRead(ua("GPTBot/1.1"), "", "/policy/abc")?.kind, "ai_training");
  assertEquals(classifyRead(ua("ClaudeBot/1.0"), "", "/policy/abc")?.kind, "ai_training");
  assertEquals(classifyRead(ua("Googlebot/2.1"), "", "/policy/abc")?.kind, "search_engine");
});

Deno.test("從 AI 服務點過來的人算 ai_referral；一般瀏覽器與其他來源不記", () => {
  const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
  assertEquals(classifyRead(chrome, "https://chatgpt.com/c/123", "/policy/abc"), { agent: "chatgpt.com", kind: "ai_referral", path_type: "policy" });
  assertEquals(classifyRead(chrome, "https://www.perplexity.ai/search?q=x", "/")?.agent, "perplexity.ai");
  assertEquals(classifyRead(chrome, "https://www.google.com/", "/policy/abc"), null);
  assertEquals(classifyRead(chrome, "", "/policy/abc"), null);
});

Deno.test("頁種歸類：靜態資源不算讀；skill.md、llms.txt、sitemap 分開記", () => {
  assertEquals(pathTypeOf("/politician/0000b296-7ae8-4184-b704-c69d44cb696a"), "politician");
  assertEquals(pathTypeOf("/policy/abc/"), "policy");
  assertEquals(pathTypeOf("/election/2026"), "election");
  assertEquals(pathTypeOf("/skill.md"), "skill");
  assertEquals(pathTypeOf("/llms.txt"), "llms");
  assertEquals(pathTypeOf("/sitemap-policies.xml"), "sitemap");
  assertEquals(pathTypeOf("/assets/index-abc.js"), null);
  assertEquals(pathTypeOf("/images/hero.png"), null);
  assertEquals(pathTypeOf("/tracking"), "other");
  assertEquals(classifyRead("GPTBot/1.1", "", "/assets/x.css"), null);
});

// 2026-10-07：Markdown 版另外算（docs/PLAN-markdown-views.md 第 8 節）
Deno.test("Markdown 版歸 markdown，要排在人物／縣市前面；/skill.md 不受影響", () => {
  assertEquals(pathTypeOf("/politician/0000b296-7ae8-4184-b704-c69d44cb696a.md"), "markdown");
  assertEquals(pathTypeOf("/election/2026/%E5%8F%B0%E5%8D%97%E5%B8%82.md"), "markdown");
  assertEquals(pathTypeOf("/category/%E4%BA%A4%E9%80%9A%E5%BB%BA%E8%A8%AD.md"), "markdown");
  assertEquals(pathTypeOf("/data/index.md"), "markdown");
  assertEquals(pathTypeOf("/data"), "markdown", "查詢式入口 /data?q= 也算");
  assertEquals(pathTypeOf("/data/%E5%8F%B0%E5%8D%97%E5%B8%82/%E8%82%B2%E5%85%92.md"), "markdown");
  // 網頁本身不是 Markdown
  assertEquals(pathTypeOf("/politician/0000b296-7ae8-4184-b704-c69d44cb696a"), "politician");
  assertEquals(pathTypeOf("/election/2026/matrix"), "election");
  assertEquals(pathTypeOf("/skill.md"), "skill");
  assertEquals(pathTypeOf("/regional-data"), "other");
});

Deno.test("讀 Markdown 版但認不得是誰：記成 unknown_md；認得的照原類別", () => {
  const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
  const path = "/data/%E5%8F%B0%E5%8D%97%E5%B8%82/%E8%82%B2%E5%85%92.md";
  assertEquals(classifyRead(chrome, "", path), { agent: "unknown", kind: "unknown_md", path_type: "markdown" });
  assertEquals(classifyRead("python-requests/2.31", "", "/politician/0000b296-7ae8-4184-b704-c69d44cb696a.md")?.kind, "unknown_md");
  assertEquals(classifyRead("Claude-User/1.0", "", path), { agent: "Claude-User", kind: "ai_user", path_type: "markdown" });
  assertEquals(classifyRead(chrome, "https://chatgpt.com/c/1", path)?.kind, "ai_referral");
  // 不是 Markdown 的頁，認不得的照舊不記
  assertEquals(classifyRead(chrome, "", "/policy/abc"), null);
});

Deno.test("分類跟 DB 的 CHECK 一致（盯 migration 文字）", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20260923000008_ai_reads.sql", import.meta.url));
  // kind 的 CHECK 與 ai_read_hits 白名單以最新一版為準（20260929000013 加了 agent_protocol）
  // 2026-10-07：markdown／unknown_md 另有一支 migration，白名單在三處（兩個 CHECK、ai_read_hit、ai_read_hits）一起改
  const latest = await Deno.readTextFile(new URL("../../migrations/20261007181000_ai_reads_markdown.sql", import.meta.url));
  for (const k of AI_READ_KINDS) assert(latest.includes(`'${k}'`), `DB 的 kind CHECK 少了 ${k}`);
  for (const p of AI_READ_PATH_TYPES) assert(latest.includes(`'${p}'`), `DB 的 path_type CHECK 少了 ${p}`);
  for (const p of ["politician", "policy", "election", "skill", "llms", "sitemap", "other"]) assert(sql.includes(`'${p}'`), `原始 migration 的 path_type CHECK 少了 ${p}`);
  // 三處白名單：每個 kind／path_type 值在新 migration 裡至少出現 4 次（kind：CHECK＋hits＋hit；path_type：CHECK＋hits＋hit）
  // 註解裡也會提到這些值，先拿掉再數
  const code = latest.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const count = (needle: string) => code.split(needle).length - 1;
  for (const k of AI_READ_KINDS) assert(count(`'${k}'`) >= 3, `'${k}' 沒有在 CHECK、ai_read_hits、ai_read_hit 三處都出現`);
  for (const p of AI_READ_PATH_TYPES) assert(count(`'${p}'`) >= 3, `'${p}' 沒有在 CHECK、ai_read_hits、ai_read_hit 三處都出現`);
  const worker = await Deno.readTextFile(new URL("../../../cloudflare/ssr-worker.js", import.meta.url));
  assert(worker.includes("countRead(request, ctx)"), "Worker 要在每個請求呼叫 countRead");
  assert(worker.includes("rpc/ai_read_hits"), "Worker 要批次打 ai_read_hits（2026-09-24：每讀一次寫一次吃光了 Disk IO 額度）");
  assert(worker.includes("READ_FLUSH_MS"), "要累加後才寫，不能每讀一次寫一次");
  const hits = latest.slice(latest.indexOf("FUNCTION ai_read_hits("), latest.indexOf("REVOKE ALL ON FUNCTION ai_read_hits"));
  for (const p of AI_READ_PATH_TYPES) assert(hits.includes(`'${p}'`), `ai_read_hits 的 path_type 白名單少了 ${p}`);
  const single = latest.slice(latest.indexOf("FUNCTION ai_read_hit("), latest.indexOf("REVOKE ALL ON FUNCTION ai_read_hit("));
  for (const p of AI_READ_PATH_TYPES) assert(single.includes(`'${p}'`), `ai_read_hit（單筆）的 path_type 白名單少了 ${p}`);
  for (const k of AI_READ_KINDS) assert(single.includes(`'${k}'`), `ai_read_hit（單筆）的 kind 白名單少了 ${k}`);
  for (const k of AI_READ_KINDS) assert(hits.includes(`'${k}'`), `ai_read_hits 的 kind 白名單少了 ${k}`);
});
