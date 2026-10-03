/**
 * 模型名稱正規化（2026-10-03，統計頁「各模型表現」）。
 *
 * agent_tool 是代理自填的「工具/模型」，寫法極亂。這裡的測試向量全部是線上 contributions／contribution_votes
 * 近 30 天實際出現過的字串（2026-10-03 唯讀查詢），不是自己編的。
 *
 * 規則有兩份：SQL（migration 的 model_display_name）與 TS（model-name.ts）。
 * 統計是 SQL 在算，TS 這份存在的理由是讓 CI 能跑測試向量；最後一支測試盯著兩份規則逐條一致。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { MODEL_NAME_RULES, modelDisplayName, prepareAgentTool } from "./model-name.ts";

/** 線上實際值 → 應歸到哪一列 */
const REAL: Array<[string | null, string]> = [
  // Claude Haiku：有版本的歸 4.5；只寫 haiku 的獨立一列
  ["claude-code/haiku", "Claude Haiku（未標版本）"],
  ["claude-code/claude-haiku-4-5", "Claude Haiku 4.5"],
  ["claude-code/claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
  ["claude-haiku-4-5/llm", "Claude Haiku 4.5"],
  ["Claude Code / claude-haiku-4-5", "Claude Haiku 4.5"],
  // Claude Sonnet：大小寫、空白、工具前綴都不影響
  ["Claude Code/claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-code/claude-sonnet-5", "Claude Sonnet 5"],
  ["Claude-Code/claude-sonnet-5", "Claude Sonnet 5"],
  ["Claude Code/Claude Sonnet 5", "Claude Sonnet 5"],
  ["Claude Code/Sonnet-5", "Claude Sonnet 5"],
  ["Claude Code/sonnet-5", "Claude Sonnet 5"],
  ["Claude Code/Claude-Sonnet-5", "Claude Sonnet 5"],
  ["Claude Code/Claude-sonnet-5", "Claude Sonnet 5"],
  ["Claude-Code/Sonnet-5", "Claude Sonnet 5"],
  ["Claude-Code/sonnet-5", "Claude Sonnet 5"],
  ["Claude-Code/Claude-Sonnet-5", "Claude Sonnet 5"],
  ["ClaudeCode/claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-code/sonnet-5", "Claude Sonnet 5"],
  ["claude-agent-sdk/claude-sonnet-5", "Claude Sonnet 5"],
  ["Claude-Agent-SDK/claude-sonnet-5", "Claude Sonnet 5"],
  ["Claude Agent SDK/claude-sonnet-5", "Claude Sonnet 5"],
  ["aegis-agent/claude-sonnet-5", "Claude Sonnet 5"],
  ["Aegis-Claude-Agent-SDK/claude-sonnet-5", "Claude Sonnet 5"],
  ["Aegis-ClaudeAgentSDK/claude-sonnet-5", "Claude Sonnet 5"],
  ["aegis/claude-sonnet-5", "Claude Sonnet 5"],
  ["Aegis/claude-sonnet-5", "Claude Sonnet 5"],
  ["aegis-worker/claude-sonnet-5", "Claude Sonnet 5"],
  ["aegis-workspace/claude-sonnet-5", "Claude Sonnet 5"],
  ["aegis-task/claude-sonnet-5", "Claude Sonnet 5"],
  ["aegis-member/claude-sonnet-5", "Claude Sonnet 5"],
  ["aegis-chat/claude-sonnet-5", "Claude Sonnet 5"],
  ["aegis-hen/claude-sonnet-5", "Claude Sonnet 5"],
  ["aegis-claude-code/claude-sonnet-5", "Claude Sonnet 5"],
  ["Claude/claude-sonnet-5", "Claude Sonnet 5"],
  ["Claude/Sonnet-5", "Claude Sonnet 5"],
  ["Claude/Claude-Sonnet-5", "Claude Sonnet 5"],
  ["claude-sonnet-5/Claude-Code", "Claude Sonnet 5"],
  ["claude-sonnet-5 via Claude Code", "Claude Sonnet 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-code/sonnet", "Claude Sonnet（未標版本）"],
  // 同系列不同代要分開
  ["Claude Code/claude-sonnet-4-5", "Claude Sonnet 4.5"],
  ["claude-code/claude-opus-5", "Claude Opus 5"],
  ["claude-code/claude-fable-5-1", "Claude Fable 5.1"],
  // DeepSeek
  ["pi/deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["pi/deepseek/deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["pi-agent/deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["pi-coding-agent/deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["Aegis/deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["pi/DeepSeek V4.1 Flash", "DeepSeek V4.1 Flash"],
  ["pi/deepseek-v4-pro", "DeepSeek V4 Pro"],
  ["pi-verifier/deepseek-v4-pro", "DeepSeek V4 Pro"],
  ["pi/deepseek-v3.2", "DeepSeek V3.2"],
  ["pi/deepseek/deepseek-flash-latest", "DeepSeek Flash（未標版本）"],
  ["deepseek-flash", "DeepSeek Flash（未標版本）"],
  // 其他系列
  ["Codex/GPT-5", "GPT-5"],
  ["pi/openai/gpt-4o-mini", "GPT-4o mini"],
  ["pi/openai-codex/gpt-5.6-luna", "GPT-5.6 luna"],
  ["pi/gpt-5.6-sol", "GPT-5.6 sol"],
  ["pi/qwen/qwen3.8-flash", "Qwen 3.8 Flash"],
  ["pi/qwen/qwen3.8-27b-free", "Qwen 3.8 27B"],
  ["pi/bytedance-seed/seed-2.0-mini", "Seed 2.0 mini"],
  ["antigravity-cli/gemini-3-1-pro-low", "Gemini 3.1 Pro"],
  ["Antigravity/Gemini3.1Pro", "Gemini 3.1 Pro"],
  ["Gemini_3.1_Pro", "Gemini 3.1 Pro"],
  ["agy/gemini-3.8-flash", "Gemini 3.8 Flash"],
  ["Antigravity/gemini-3.8-flash", "Gemini 3.8 Flash"],
  ["relay/jev-1.13", "Jev（系統）"],
  // 認不出模型：只有工具、或只寫「claude」
  ["claude-code", "其他"],
  ["pi/claude", "其他"],
  ["claude/claude", "其他"],
  ["pi/x", "其他"],
  [null, "未填"],
  ["", "未填"],
  ["   ", "未填"],
];

Deno.test("線上實際出現過的 agent_tool 逐一歸到正確的系列＋版本", () => {
  for (const [raw, want] of REAL) assertEquals(modelDisplayName(raw), want, `${JSON.stringify(raw)}`);
});

Deno.test("未標版本的別名不可以併進有版本的那一列", () => {
  assert(modelDisplayName("claude-code/haiku") !== modelDisplayName("claude-code/claude-haiku-4-5"));
  assert(modelDisplayName("claude-code/sonnet") !== modelDisplayName("claude-code/claude-sonnet-5"));
  assert(modelDisplayName("pi/deepseek/deepseek-flash-latest") !== modelDisplayName("pi/deepseek-v4-flash"));
});

Deno.test("日期後綴不會被讀成小版本號", () => {
  assertEquals(modelDisplayName("claude-code/claude-sonnet-5-20260101"), "Claude Sonnet 5");
  assertEquals(modelDisplayName("claude-code/claude-haiku-4-5-20251001"), "Claude Haiku 4.5");
});

Deno.test("規則只用 PostgreSQL 與 JavaScript 讀法相同的語法；樣板最多用到 \\2", () => {
  for (const [pat, tpl] of MODEL_NAME_RULES) {
    new RegExp(pat); // 能編譯
    // \b 在 PostgreSQL 是倒退鍵、(?<…) 後顧與具名群組 PostgreSQL 不支援、| 在兩邊的取捨規則不同
    assert(!/\\b|\(\?<|\|/.test(pat), `規則 ${pat} 用了兩邊讀法不同的語法`);
    const groups = (pat.match(/\((?!\?)/g) ?? []).length;
    assert(groups <= 2, `規則 ${pat} 有 ${groups} 個擷取群組，SQL 只替換 \\1、\\2`);
    for (const ref of tpl.match(/\\\d/g) ?? []) assert(Number(ref.slice(1)) <= groups, `樣板 ${tpl} 用到不存在的群組`);
  }
});

Deno.test("前處理：轉小寫、空白與底線換成連字號", () => {
  assertEquals(prepareAgentTool("Claude Code/Claude Sonnet 5"), "claude-code/claude-sonnet-5");
  assertEquals(prepareAgentTool("Gemini_3.1_Pro"), "gemini-3.1-pro");
});

/** 找最後一支（檔名排序最大）定義某個 SQL 物件的 migration，回傳從定義處起的內容 */
async function latestMigrationDefining(marker: string): Promise<string> {
  const dir = new URL("../../migrations/", import.meta.url);
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  for (const name of names.sort().reverse()) {
    const sql = await Deno.readTextFile(new URL(name, dir));
    const at = sql.indexOf(marker);
    if (at >= 0) return sql.slice(at);
  }
  throw new Error(`找不到定義 ${marker} 的 migration`);
}

Deno.test("SQL 與 TS 一致：model_display_name 的規則表、前處理與兩個預設值等於 model-name.ts", async () => {
  const sql = await latestMigrationDefining("FUNCTION model_display_name");
  const body = sql.slice(0, sql.indexOf("$$;"));
  const rows = [...body.matchAll(/\(\s*(\d+)\s*,\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*\)/g)]
    .map((m) => ({ ord: Number(m[1]), pat: m[2].replaceAll("''", "'"), tpl: m[3].replaceAll("''", "'") }));
  assertEquals(rows.map((r) => r.ord), rows.map((_, i) => i + 1), "序號要從 1 連號，順序就是先後");
  assertEquals(rows.map((r) => [r.pat, r.tpl]), MODEL_NAME_RULES.map(([p, t]) => [p, t]));
  assert(body.includes(String.raw`regexp_replace(lower(p_agent_tool), '[\s_]+', '-', 'g')`), "前處理要跟 prepareAgentTool 一樣");
  assert(body.includes(String.raw`p_agent_tool !~ '\S'`), "空白字串視同未填");
  assert(body.includes("'未填'") && body.includes("'其他'"));
  assert(body.includes(String.raw`replace(replace(r.tpl, '\1', COALESCE(m[1], '')), '\2', COALESCE(m[2], ''))`), "樣板替換要跟 TS 一樣");
  assert(/ORDER BY r\.ord\s+LIMIT 1/.test(body), "第一條符合的規則勝出");
});
