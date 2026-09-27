/**
 * 落庫前置檢查：交件時（/contribute、/report）先唯讀查一遍 apply-contribution.ts 實際會查的東西，
 * 查到「這筆一定落不了庫」就整批回 400，不要讓它過了驗證、投票用完、才在落庫時炸。
 *
 * 起因是連續 5 次「驗證通過→落庫才失敗→重試三次退件」，每次都是事後補一條守門（見各函式註解的 issue 編號）：
 *   - #261 任務已被刪（no_change 指向不存在的手動任務）
 *   - #262 task_id 自己編（格式已在 schema 擋，這裡補「存在」）
 *   - #275 人物 uuid 填進參選紀錄 target_id（形狀已在 schema 擋）
 *   - #276 政見只給姓名、同名不只一位（已在 contribute-handler 的 ambiguous_politician_name 擋，這裡不重做）
 *   - #263 同一年已有另一種正式參選紀錄（electionTypeSwitch 會 throw）
 *
 * 一律唯讀；查詢本身出錯（資料庫錯誤）不擋交件，只 console.error——不能讓系統自己的錯擋掉代理。
 * 查詢批次化：同型別的 id 合成一次 `.in()`，一批最多 MAX_BATCH（20）筆，符合 query-bounds 的「變數 in() 有界」判準。
 */

import { normalizeCorrection } from "./correction.ts";
import { electionTypeSwitch } from "./candidate-import.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;

export interface PrecheckItem {
  contribution_type: string;
  payload: unknown;
}

export type PrecheckCode = "target_not_found" | "apply_would_fail";

