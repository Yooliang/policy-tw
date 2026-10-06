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
  | { op: "restore"; table: string; record_id: string; field: string; value: unknown; edit_id: number }
  /** field='*'、old=整列、new=NULL：合併時被刪掉的列，還原＝整列 INSERT 回去（2026-09-20） */
  | { op: "reinsert"; table: string; record_id: string; row: Record<string, unknown>; edit_id: number };

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
      if (e.new_value === null && e.old_value && typeof e.old_value === "object") {
        steps.push({ op: "reinsert", table: e.table_name, record_id: e.record_id, row: e.old_value as Record<string, unknown>, edit_id: e.id });
      } else {
        steps.push({ op: "delete", table: e.table_name, record_id: e.record_id, edit_id: e.id });
      }
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
  // 先把被刪的列放回去、再還原欄位、最後刪掉當時新增的列（刪列後欄位還原沒意義，順序無害但清楚）
  return [...steps.filter((s) => s.op === "reinsert"), ...steps.filter((s) => s.op === "restore"), ...steps.filter((s) => s.op === "delete")];
}

/** 還原步驟裡同一列（表＋id）的欄位併成一個 patch（純函式） */
export function groupRestores(steps: readonly RevertStep[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const s of steps) {
    if (s.op !== "restore") continue;
    const key = `${s.table}#${s.record_id}`;
    const patch = out.get(key) ?? {};
    patch[s.field] = s.value;
    out.set(key, patch);
  }
  return out;
}

/** 出處在出處表、資料表沒有 source_url 欄的兩張表（#347 第二階段 B）。履歷裡這兩張表的 field='source_url' 是「換主要出處」 */
const SOURCE_URL_TABLES: ReadonlySet<string> = new Set(["policies", "tracking_logs"]);

/** 把一筆政見／進度的主要出處換回舊網址（舊值空白＝沒有主要出處）；失敗丟出去，整筆還原不標成已還原 */
async function restorePrimarySource(supabase: SupabaseLike, table: string, recordId: string, url: unknown): Promise<void> {
  const { error } = await supabase.rpc("source_set_primary", {
    p_target_table: table, p_target_id: String(recordId), p_url: typeof url === "string" ? url : null, p_origin: "revert",
  });
  if (error) throw new Error(`revert ${table}#${recordId}.source_url（source_set_primary）: ${error.message}`);
}

export async function executeRevert(supabase: SupabaseLike, contributionId: string, revertedBy: string): Promise<{ steps: RevertStep[]; reverted: number }> {
  const { data, error } = await supabase.from("edit_history").select("*").eq("contribution_id", contributionId).order("id", { ascending: true });
  if (error) throw new Error(`edit_history read: ${error.message}`);
  const steps = planRevert((data ?? []) as (EditRecord & { id: number })[]);
  // 同一列的欄位還原併成一次 UPDATE（2026-10-06，#344）：election_districts 的 CHECK 要求 seats 與 seats_basis
  // 同時有值或同時空白，一欄一欄還原的話，中間那一步一定違反 CHECK、整筆還原失敗
  const restores = groupRestores(steps);
  const restored = new Set<string>();
  for (const s of steps) {
    if (s.op === "restore") {
      const key = `${s.table}#${s.record_id}`;
      if (restored.has(key)) continue;
      restored.add(key);
      const patch = { ...restores.get(key)! };
      // 政見與進度的 source_url 不在資料表裡（#347 第二階段 B）：還原＝把主要出處換回舊網址（source_set_primary），不寫資料表
      const hasSourceUrl = SOURCE_URL_TABLES.has(s.table) && "source_url" in patch;
      const oldSourceUrl = hasSourceUrl ? patch.source_url : undefined;
      if (hasSourceUrl) delete patch.source_url;
      if (Object.keys(patch).length > 0) {
        const { error: e } = await supabase.from(s.table).update(patch).eq("id", s.record_id);
        if (e) throw new Error(`revert ${s.table}.${Object.keys(patch).join(",")}: ${e.message}`);
      }
      if (hasSourceUrl) await restorePrimarySource(supabase, s.table, s.record_id, oldSourceUrl);
    } else if (s.op === "reinsert") {
      // 被刪掉的政見／進度放回去：整列快照裡的 source_url 不寫資料表，放回去之後把主要出處接回去
      let row = s.row;
      let primaryUrl: unknown;
      if (SOURCE_URL_TABLES.has(s.table) && "source_url" in row) {
        const { source_url, ...rest } = row;
        row = rest;
        primaryUrl = source_url;
      }
      const { error: e } = await supabase.from(s.table).insert(row);
      if (e) throw new Error(`revert reinsert ${s.table}#${s.record_id}: ${e.message}`);
      if (typeof primaryUrl === "string" && primaryUrl.trim()) await restorePrimarySource(supabase, s.table, s.record_id, primaryUrl);
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
