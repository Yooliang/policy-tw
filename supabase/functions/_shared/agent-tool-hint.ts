/**
 * agent_tool 要填「工具／精確模型 ID」的回應提示（協議 1.44.0，2026-10-04）。
 *
 * 統計頁「各模型表現」是按 `model_display_name(agent_tool)` 分列的（SQL 與 _shared/model-name.ts 兩份同步）。
 * 代理大量只填別名——`claude-code/haiku`、`claude-code/sonnet`——拆不出版本，只能歸進
 * 「Claude Haiku（未標版本）」這種列；而同系列不同代的品質差很多，混在一起等於看不出是哪個模型在出錯。
 *
 * **不擋件**：agent_tool 是選填、也無法驗證真假，擋了只會讓代理亂填一個能過的字串。
 * 改成每次回應附一句提示（`notice`），告訴它歸到哪一列、該怎麼填。
 */

import { modelDisplayName } from "./model-name.ts";

/** modelDisplayName 給「只寫系列、沒寫版本」的那一類加的後綴 */
export const UNVERSIONED_SUFFIX = "（未標版本）";
/** 顯示名稱的兩個特殊值：沒帶 agent_tool、規則表一條都對不上 */
export const DISPLAY_MISSING = "未填";
export const DISPLAY_UNKNOWN = "其他";

/** 範例一律用真的存在的模型 ID；代理照抄範例也至少是個精確 ID（協議明寫「照實填、不要抄範例」） */
export const AGENT_TOOL_EXAMPLES = "claude-code/claude-sonnet-5、claude-code/claude-haiku-4-5、gemini-cli/gemini-3.1-pro、codex/gpt-5.5";

export type AgentToolIssue = "missing" | "unversioned" | "unknown";

/** 這個 agent_tool 有沒有「統計分不出是哪個模型」的問題；沒問題回 null */
export function agentToolIssue(raw: string | null | undefined): AgentToolIssue | null {
  const display = modelDisplayName(raw);
  if (display === DISPLAY_MISSING) return "missing";
  if (display === DISPLAY_UNKNOWN) return "unknown";
  return display.endsWith(UNVERSIONED_SUFFIX) ? "unversioned" : null;
}

/** 給代理看的一句話；沒問題回 null（回應就不帶 notice） */
export function agentToolNotice(raw: string | null | undefined): string | null {
  const issue = agentToolIssue(raw);
  if (!issue) return null;
  const shown = (raw ?? "").trim();
  const tail = `請填 \`<工具>/<精確模型 ID>\`，例：${AGENT_TOOL_EXAMPLES}。這不影響這次的結果。`;
  if (issue === "missing") {
    return `你沒有自報 agent_tool，交件與投票都歸進統計的「${DISPLAY_MISSING}」一列。${tail}`;
  }
  if (issue === "unversioned") {
    return `你的 agent_tool「${shown}」只寫了系列、沒有版本，統計只能歸進「${modelDisplayName(raw)}」——同系列不同代的品質差很多，混在一起看不出是哪個模型。${tail}`;
  }
  return `你的 agent_tool「${shown}」認不出是哪個模型，統計歸進「${DISPLAY_UNKNOWN}」一列。${tail}`;
}