export interface PrecheckProblem {
  index: number;
  code: PrecheckCode;
  path: string;
  message: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

interface PoliticianRow { merged_into: string | null }
interface PolicyRow { removed_at: string | null }

/**
 * `ok: false` 代表這次查詢本身失敗（DB 錯誤／丟例外）——呼叫端要把這批 id 一律當「查不到問題」放行，
 * 不能把「查詢失敗」跟「查了、真的不存在」混成同一種結果，否則系統自己的錯會變成擋代理的理由。
 */
interface LookupResult<T> { rows: T; ok: boolean }

async function lookupPoliticians(supabase: SupabaseLike, ids: readonly string[]): Promise<LookupResult<Map<string, PoliticianRow>>> {
  const rows = new Map<string, PoliticianRow>();
  if (ids.length === 0) return { rows, ok: true };
  try {
    // query-bounds: ok — ids 來自這一批交件（最多 MAX_BATCH 筆），變數 in()
    const { data, error } = await supabase.from("politicians").select("id, merged_into").in("id", ids);
    if (error) { console.error("precheck politicians lookup failed:", error.message); return { rows, ok: false }; }
    for (const r of (data ?? []) as Array<{ id: string; merged_into: string | null }>) rows.set(r.id, { merged_into: r.merged_into ?? null });
  } catch (e) {
    console.error("precheck politicians lookup threw:", e instanceof Error ? e.message : String(e));
    return { rows, ok: false };
  }
  return { rows, ok: true };
}

async function lookupPolicies(supabase: SupabaseLike, ids: readonly string[]): Promise<LookupResult<Map<string, PolicyRow>>> {
  const rows = new Map<string, PolicyRow>();
  if (ids.length === 0) return { rows, ok: true };
  try {
    // query-bounds: ok — ids 來自這一批交件（最多 MAX_BATCH 筆），變數 in()
    const { data, error } = await supabase.from("policies").select("id, removed_at").in("id", ids);
    if (error) { console.error("precheck policies lookup failed:", error.message); return { rows, ok: false }; }
    for (const r of (data ?? []) as Array<{ id: string; removed_at: string | null }>) rows.set(r.id, { removed_at: r.removed_at ?? null });
  } catch (e) {
    console.error("precheck policies lookup threw:", e instanceof Error ? e.message : String(e));
    return { rows, ok: false };
  }
  return { rows, ok: true };
}

async function lookupElectionRows(supabase: SupabaseLike, ids: readonly number[]): Promise<LookupResult<Set<number>>> {
  const rows = new Set<number>();
  if (ids.length === 0) return { rows, ok: true };
  try {
    // query-bounds: ok — ids 來自這一批交件（最多 MAX_BATCH 筆），變數 in()
    const { data, error } = await supabase.from("politician_elections").select("id").in("id", ids);
    if (error) { console.error("precheck politician_elections lookup failed:", error.message); return { rows, ok: false }; }
    for (const r of (data ?? []) as Array<{ id: number }>) rows.add(r.id);
  } catch (e) {
    console.error("precheck politician_elections lookup threw:", e instanceof Error ? e.message : String(e));
    return { rows, ok: false };
  }
  return { rows, ok: true };
}

async function lookupTasks(supabase: SupabaseLike, ids: readonly string[]): Promise<LookupResult<Set<string>>> {
  const rows = new Set<string>();
  if (ids.length === 0) return { rows, ok: true };
  try {
    // query-bounds: ok — ids 來自這一批交件（最多 MAX_BATCH 筆），變數 in()
    const { data, error } = await supabase.from("contribution_tasks").select("id").in("id", ids);
    if (error) { console.error("precheck contribution_tasks lookup failed:", error.message); return { rows, ok: false }; }
    for (const r of (data ?? []) as Array<{ id: string }>) rows.add(r.id);
  } catch (e) {
    console.error("precheck contribution_tasks lookup threw:", e instanceof Error ? e.message : String(e));
    return { rows, ok: false };
  }
  return { rows, ok: true };
}

interface ExistingParticipation { politician_id: string; election_id: number; election_type: string | null; candidate_status: string | null }

async function lookupParticipations(supabase: SupabaseLike, politicianIds: readonly string[], electionIds: readonly number[]): Promise<LookupResult<ExistingParticipation[]>> {
  if (politicianIds.length === 0 || electionIds.length === 0) return { rows: [], ok: true };
  try {
    // query-bounds: ok — 兩邊 id 都來自這一批交件（最多 MAX_BATCH 筆），變數 in()
    const { data, error } = await supabase.from("politician_elections")
      .select("politician_id, election_id, election_type, candidate_status")
      .in("politician_id", politicianIds).in("election_id", electionIds);
    if (error) { console.error("precheck candidacy lookup failed:", error.message); return { rows: [], ok: false }; }
    return { rows: (data ?? []) as ExistingParticipation[], ok: true };
  } catch (e) {
    console.error("precheck candidacy lookup threw:", e instanceof Error ? e.message : String(e));
    return { rows: [], ok: false };
  }
}

/**
 * 逐型別查落庫會用到的對象，回這一批裡查到的問題（唯讀，出錯就放行）。
 * `skip`：已經被其他守門處理過（併成同意票、already_submitted 等）的索引，不用再查。
 */
export async function precheckApplyTargets(
  supabase: SupabaseLike,
  items: ReadonlyArray<PrecheckItem>,
  skip: ReadonlySet<number>,
): Promise<PrecheckProblem[]> {
  const entries = items.map((item, i) => ({ item, i })).filter(({ i }) => !skip.has(i));
  if (entries.length === 0) return [];

  const politicianIds = new Set<string>();
  const policyIds = new Set<string>();
  const electionRowIds = new Set<number>();
  const taskIds = new Set<string>();
  interface CandidacyCheck { index: number; politicianId: string; electionId: number; electionType: string; position: string | null }
  const candidacyChecks: CandidacyCheck[] = [];

  for (const { item, i } of entries) {
    const p = (item.payload && typeof item.payload === "object" ? item.payload : {}) as Obj;
    switch (item.contribution_type) {
      case "correction": {
        const { target_table, target_id } = normalizeCorrection(p);
        if (!target_table || !target_id) break; // schema 已擋，這裡不重複報
        if (target_table === "politicians") politicianIds.add(target_id);
        else if (target_table === "policies") policyIds.add(target_id);
        else if (target_table === "politician_elections") {
          const n = Number(target_id);
          if (Number.isInteger(n)) electionRowIds.add(n);
        }
        break;
      }
      case "removal": {
        const id = str(p.target_id);
        if (id) policyIds.add(id);
        break;
      }
      case "merge_politician": {
        const keep = str(p.keep_id), remove = str(p.remove_id);
        if (keep) politicianIds.add(keep);
        if (remove) politicianIds.add(remove);
        break;
      }
      case "policy": {
        const pid = str(p.politician_id);
        if (pid) politicianIds.add(pid);
        break;
      }
      case "policy_progress": {
        const pid = str(p.politician_id);
        if (pid) politicianIds.add(pid);
        const polId = str(p.policy_id);
        if (polId) policyIds.add(polId);
        break;
      }
      case "candidacy": {
        const pid = str(p.politician_id);
        if (pid) {
          politicianIds.add(pid);
          const electionId = int(p.election_id);
          const electionType = str(p.election_type);
          if (electionId !== null && electionType) {
            candidacyChecks.push({ index: i, politicianId: pid, electionId, electionType, position: str(p.position) });
          }
        }
        break;
      }
      case "no_change": {
        const taskId = str(p.task_id);
        if (taskId && !taskId.startsWith("auto:")) taskIds.add(taskId);
        break;
      }
    }
  }

  const [politicians, policies, electionRows, tasks, participations] = await Promise.all([
    lookupPoliticians(supabase, [...politicianIds]),
    lookupPolicies(supabase, [...policyIds]),
    lookupElectionRows(supabase, [...electionRowIds]),
    lookupTasks(supabase, [...taskIds]),
    lookupParticipations(supabase, [...new Set(candidacyChecks.map((c) => c.politicianId))], [...new Set(candidacyChecks.map((c) => c.electionId))]),
  ]);
  const politicianRows = politicians.rows, policyRows = policies.rows, electionRowExists = electionRows.rows, taskRows = tasks.rows;

  const problems: PrecheckProblem[] = [];
  // 查詢本身失敗（DB 錯誤／丟例外）：這批 id 一律當「查不到問題」放行，不能把系統的錯當成擋代理的理由
  const checkPolitician = (i: number, id: string, path: string, verb: string): boolean => {
    if (!politicians.ok) return true;
    const row = politicianRows.get(id);
    if (!row) { problems.push({ index: i, code: "target_not_found", path, message: `找不到人物 ${id}，${verb}` }); return false; }
    if (row.merged_into) { problems.push({ index: i, code: "apply_would_fail", path, message: `人物 ${id} 已被合併到 ${row.merged_into}，請改帶 ${row.merged_into}` }); return false; }
    return true;
  };
  const checkPolicy = (i: number, id: string, path: string, verb: string, removedVerb: string): boolean => {
    if (!policies.ok) return true;
    const row = policyRows.get(id);
    if (!row) { problems.push({ index: i, code: "target_not_found", path, message: `找不到政見 ${id}，${verb}` }); return false; }
    if (row.removed_at) { problems.push({ index: i, code: "apply_would_fail", path, message: `政見 ${id} 已被移除，${removedVerb}` }); return false; }
    return true;
  };

  for (const { item, i } of entries) {
    const p = (item.payload && typeof item.payload === "object" ? item.payload : {}) as Obj;
    switch (item.contribution_type) {
      case "correction": {
        const { target_table, target_id } = normalizeCorrection(p);
        if (!target_table || !target_id) break;
        if (target_table === "politicians") checkPolitician(i, target_id, "payload.target_id", "這筆更正無法落庫：請重新確認 target_id（任務 current 裡的 id）");
        else if (target_table === "policies") checkPolicy(i, target_id, "payload.target_id", "這筆更正無法落庫：請重新確認 target_id", "更正它落不到現在的頁面上；如果認為不該移除，請在 note 說明理由請維護者還原");
        else if (target_table === "politician_elections" && electionRows.ok) {
          const n = Number(target_id);
          if (Number.isInteger(n) && !electionRowExists.has(n)) {
            problems.push({ index: i, code: "target_not_found", path: "payload.target_id", message: `找不到參選紀錄 ${target_id}，這筆更正無法落庫：請重新確認 target_id（是整數 id，不是人物 uuid）` });
          }
        }
        break;
      }
      case "removal": {
        const id = str(p.target_id);
        if (id) checkPolicy(i, id, "payload.target_id", "無法移除：請重新確認 target_id", "先前已經移除過了，不用再交一次");
        break;
      }
      case "merge_politician": {
        const keep = str(p.keep_id), remove = str(p.remove_id);
        if (keep) checkPolitician(i, keep, "payload.keep_id", "無法合併（keep_id）");
        if (remove) checkPolitician(i, remove, "payload.remove_id", "無法合併（remove_id）");
        break;
      }
      case "policy": {
        const pid = str(p.politician_id);
        if (pid) checkPolitician(i, pid, "payload.politician_id", "這筆政見無法落庫（不會為了一條政見建新人物）");
        break;
      }
      case "policy_progress": {
        const pid = str(p.politician_id);
        if (pid) checkPolitician(i, pid, "payload.politician_id", "這筆進度更新無法落庫");
        const polId = str(p.policy_id);
        if (polId) checkPolicy(i, polId, "payload.policy_id", "這筆進度更新無法落庫", "不接受進度更新");
        break;
      }
      case "candidacy": {
        const pid = str(p.politician_id);
        if (pid) checkPolitician(i, pid, "payload.politician_id", "這筆參選紀錄無法落庫");
        break;
      }
      case "no_change": {
        const taskId = str(p.task_id);
        if (taskId && !taskId.startsWith("auto:") && tasks.ok && !taskRows.has(taskId)) {
          problems.push({ index: i, code: "target_not_found", path: "payload.task_id", message: `找不到任務 ${taskId}，可能已被刪除或關閉，沒有可關的任務；請用 GET /next 領新任務` });
        }
        break;
      }
    }
  }

  // 候選人同一年換選舉別：跟 apply-contribution.ts 的 upsertParticipation 同一套判準（candidate-import.ts 的 electionTypeSwitch）
  for (const c of candidacyChecks) {
    if (!participations.ok) continue;
    const existing = participations.rows.find((e) => e.politician_id === c.politicianId && e.election_id === c.electionId);
    if (!existing) continue;
    try {
      electionTypeSwitch({ election_type: existing.election_type, candidate_status: existing.candidate_status }, { election_type: c.electionType, position: c.position });
    } catch (e) {
      problems.push({ index: c.index, code: "apply_would_fail", path: "payload.election_type", message: e instanceof Error ? e.message : String(e) });
    }
  }

  return problems;
}
