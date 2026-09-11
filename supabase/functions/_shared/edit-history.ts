/**
 * edit_history：apply 對正式表的每個變更都留一列；revert 依 contribution_id 由新到舊倒回。
 * planRevert 是純函式（可測），executeRevert 才碰 DB。
 */

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export interface EditRecord {
  id?: number;
  table_name: string;
  record_id: string;
  /** '*' 代表整列 INSERT（old_value=null、new_value=整列） */
  field: string;
  old_value: unknown;
  new_value: unknown;
  contribution_id: string | null;
  agent_name: string | null;
  reverted_at?: string | null;
}

export interface EditContext {
  contribution_id: string | null;
  agent_name: string | null;
}

/** 記一個 UPDATE（呼叫端保證已成功） */
export async function recordUpdate(
  supabase: SupabaseLike, ctx: EditContext, table: string, recordId: string, field: string, oldValue: unknown, newValue: unknown,
): Promise<void> {
  const { error } = await supabase.from("edit_history").insert({
    table_name: table, record_id: String(recordId), field, old_value: oldValue ?? null, new_value: newValue ?? null,
    contribution_id: ctx.contribution_id, agent_name: ctx.agent_name,
  });
  if (error) throw new Error(`edit_history insert: ${error.message}`);
}

/** 記一個 INSERT（整列） */
export async function recordInsert(supabase: SupabaseLike, ctx: EditContext, table: string, recordId: string, row: unknown): Promise<void> {
  await recordUpdate(supabase, ctx, table, recordId, "*", null, row);
}

export type RevertStep =
  | { op: "delete"; table: string; record_id: string; edit_id: number }
  | { op: "restore"; table: string; record_id: string; field: string; value: unknown; edit_id: number };

/**
 * 純函式：把一筆貢獻的變更倒成還原步驟（由新到舊；已還原的跳過）。
 * 同一列同一欄位多次改：最舊的 old_value 才是原值，所以先反轉再讓最後（最舊）的覆蓋。
 */
export function planRevert(edits: readonly (EditRecord & { id: number })[]): RevertStep[] {
  const live = edits.filter((e) => !e.reverted_at).sort((a, b) => b.id - a.id);
  const steps: RevertStep[] = [];
  const seen = new Set<string>();
  for (const e of live) {
    if (e.field === "*") {
      steps.push({ op: "delete", table: e.table_name, record_id: e.record_id, edit_id: e.id });
      continue;
    }
    const key = `${e.table_name}#${e.record_id}#${e.field}`;
    // 由新到舊走：每次遇到同一欄位就用更舊的 old_value 覆蓋，最後留下的是最原始的值
    const existing = steps.findIndex((s) => s.op === "restore" && `${s.table}#${s.record_id}#${s.field}` === key);
    const step: RevertStep = { op: "restore", table: e.table_name, record_id: e.record_id, field: e.field, value: e.old_value, edit_id: e.id };
    if (existing >= 0) steps[existing] = step;
    else steps.push(step);
    seen.add(key);
  }
  // 先還原欄位、再刪整列（刪列後欄位還原沒意義，順序無害但清楚）
  return [...steps.filter((s) => s.op === "restore"), ...steps.filter((s) => s.op === "delete")];
}

export async function executeRevert(supabase: SupabaseLike, contributionId: string, revertedBy: string): Promise<{ steps: RevertStep[]; reverted: number }> {
  const { data, error } = await supabase.from("edit_history").select("*").eq("contribution_id", contributionId).order("id", { ascending: true });
  if (error) throw new Error(`edit_history read: ${error.message}`);
  const steps = planRevert((data ?? []) as (EditRecord & { id: number })[]);
  for (const s of steps) {
    if (s.op === "restore") {
      const { error: e } = await supabase.from(s.table).update({ [s.field]: s.value }).eq("id", s.record_id);
      if (e) throw new Error(`revert ${s.table}.${s.field}: ${e.message}`);
    } else {
      const { error: e } = await supabase.from(s.table).delete().eq("id", s.record_id);
      if (e) throw new Error(`revert delete ${s.table}#${s.record_id}: ${e.message}`);
    }
  }
  const ids = steps.map((s) => s.edit_id);
  if (ids.length > 0) {
    const { error: e } = await supabase.from("edit_history").update({ reverted_at: new Date().toISOString(), reverted_by: revertedBy }).in("id", ids);
    if (e) throw new Error(`edit_history mark reverted: ${e.message}`);
  }
  return { steps, reverted: ids.length };
}
