/** 派工時挑 `item.type_spec`（協議 1.93.0）：規則見 type-spec.ts 檔頭。 */
import { TYPE_SPEC_BLOCKS } from "./type-spec.gen.ts";
import { selectTypeSpec } from "./type-spec.ts";
import { TASK_BRANCHES } from "./task-guidance.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";

/** 任務：這種任務的做法＋它可能收尾的每一種交件型別 */
export function typeSpecForTask(taskType: string | null | undefined, suggested?: string | null): string | null {
  if (!taskType) return null;
  return selectTypeSpec(TYPE_SPEC_BLOCKS, {
    taskType,
    contributionTypes: [suggested ?? SUGGESTED_TYPE[taskType], ...(TASK_BRANCHES[taskType] ?? [])],
  });
}

/** 驗證：被驗的那一種交件型別 */
export function typeSpecForVerify(contributionType: string | null | undefined): string | null {
  return contributionType ? selectTypeSpec(TYPE_SPEC_BLOCKS, { contributionTypes: [contributionType] }) : null;
}
