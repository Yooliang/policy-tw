import { assertEquals } from "jsr:@std/assert@1";
import { actorIdForIp, agentNameProblem, DTRUST_PREFIX, isDtrustLogin, resolveActor } from "./actor.ts";

Deno.test("匿名代理：actor_id 是 ip:<雜湊>，handle 是代號本身", () => {
  const a = resolveActor("death0312", "abc123");
  assertEquals(a, { level: "ip", actor_id: "ip:abc123", handle: "death0312" });
  assertEquals(actorIdForIp("abc123"), "ip:abc123");
});

// 第 1 步還沒接 DiTurst：序號一定要被擋下來並講清楚，不能當一般代號收進去——
// 收了就等於把序號寫進 agent_name、印在貢獻榜上
Deno.test("diturst:<序號> 在開放前要被擋，而且訊息要說明是「還沒開放」不是「格式錯」", () => {
  const msg = agentNameProblem(`${DTRUST_PREFIX}12310zwe2-adfasfs`);
  assertEquals(typeof msg, "string");
  assertEquals(msg!.includes("還沒開放"), true);
  assertEquals(msg!.includes("序號"), true);
  assertEquals(isDtrustLogin("DiTurst:abc"), true, "前綴不分大小寫");
  assertEquals(isDtrustLogin("diturst-abc"), false);
});

Deno.test("一般代號照 isValidAgentName 的規則；壞格式回原本那句", () => {
  assertEquals(agentNameProblem("xiaoliang"), null);
  assertEquals(agentNameProblem("小牧_yooliang"), null);
  assertEquals(agentNameProblem("a")?.includes("2～64"), true);
  assertEquals(agentNameProblem("claude-code@x")?.includes("agent_tool"), true);
});
