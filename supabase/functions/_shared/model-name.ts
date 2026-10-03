/**
 * 模型名稱正規化（2026-10-03，統計頁「各模型表現」）。
 *
 * agent_tool 是代理自填的「工具/模型」，同一個模型有十幾種寫法（Claude Code/claude-sonnet-5、ClaudeCode/claude-sonnet-5、
 * aegis-agent/claude-sonnet-5…）。這裡把它歸成「系列＋版本」的顯示名稱：
 *   - 要分到代別：Claude Sonnet 4.5 與 Claude Sonnet 5 是兩列（維護者：同系列不同代差很大）
 *   - 只寫系列沒寫版本的（claude-code/haiku）獨立一列「Claude Haiku（未標版本）」，不併進有版本的那列
 *   - 工具前綴不影響歸類：整串字找模型關鍵字，不管它在斜線哪一邊
 *   - NULL／空白 →「未填」；一條規則都對不上 →「其他」
 *
 * SQL 那份在 migration 的 model_display_name()（統計由它算），這份是給 CI 跑測試向量用的；
 * model-name.test.ts 盯著兩份規則表逐條一致。改規則要兩邊一起改。
 *
 * 規則只能用 PostgreSQL 與 JavaScript 讀法相同的正規式語法：不用 |（兩邊的取捨規則不同，改成拆成多條規則）、
 * 不用 \b（PostgreSQL 是倒退鍵）、不用後顧。樣板裡的 \1、\2 換成第 1、2 個擷取群組，沒擷取到就換成空字串。
 */

/** [正規式, 顯示名稱樣板]，由上往下第一條符合的勝出 */
export const MODEL_NAME_RULES: ReadonlyArray<readonly [string, string]> = [
  ["jev", "Jev（系統）"],
  // Claude：先比「主版本.小版本」，再比只有主版本，最後是只寫系列。(?!\d) 讓日期後綴（-20251001）不會被讀成小版本
  ["haiku-?(\\d+)[-.](\\d)(?!\\d)", "Claude Haiku \\1.\\2"],
  ["claude-(\\d+)[-.](\\d)-haiku", "Claude Haiku \\1.\\2"],
  ["haiku-?(\\d+)", "Claude Haiku \\1"],
  ["haiku", "Claude Haiku（未標版本）"],
  ["sonnet-?(\\d+)[-.](\\d)(?!\\d)", "Claude Sonnet \\1.\\2"],
  ["claude-(\\d+)[-.](\\d)-sonnet", "Claude Sonnet \\1.\\2"],
  ["sonnet-?(\\d+)", "Claude Sonnet \\1"],
  ["sonnet", "Claude Sonnet（未標版本）"],
  ["opus-?(\\d+)[-.](\\d)(?!\\d)", "Claude Opus \\1.\\2"],
  ["claude-(\\d+)[-.](\\d)-opus", "Claude Opus \\1.\\2"],
  ["opus-?(\\d+)", "Claude Opus \\1"],
  ["opus", "Claude Opus（未標版本）"],
  ["fable-?(\\d+)[-.](\\d)(?!\\d)", "Claude Fable \\1.\\2"],
  ["fable-?(\\d+)", "Claude Fable \\1"],
  ["fable", "Claude Fable（未標版本）"],
  // DeepSeek
  ["deepseek-v(\\d+(?:\\.\\d+)?)-flash", "DeepSeek V\\1 Flash"],
  ["deepseek-v(\\d+(?:\\.\\d+)?)-pro", "DeepSeek V\\1 Pro"],
  ["deepseek-v(\\d+(?:\\.\\d+)?)", "DeepSeek V\\1"],
  ["deepseek-r(\\d+)", "DeepSeek R\\1"],
  ["deepseek-flash", "DeepSeek Flash（未標版本）"],
  ["deepseek-pro", "DeepSeek Pro（未標版本）"],
  ["deepseek", "DeepSeek（未標版本）"],
  // GPT
  ["gpt-?(\\d+)o-mini", "GPT-\\1o mini"],
  ["gpt-?(\\d+)o", "GPT-\\1o"],
  ["gpt-?(\\d+(?:\\.\\d+)?)-([a-z]+)", "GPT-\\1 \\2"],
  ["gpt-?(\\d+(?:\\.\\d+)?)", "GPT-\\1"],
  ["gpt", "GPT（未標版本）"],
  // Qwen
  ["qwen-?(\\d+(?:\\.\\d+)?)-flash", "Qwen \\1 Flash"],
  ["qwen-?(\\d+(?:\\.\\d+)?)-plus", "Qwen \\1 Plus"],
  ["qwen-?(\\d+(?:\\.\\d+)?)-max", "Qwen \\1 Max"],
  ["qwen-?(\\d+(?:\\.\\d+)?)-(\\d+)b", "Qwen \\1 \\2B"],
  ["qwen-?(\\d+(?:\\.\\d+)?)", "Qwen \\1"],
  ["qwen", "Qwen（未標版本）"],
  // 字節 Seed
  ["seed-?(\\d+(?:\\.\\d+)?)-mini", "Seed \\1 mini"],
  ["seed-?(\\d+(?:\\.\\d+)?)-lite", "Seed \\1 lite"],
  ["seed-?(\\d+(?:\\.\\d+)?)-pro", "Seed \\1 Pro"],
  ["seed-?(\\d+(?:\\.\\d+)?)", "Seed \\1"],
  // Gemini：gemini-3-1-pro-low、Gemini3.1Pro、gemini-3.8-flash 都要認得
  ["gemini-?(\\d+)[-.](\\d)(?!\\d)-?pro", "Gemini \\1.\\2 Pro"],
  ["gemini-?(\\d+)[-.](\\d)(?!\\d)-?flash-lite", "Gemini \\1.\\2 Flash-Lite"],
  ["gemini-?(\\d+)[-.](\\d)(?!\\d)-?flash", "Gemini \\1.\\2 Flash"],
  ["gemini-?(\\d+)[-.](\\d)(?!\\d)", "Gemini \\1.\\2"],
  ["gemini-?(\\d+)-?pro", "Gemini \\1 Pro"],
  ["gemini-?(\\d+)-?flash", "Gemini \\1 Flash"],
  ["gemini-?(\\d+)", "Gemini \\1"],
  ["gemini", "Gemini（未標版本）"],
];

/** 跟 SQL 的 regexp_replace(lower(p_agent_tool), '[\s_]+', '-', 'g') 一樣 */
export function prepareAgentTool(raw: string): string {
  return raw.toLowerCase().replace(/[\s_]+/g, "-");
}

const COMPILED = MODEL_NAME_RULES.map(([pat, tpl]) => [new RegExp(pat), tpl] as const);

export function modelDisplayName(raw: string | null | undefined): string {
  if (raw == null || !/\S/.test(raw)) return "未填";
  const s = prepareAgentTool(raw);
  for (const [re, tpl] of COMPILED) {
    const m = s.match(re);
    if (m) return tpl.replace("\\1", m[1] ?? "").replace("\\2", m[2] ?? "");
  }
  return "其他";
}
