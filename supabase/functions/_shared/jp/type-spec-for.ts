/**
 * 日本站派工時挑 `item.type_spec`（日本協議 0.29.0，policy-ops#178 D；做法同正見 ../type-spec-for.ts，協議 1.93.0）。
 * 段落來自 policy-jp 的 public/skill-types.md（產物 type-spec.gen.ts）；選段規則共用 ../type-spec.ts。
 *   - 任務：這種任務型別的段落 ＋ 它答案用的交件型別（JP_TASK_ARMS）與也收的型別（JP_TASK_ALSO）的段落
 *   - 驗證：被驗的那一種交件型別的段落
 * `no_change` 每一件都可能用到，留在 skill.md，不在這裡。
 */
import { selectTypeSpec } from "../type-spec.ts";
import { JP_TYPE_SPEC_BLOCKS } from "./type-spec.gen.ts";
import { JP_TASK_ALSO, JP_TASK_ARMS } from "./contribution-schema.ts";

/** 任務：未知的任務型別（手動任務的自由型別）回 null */
export function typeSpecForJpTask(taskType: string | null | undefined, suggested?: string | null): string | null {
  if (!taskType) return null;
  const arms = JP_TASK_ARMS as Readonly<Record<string, string>>;
  return selectTypeSpec(JP_TYPE_SPEC_BLOCKS, {
    taskType,
    contributionTypes: [suggested ?? arms[taskType], ...(JP_TASK_ALSO[taskType] ?? [])],
  });
}

/** 驗證：被驗的那一種交件型別 */
export function typeSpecForJpVerify(contributionType: string | null | undefined): string | null {
  return contributionType ? selectTypeSpec(JP_TYPE_SPEC_BLOCKS, { contributionTypes: [contributionType] }) : null;
}
