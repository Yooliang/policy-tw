import { CORRECTION_FIELDS } from "./contribution-schema.ts";
import { normalizeCorrection, splitNoOpChanges } from "./correction.ts";
import { correctionValue } from "./apply-contribution.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;

/**
 * 等票中的空操作更正退池（2026-09-23，W-Policy 回報：100 項驗證踩到 9 筆 no_op）。
 *
 * 提交端的 no_op_correction 只擋得住提交那一刻；落庫時的 superseded（#3）又要等票數夠了才會走到。
 * 中間這段——別人已經修好了、這筆還在池子裡——每張票都是白投。掃地機每輪把 pending 的 correction
 * 拿現值重比一次，**每一欄**都跟現值相同就直接標 superseded、退出驗證池。部分相同的不動（還有欄位真的要改）。
 * 比法與落庫一致：先過 correctionValue（分類正規化、清空日期轉 null），再用 sameValue。
 */

export interface PendingCorrection { id: string; payload: unknown }

/** 純函式：給 pending 更正與現值（table → id → row），回要退池的 id 與各自一樣的欄位 */
export function findNoOpPending(rows: PendingCorrection[], current: Map<string, Map<string, Obj>>): Array<{ id: string; fields: string[] }> {
  const out: Array<{ id: string; fields: string[] }> = [];
  for (const row of rows) {
    const { target_table, target_id, changes } = normalizeCorrection(row.payload);
    if (!target_table || !target_id || changes.length === 0) continue;
    const allowed = CORRECTION_FIELDS[target_table as keyof typeof CORRECTION_FIELDS] as readonly string[] | undefined;
    if (!allowed || changes.some((c) => !allowed.includes(c.field))) continue;
    const dbRow = current.get(target_table)?.get(target_id);
    if (!dbRow) continue;
    const patch: Obj = Object.fromEntries(changes.map((c) => [c.field, correctionValue(target_table, c.field, c.correct_value)]));
    const { changed, noop } = splitNoOpChanges(patch, dbRow);
    if (Object.keys(changed).length === 0) out.push({ id: row.id, fields: noop });
  }
  return out;
}

const ID_CHUNK = 100;

export async function sweepNoOpCorrections(supabase: SupabaseLike, limit = 500): Promise<{ scanned: number; superseded: string[] }> {
  // 分批取：照 created_at 舊的先，一輪最多 limit 筆（上限 1000，PostgREST max-rows）
  const { data, error } = await supabase.from("contributions").select("id, payload")
    .eq("contribution_type", "correction").eq("status", "pending")
    .order("created_at", { ascending: true }).limit(Math.min(limit, 1000));
  if (error) throw new Error(`noop sweep scan: ${error.message}`);
  const rows = (data ?? []) as PendingCorrection[];

  // 依表分組撈現值
  const idsByTable = new Map<string, Set<string>>();
  const fieldsByTable = new Map<string, Set<string>>();
  for (const r of rows) {
    const { target_table, target_id, changes } = normalizeCorrection(r.payload);
    const allowed = target_table ? CORRECTION_FIELDS[target_table as keyof typeof CORRECTION_FIELDS] as readonly string[] | undefined : undefined;
    if (!target_table || !target_id || !allowed) continue;
    if (!idsByTable.has(target_table)) { idsByTable.set(target_table, new Set()); fieldsByTable.set(target_table, new Set()); }
    idsByTable.get(target_table)!.add(target_id);
    for (const c of changes) if (allowed.includes(c.field)) fieldsByTable.get(target_table)!.add(c.field);
  }
  const current = new Map<string, Map<string, Obj>>();
  for (const [table, idSet] of idsByTable) {
    // politician_elections 的 id 是整數；被填成 UUID 的混進 in() 會讓整批報錯
    const ids = [...idSet].filter((id) => table !== "politician_elections" || /^\d+$/.test(id));
    const cols = ["id", ...fieldsByTable.get(table)!].join(", ");
    const byId = new Map<string, Obj>();
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      // query-bounds: ok — 按 id 清單取，一批最多 ID_CHUNK 列
      const { data: got, error: e } = await supabase.from(table).select(cols).in("id", ids.slice(i, i + ID_CHUNK));
      // 一批裡有型別不對的 id（實例：politician_elections 的整數 id 被填成 UUID）整批會報錯——跳過這批，不拖垮別的表
      if (e) { console.error(`noop sweep read ${table}: ${e.message}`); continue; }
      for (const g of (got ?? []) as Obj[]) byId.set(String(g.id), g);
    }
    current.set(table, byId);
  }

  const hits = findNoOpPending(rows, current);
  const superseded: string[] = [];
  for (const h of hits) {
    // 只動還在 pending 的（掃描到寫入之間可能已被投到定案）
    const { data: upd, error: e } = await supabase.from("contributions")
      .update({ status: "superseded", review_notes: `等票期間資料已經改成跟這筆更正一樣（${h.fields.join("、")} 現值相同），退出驗證池，不用再投票` })
      .eq("id", h.id).eq("status", "pending").select("id");
    if (e) throw new Error(`noop sweep update: ${e.message}`);
    if ((upd ?? []).length > 0) superseded.push(h.id);
  }
  return { scanned: rows.length, superseded };
}
