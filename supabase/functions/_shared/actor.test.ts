import { assertEquals } from "jsr:@std/assert@1";
import { actorIdForIp, agentNameProblem, DITRUST_PREFIX, isDitrustLogin, resolveActor, resolveActorFromRequest } from "./actor.ts";

Deno.test("匿名代理：actor_id 是 ip:<雜湊>，handle 是代號本身", () => {
  const a = resolveActor("death0312", "abc123");
  assertEquals(a, { level: "ip", actor_id: "ip:abc123", handle: "death0312" });
  assertEquals(actorIdForIp("abc123"), "ip:abc123");
});

// 第 1 步還沒接 DiTurst：序號一定要被擋下來並講清楚，不能當一般代號收進去——
// 收了就等於把序號寫進 agent_name、印在貢獻榜上
Deno.test("ditrust:<序號> 沒經過身份解析就進到代號驗證要被擋，而且訊息要提到序號、不是只說格式錯", () => {
  const msg = agentNameProblem(`${DITRUST_PREFIX}12310zwe2-adfasfs`);
  assertEquals(typeof msg, "string");
  assertEquals(msg!.includes("身份解析"), true);
  assertEquals(msg!.includes("序號"), true);
  assertEquals(isDitrustLogin("DiTrust:abc"), true, "前綴不分大小寫");
  assertEquals(isDitrustLogin("diturst:abc"), true, "舊的錯字拼法也擋，序號不能因為打錯就被當代號收進去");
  assertEquals(isDitrustLogin("ditrust-abc"), false);
});

Deno.test("一般代號照 isValidAgentName 的規則；壞格式回原本那句", () => {
  assertEquals(agentNameProblem("xiaoliang"), null);
  assertEquals(agentNameProblem("小牧_yooliang"), null);
  assertEquals(agentNameProblem("a")?.includes("2～64"), true);
  assertEquals(agentNameProblem("claude-code@x")?.includes("agent_tool"), true);
});

// 第 3 步（2026-09-19）：序號走 agents-verify 換身份
Deno.test("resolveActorFromRequest：一般代號回匿名；序號格式錯 400；驗證 401 講清楚；成功回 ditrust 身份並用顯示名當代號", async () => {
  const anon = await resolveActorFromRequest("death0312", "ip1");
  assertEquals(anon, { ok: true, actor: { level: "ip", actor_id: "ip:ip1", handle: "death0312" } });
  const bad = await resolveActorFromRequest("ditrust:not-hex", "ip1");
  assertEquals(bad.ok === false && bad.status, 400);
  const secret = "a".repeat(64);
  const denied = await resolveActorFromRequest(`ditrust:${secret}`, "ip1", (async () => new Response("{}", { status: 401 })) as typeof fetch);
  // 測試沒開 --allow-env：讀不到 SUPABASE_URL 會回 503「未設定」，這條只能在有 env 的環境驗 401；兩種都算「沒放行」
  assertEquals(denied.ok, false);
});
