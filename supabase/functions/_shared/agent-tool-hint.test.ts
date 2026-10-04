/**
 * agent_tool 要填「工具／精確模型 ID」的提示（協議 1.44.0，2026-10-04）。
 * 只提示、不擋件——所以測的是「該提醒的有提醒、填對的不要囉嗦」。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { agentToolIssue, agentToolNotice } from "./agent-tool-hint.ts";

Deno.test("精確模型 ID 不提醒", () => {
  for (const tool of [
    "claude-code/claude-sonnet-5",
    "claude-code/claude-haiku-4-5",
    "claude-code/claude-opus-5-5",
    "gemini-cli/gemini-3.1-pro",
    "codex/gpt-5.5",
    "aegis-agent/deepseek-v3.2",
    "policy-tw/roster-batch-jev-1.13.0",
  ]) {
    assertEquals(agentToolIssue(tool), null, tool);
    assertEquals(agentToolNotice(tool), null, tool);
  }
});

Deno.test("只寫系列的別名要提醒，訊息講出歸到哪一列", () => {
  for (const tool of ["claude-code/haiku", "claude-code/sonnet", "ClaudeCode/opus", "gemini-cli/gemini", "codex/gpt"]) {
    assertEquals(agentToolIssue(tool), "unversioned", tool);
  }
  const msg = agentToolNotice("claude-code/haiku")!;
  assertStringIncludes(msg, "Claude Haiku（未標版本）");
  assertStringIncludes(msg, "claude-code/claude-sonnet-5");
  assertStringIncludes(msg, "不影響這次的結果");
});

Deno.test("沒帶、空白、認不出的各有自己的提醒", () => {
  assertEquals(agentToolIssue(null), "missing");
  assertEquals(agentToolIssue(undefined), "missing");
  assertEquals(agentToolIssue("   "), "missing");
  assertStringIncludes(agentToolNotice(null)!, "未填");

  assertEquals(agentToolIssue("my-custom-agent"), "unknown");
  const unknown = agentToolNotice("my-custom-agent")!;
  assertStringIncludes(unknown, "my-custom-agent");
  assertStringIncludes(unknown, "其他");
});

Deno.test("提示不含任何模型名稱的硬編碼判斷：規則就是 model_display_name 那一份", () => {
  // 新系列只要規則表拆得出版本就不該被提醒；拆不出版本的一律提醒，不管是哪一家
  assertEquals(agentToolIssue("some-cli/qwen-3.5-max"), null);
  assertEquals(agentToolIssue("some-cli/qwen"), "unversioned");
  assert(agentToolNotice("some-cli/qwen")!.includes("Qwen（未標版本）"));
});
