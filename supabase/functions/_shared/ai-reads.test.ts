import { assert, assertEquals } from "jsr:@std/assert";
// @ts-ignore: 純 JS 模組（Worker 用），這裡只測它的行為
import { AI_READ_KINDS, classifyRead, pathTypeOf } from "../../../cloudflare/ai-reads.js";

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

Deno.test("分類跟 DB 的 CHECK 一致（盯 migration 文字）", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20260923000008_ai_reads.sql", import.meta.url));
  // kind 的 CHECK 與 ai_read_hits 白名單以最新一版為準（20260929000013 加了 agent_protocol）
  const latest = await Deno.readTextFile(new URL("../../migrations/20260929000013_ai_reads_agent_protocol.sql", import.meta.url));
  for (const k of AI_READ_KINDS) assert(latest.includes(`'${k}'`), `DB 的 kind CHECK 少了 ${k}`);
  for (const p of ["politician", "policy", "election", "skill", "llms", "sitemap", "other"]) assert(sql.includes(`'${p}'`), `DB 的 path_type CHECK 少了 ${p}`);
  const worker = await Deno.readTextFile(new URL("../../../cloudflare/ssr-worker.js", import.meta.url));
  assert(worker.includes("countRead(request, ctx)"), "Worker 要在每個請求呼叫 countRead");
  assert(worker.includes("rpc/ai_read_hits"), "Worker 要批次打 ai_read_hits（2026-09-24：每讀一次寫一次吃光了 Disk IO 額度）");
  assert(worker.includes("READ_FLUSH_MS"), "要累加後才寫，不能每讀一次寫一次");
  const hits = latest.slice(latest.indexOf("FUNCTION ai_read_hits("), latest.indexOf("REVOKE ALL ON FUNCTION ai_read_hits"));
  for (const k of AI_READ_KINDS) assert(hits.includes(`'${k}'`), `ai_read_hits 的 kind 白名單少了 ${k}`);
});
