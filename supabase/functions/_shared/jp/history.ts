/**
 * 日本站的查核履歷（jp-history）：某筆貢獻、某個團體、某場選舉被誰交、誰驗（理由、反證）、改了哪些欄位。
 *
 * 照搬 ../history.ts：組時間軸（buildHistory）與分頁（pageEntries）直接用正見那份純函式，
 * 這裡只換「撈資料」那一段（collectJpHistory），因為日本站的對象不是人物、政見，而是團體與選舉。
 *   - contribution：那一筆。
 *   - local_government：payload.lg_code 是這個團體碼的所有交件（團體、統計、選舉、確認の記録），加上 edit_history 掛在這個團體列的。
 *   - election：edit_history 掛在這場選舉（policy_jp.elections.id）的交件。
 * 票（contribution_votes）、欄位變更（edit_history）的欄位與正見同一套，公開範圍也一樣：不回 ip_hash、actor_id。
 * 分數：policy_jp 沒有計算欄位 effective_agree，用欄位 target_score（同 jp-contributions-feed）。
 * 裁決（adjudication）日本站還沒有，tasks／adjudications 一律空。
 */
import { JP_SCORE_COLUMNS } from "./contribution-feed.ts";
import type { HistoryContribution, HistoryData, HistoryEdit, HistoryVote } from "../history.ts";
import { fetchSourceBriefs } from "../source-read.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;

export type JpHistoryTarget = "contribution" | "local_government" | "election";
export const JP_HISTORY_TARGETS: readonly JpHistoryTarget[] = ["contribution", "local_government", "election"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LG_CODE_RE = /^\d{6}$/;
/** policy_jp.elections.id：投票日_種類[_團體碼]（例 2027-01-24_mayor_232033） */
const ELECTION_ID_RE = /^\d{4}-\d{2}-\d{2}_[a-z_]+(_\d{6})?$/;

/** 這個 target 的 id 長得對不對（不對就 400，不拿去查） */
export function jpHistoryIdValid(target: JpHistoryTarget, id: string): boolean {
  if (target === "contribution") return UUID_RE.test(id);
  if (target === "local_government") return LG_CODE_RE.test(id);
  return ELECTION_ID_RE.test(id);
}

const CONTRIBUTION_COLUMNS = "id, contribution_type, payload, source_urls, note, agent_name, agent_tool, status, review_notes, applied_at, applied_politician_id, applied_policy_id, created_at, agree_count, disagree_count, unsure_count, task_id";
export const JP_HISTORY_ENTRY_COLUMNS = `${CONTRIBUTION_COLUMNS}, ${JP_SCORE_COLUMNS}`;
const VOTE_COLUMNS = "contribution_id, verdict, note, evidence_url, agent_name, agent_tool, resolved_politician_id, created_at";
const EDIT_COLUMNS = "id, contribution_id, table_name, record_id, field, old_value, new_value, applied_at, reverted_at, reverted_by";

function ok<T>(res: { data: T | null; error: { message: string } | null }, where: string): T {
  if (res.error) throw new Error(`${where}: ${res.error.message}`);
  return (res.data ?? ([] as unknown as T));
}

/** policy_jp 的 target_score 放進正見 contributionScore 讀的 effective_agree（buildHistory 用同一套分數取法） */
export function withJpScore(rows: Array<HistoryContribution & { target_score?: number | null }>): HistoryContribution[] {
  return rows.map((r) => (typeof r.target_score === "number" ? { ...r, effective_agree: r.target_score } : r));
}

async function directContributions(supabase: SupabaseLike, target: JpHistoryTarget, id: string): Promise<HistoryContribution[]> {
  if (target === "contribution") {
    return ok<HistoryContribution[]>(await supabase.from("contributions").select(JP_HISTORY_ENTRY_COLUMNS).eq("id", id).limit(1), "contribution read");
  }
  if (target === "local_government") {
    return ok<HistoryContribution[]>(await supabase.from("contributions").select(JP_HISTORY_ENTRY_COLUMNS).eq("payload->>lg_code", id).limit(500), "contributions by lg_code");
  }
  return [];
}

async function editsOfRecord(supabase: SupabaseLike, target: JpHistoryTarget, id: string): Promise<HistoryEdit[]> {
  if (target === "contribution") return [];
  const table = target === "local_government" ? "local_governments" : "elections";
  return ok<HistoryEdit[]>(await supabase.from("edit_history").select(EDIT_COLUMNS).eq("table_name", table).eq("record_id", id).limit(500), "edit_history record");
}

/** 碰 DB：把某對象的履歷資料全撈回來（形狀同正見 collectHistory，給 buildHistory 用） */
export async function collectJpHistory(supabase: SupabaseLike, target: JpHistoryTarget, id: string): Promise<HistoryData & { origin_row: Obj | null; election_notes: string[] }> {
  const [direct, recordEdits] = await Promise.all([directContributions(supabase, target, id), editsOfRecord(supabase, target, id)]);
  const known = new Set(direct.map((c) => c.id));
  const missing = [...new Set(recordEdits.map((e) => e.contribution_id).filter((v): v is string => typeof v === "string" && !known.has(v)))];
  const extra = missing.length > 0 ? ok<HistoryContribution[]>(await supabase.from("contributions").select(JP_HISTORY_ENTRY_COLUMNS).in("id", missing).limit(500), "contributions via edits") : [];
  const contributions = withJpScore([...new Map([...direct, ...extra].map((c) => [c.id, c])).values()]);
  const ids = contributions.map((c) => c.id);
  if (ids.length === 0) return { contributions: [], votes: [], edits: [], adjudications: [], tasks: [], origin_row: null, election_notes: [] };
  const [votes, edits, sourceBriefs] = await Promise.all([
    // 1000 是 PostgREST 上限；一筆對象的票與欄位變更遠少於此（同正見 history）
    supabase.from("contribution_votes").select(VOTE_COLUMNS).in("contribution_id", ids).limit(1000),
    supabase.from("edit_history").select(EDIT_COLUMNS).in("contribution_id", ids).limit(1000),
    fetchSourceBriefs(supabase, contributions.flatMap((c) => c.source_urls ?? [])),
  ]);
  return {
    contributions,
    votes: ok<HistoryVote[]>(votes, "votes"),
    edits: ok<HistoryEdit[]>(edits, "edit_history"),
    adjudications: [],
    tasks: [],
    origin_row: null,
    election_notes: [],
    source_briefs: sourceBriefs,
  };
}
