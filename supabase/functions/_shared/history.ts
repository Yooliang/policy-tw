/**
 * 查核履歷：某個人物／政見（或單筆貢獻）被誰交、誰驗、改了什麼、有沒有裁決或還原。
 * 資料來源：contributions（誰交的）＋ contribution_votes（誰驗的、理由）＋ edit_history（欄位舊值新值、還原）＋
 *           adjudication 貢獻與 adjudicate 任務（裁決）。不回任何 ip_hash。
 * collect*（碰 DB）與 buildHistory（純函式，可測）分開。
 */

import { summarizeContribution } from "./contribution-summary.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;

export type HistoryTarget = "politician" | "policy" | "contribution";
export const HISTORY_TARGETS: readonly HistoryTarget[] = ["politician", "policy", "contribution"];
export const HISTORY_MAX_LIMIT = 50;

export interface HistoryContribution {
  id: string; contribution_type: string; payload: Obj; source_urls: string[] | null; note: string | null;
  agent_name: string | null; agent_tool: string | null; status: string; review_notes: string | null;
  applied_at: string | null; applied_politician_id: string | null; applied_policy_id: string | null; created_at: string;
  agree_count?: number | null; disagree_count?: number | null; unsure_count?: number | null; task_id?: string | null;
}
export interface HistoryVote { contribution_id: string; verdict: string; note: string | null; evidence_url: string | null; agent_name: string | null; agent_tool: string | null; resolved_politician_id: string | null; created_at: string }
export interface HistoryEdit { id: number; contribution_id: string | null; table_name: string; record_id: string; field: string; old_value: unknown; new_value: unknown; applied_at: string; reverted_at: string | null; reverted_by: string | null }
export interface HistoryTask { id: string; task_type: string; status: string; target: Obj | null; created_at: string; closed_at: string | null }

export interface HistoryData {
  contributions: HistoryContribution[];
  votes: HistoryVote[];
  edits: HistoryEdit[];
  /** contribution_type=adjudication 的貢獻（payload.contribution_id 指向原貢獻） */
  adjudications: HistoryContribution[];
  /** task_type=adjudicate 的任務（target.contribution_id 指向原貢獻） */
  tasks: HistoryTask[];
  /** politician_id → 姓名（摘要用；payload 只帶 id 時才寫得出「為「王小明」新增政見」） */
  politician_names?: Record<string, string>;
}

export interface HistoryVerifier { agent_name: string | null; agent_tool: string | null; verdict: string; note: string | null; evidence_url: string | null; resolved_politician_id: string | null; created_at: string }
export interface HistoryEditOut { table: string; record_id: string; field: string; field_label: string; old_value: unknown; new_value: unknown; applied_at: string; reverted_at: string | null; reverted_by: string | null }
export interface HistoryAdjudication { contribution_id: string; task_id: string | null; task_status: string | null; verdict: string | null; reason: string | null; agent_name: string | null; status: string; checked_urls: string[]; created_at: string }
export interface HistoryEntry {
  id: string;
  contribution_type: string;
  type_label: string;
  summary: string;
  status: string;
  status_label: string;
  agent_name: string | null;
  agent_tool: string | null;
  source_urls: string[];
  note: string | null;
  review_notes: string | null;
  created_at: string;
  applied_at: string | null;
  /** 排序用：落庫時間，沒有就提交時間 */
  at: string;
  reverted: boolean;
  agree_count: number; disagree_count: number; unsure_count: number;
  verifiers: HistoryVerifier[];
  edits: HistoryEditOut[];
  adjudications: HistoryAdjudication[];
}

const TYPE_LABEL: Record<string, string> = {
  politician: "更新人物欄位", candidacy: "參選狀態", policy: "新增政見", policy_progress: "進度更新", correction: "更正",
  task_suggestion: "任務提議", no_change: "無異動", adjudication: "裁決", answer: "回答提問", audit: "文件核對",
};
const STATUS_LABEL: Record<string, string> = {
  pending: "待驗證", verified: "已驗證", applied: "已上線", apply_failed: "上線中（自動重試）", disputed: "裁決中", rejected: "退件", reverted: "已還原",
};
const FIELD_LABEL: Record<string, string> = {
  name: "姓名", party: "政黨", birth_year: "出生年", current_position: "現職", region: "縣市", sub_region: "選區", education_level: "學歷", bio: "簡介", avatar_url: "照片網址",
  candidate_status: "參選狀態", position: "職位", election_type: "選舉類型", title: "標題", description: "說明", category: "分類", status: "狀態", proposed_date: "提出日期", election_id: "所屬選舉",
  source_url: "來源網址", progress: "進度", last_updated: "最後更新", source_note: "來源備註", "*": "整列",
};
const TABLE_LABEL: Record<string, string> = { politicians: "人物", politician_elections: "參選紀錄", policies: "政見", tracking_logs: "追蹤紀錄", contribution_tasks: "任務" };

function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "（空）";
  if (typeof v === "string") return v.length > 60 ? `${v.slice(0, 60)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "（整列）";
}

/** 有單一欄位更新時用「把 X 從 A 改為 B」，否則沿用 feed 的一句話摘要 */
function summaryFor(c: HistoryContribution, edits: HistoryEditOut[], names: Record<string, string>): string {
  const updates = edits.filter((e) => e.field !== "*");
  const inserts = edits.filter((e) => e.field === "*");
  if (c.contribution_type === "correction" && updates.length === 1) {
    const e = updates[0];
    return `把${TABLE_LABEL[e.table] ?? e.table}的${e.field_label}從「${fmtValue(e.old_value)}」改為「${fmtValue(e.new_value)}」`;
  }
  if (c.contribution_type === "correction" && updates.length > 1) {
    return `更正${TABLE_LABEL[updates[0].table] ?? updates[0].table}的 ${updates.length} 個欄位：${updates.map((e) => `${e.field_label}「${fmtValue(e.old_value)}」→「${fmtValue(e.new_value)}」`).join("；")}`;
  }
  if (c.contribution_type === "politician" && inserts.some((e) => e.table === "politicians")) {
    return `新增人物「${typeof c.payload.name === "string" ? c.payload.name : "?"}」`;
  }
  if (c.contribution_type === "politician" && updates.length > 0) {
    return `補上${updates.map((e) => e.field_label).join("、")}`;
  }
  const pid = c.applied_politician_id ?? (typeof c.payload.politician_id === "string" ? c.payload.politician_id : null);
  const payload = typeof c.payload.name === "string" || !pid || !names[pid] ? c.payload : { ...c.payload, name: names[pid] };
  return summarizeContribution({ contribution_type: c.contribution_type, payload, applied_politician_id: c.applied_politician_id, applied_policy_id: c.applied_policy_id }).summary;
}

function typeLabelFor(c: HistoryContribution, edits: HistoryEditOut[]): string {
  if (c.contribution_type === "politician" && edits.some((e) => e.field === "*" && e.table === "politicians")) return "新增人物";
  return TYPE_LABEL[c.contribution_type] ?? c.contribution_type;
}

/** 純函式：把四種來源組成時間軸（新到舊） */
export function buildHistory(data: HistoryData): HistoryEntry[] {
  const votesBy = new Map<string, HistoryVote[]>();
  for (const v of data.votes) votesBy.set(v.contribution_id, [...(votesBy.get(v.contribution_id) ?? []), v]);
  const editsBy = new Map<string, HistoryEdit[]>();
  for (const e of data.edits) if (e.contribution_id) editsBy.set(e.contribution_id, [...(editsBy.get(e.contribution_id) ?? []), e]);
  const adjBy = new Map<string, HistoryContribution[]>();
  for (const a of data.adjudications) {
    const target = typeof a.payload.contribution_id === "string" ? a.payload.contribution_id : null;
    if (target) adjBy.set(target, [...(adjBy.get(target) ?? []), a]);
  }
  const taskBy = new Map<string, HistoryTask[]>();
  for (const t of data.tasks) {
    const target = t.target && typeof t.target.contribution_id === "string" ? t.target.contribution_id : null;
    if (target) taskBy.set(target, [...(taskBy.get(target) ?? []), t]);
  }

  const entries = data.contributions
    .filter((c) => c.contribution_type !== "adjudication")
    .map((c): HistoryEntry => {
      const edits: HistoryEditOut[] = (editsBy.get(c.id) ?? [])
        .sort((a, b) => a.id - b.id)
        .map((e) => ({ table: e.table_name, record_id: e.record_id, field: e.field, field_label: FIELD_LABEL[e.field] ?? e.field, old_value: e.old_value ?? null, new_value: e.new_value ?? null, applied_at: e.applied_at, reverted_at: e.reverted_at ?? null, reverted_by: e.reverted_by ?? null }));
      const verifiers: HistoryVerifier[] = (votesBy.get(c.id) ?? [])
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((v) => ({ agent_name: v.agent_name, agent_tool: v.agent_tool, verdict: v.verdict, note: v.note, evidence_url: v.evidence_url, resolved_politician_id: v.resolved_politician_id, created_at: v.created_at }));
      const tasks = taskBy.get(c.id) ?? [];
      const adjudications: HistoryAdjudication[] = (adjBy.get(c.id) ?? [])
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((a) => ({
          contribution_id: a.id, task_id: tasks[0]?.id ?? null, task_status: tasks[0]?.status ?? null,
          verdict: typeof a.payload.verdict === "string" ? a.payload.verdict : null, reason: typeof a.payload.reason === "string" ? a.payload.reason : null,
          agent_name: a.agent_name, status: a.status, checked_urls: Array.isArray(a.payload.checked_urls) ? (a.payload.checked_urls as string[]) : [], created_at: a.created_at,
        }));
      // 有任務但還沒有人裁決：也列一筆讓頁面看得到「裁決中」
      if (adjudications.length === 0 && tasks.length > 0) {
        adjudications.push({ contribution_id: "", task_id: tasks[0].id, task_status: tasks[0].status, verdict: null, reason: null, agent_name: null, status: "open", checked_urls: [], created_at: tasks[0].created_at });
      }
      const status = c.status;
      return {
        id: c.id,
        contribution_type: c.contribution_type,
        type_label: typeLabelFor(c, edits),
        summary: summaryFor(c, edits, data.politician_names ?? {}),
        status,
        status_label: STATUS_LABEL[status] ?? status,
        agent_name: c.agent_name,
        agent_tool: c.agent_tool,
        source_urls: c.source_urls ?? [],
        note: c.note,
        review_notes: c.review_notes,
        created_at: c.created_at,
        applied_at: c.applied_at,
        at: c.applied_at ?? c.created_at,
        reverted: status === "reverted" || edits.some((e) => e.reverted_at !== null),
        agree_count: c.agree_count ?? 0, disagree_count: c.disagree_count ?? 0, unsure_count: c.unsure_count ?? 0,
        verifiers,
        edits,
        adjudications,
      };
    });
  return entries.sort((a, b) => b.at.localeCompare(a.at) || b.created_at.localeCompare(a.created_at));
}

export interface HistoryOrigin {
  /** 沒有任何貢獻紀錄時給頁面看的來源說明 */
  kind: "contributions" | "imported" | "unknown";
  note: string | null;
  source_url?: string | null;
  source_notes?: string[];
}

/** 純函式：沒有履歷時，從既有欄位講清楚資料哪來的 */
export function describeOrigin(target: HistoryTarget, row: Obj | null, electionNotes: string[], hasEntries: boolean): HistoryOrigin {
  if (hasEntries) return { kind: "contributions", note: null };
  if (target === "policy") {
    const sourceUrl = typeof row?.source_url === "string" ? row.source_url : null;
    const ai = row?.ai_extracted === true;
    return { kind: sourceUrl || ai ? "imported" : "unknown", note: ai ? "早期由 AI 搜尋匯入，尚未經過貢獻流程；來源見下方網址" : sourceUrl ? "由匯入資料建立，尚未經過 AI 貢獻流程；來源見下方網址" : "這筆資料尚未經過 AI 貢獻流程，也沒有記錄來源", source_url: sourceUrl };
  }
  if (target === "politician") {
    const notes = electionNotes.filter((n) => typeof n === "string" && n.trim().length > 0);
    return { kind: notes.length > 0 ? "imported" : "unknown", note: notes.length > 0 ? "由匯入資料建立，尚未經過 AI 貢獻流程；參選紀錄的來源備註如下" : "這筆資料尚未經過 AI 貢獻流程，也沒有記錄來源", source_notes: [...new Set(notes)] };
  }
  return { kind: "unknown", note: "找不到這筆貢獻" };
}

const CONTRIBUTION_COLUMNS = "id, contribution_type, payload, source_urls, note, agent_name, agent_tool, status, review_notes, applied_at, applied_politician_id, applied_policy_id, created_at, agree_count, disagree_count, unsure_count, task_id";
const VOTE_COLUMNS = "contribution_id, verdict, note, evidence_url, agent_name, agent_tool, resolved_politician_id, created_at";
const EDIT_COLUMNS = "id, contribution_id, table_name, record_id, field, old_value, new_value, applied_at, reverted_at, reverted_by";

function ok<T>(res: { data: T | null; error: { message: string } | null }, where: string): T {
  if (res.error) throw new Error(`${where}: ${res.error.message}`);
  return (res.data ?? ([] as unknown as T));
}

async function contributionsForTarget(supabase: SupabaseLike, target: HistoryTarget, id: string): Promise<HistoryContribution[]> {
  if (target === "contribution") {
    const res = await supabase.from("contributions").select(CONTRIBUTION_COLUMNS).eq("id", id).limit(1);
    return ok<HistoryContribution[]>(res, "contribution read");
  }
  const appliedCol = target === "policy" ? "applied_policy_id" : "applied_politician_id";
  const payloadCol = target === "policy" ? "payload->>policy_id" : "payload->>politician_id";
  const targetTable = target === "policy" ? "policies" : "politicians";
  const [applied, referenced, corrections] = await Promise.all([
    supabase.from("contributions").select(CONTRIBUTION_COLUMNS).eq(appliedCol, id).limit(500),
    supabase.from("contributions").select(CONTRIBUTION_COLUMNS).eq(payloadCol, id).limit(500),
    // correction 的目標寫在 payload.target_table／target_id
    supabase.from("contributions").select(CONTRIBUTION_COLUMNS).eq("contribution_type", "correction").eq("payload->>target_table", targetTable).eq("payload->>target_id", id).limit(500),
  ]);
  return [
    ...ok<HistoryContribution[]>(applied, "contributions applied"),
    ...ok<HistoryContribution[]>(referenced, "contributions referenced"),
    ...ok<HistoryContribution[]>(corrections, "contributions corrections"),
  ];
}

/** edit_history 直接掛在這個對象（或它的子列：參選紀錄／追蹤紀錄）上的貢獻 id */
async function contributionIdsFromEdits(supabase: SupabaseLike, target: HistoryTarget, id: string): Promise<{ ids: string[]; edits: HistoryEdit[] }> {
  if (target === "contribution") return { ids: [], edits: [] };
  const mainTable = target === "policy" ? "policies" : "politicians";
  const childTable = target === "policy" ? "tracking_logs" : "politician_elections";
  const childFk = target === "policy" ? "policy_id" : "politician_id";
  const children = ok<Array<{ id: string | number }>>(await supabase.from(childTable).select("id").eq(childFk, id).limit(500), `${childTable} ids`);
  const childIds = children.map((c) => String(c.id));
  const [main, child] = await Promise.all([
    supabase.from("edit_history").select(EDIT_COLUMNS).eq("table_name", mainTable).eq("record_id", id).limit(500),
    childIds.length > 0 ? supabase.from("edit_history").select(EDIT_COLUMNS).eq("table_name", childTable).in("record_id", childIds).limit(500) : Promise.resolve({ data: [], error: null }),
  ]);
  const edits = [...ok<HistoryEdit[]>(main, "edit_history main"), ...ok<HistoryEdit[]>(child, "edit_history child")];
  return { ids: [...new Set(edits.map((e) => e.contribution_id).filter((v): v is string => typeof v === "string"))], edits };
}

/** 碰 DB：把某對象的履歷資料全撈回來（分頁在 buildHistory 之後做） */
export async function collectHistory(supabase: SupabaseLike, target: HistoryTarget, id: string): Promise<HistoryData & { origin_row: Obj | null; election_notes: string[] }> {
  const direct = await contributionsForTarget(supabase, target, id);
  const viaEdits = await contributionIdsFromEdits(supabase, target, id);
  const known = new Set(direct.map((c) => c.id));
  const missing = viaEdits.ids.filter((cid) => !known.has(cid));
  const extra = missing.length > 0 ? ok<HistoryContribution[]>(await supabase.from("contributions").select(CONTRIBUTION_COLUMNS).in("id", missing), "contributions via edits") : [];
  const contributions = [...new Map([...direct, ...extra].map((c) => [c.id, c])).values()];
  const ids = contributions.map((c) => c.id);
  if (ids.length === 0) {
    const originRow = await originRowFor(supabase, target, id);
    return { contributions: [], votes: [], edits: [], adjudications: [], tasks: [], origin_row: originRow.row, election_notes: originRow.notes };
  }
  const politicianIds = [...new Set(contributions.flatMap((c) => [c.applied_politician_id, typeof c.payload.politician_id === "string" ? c.payload.politician_id : null]).filter((v): v is string => typeof v === "string"))];
  const [votes, edits, adjudications, tasks, originRow, names] = await Promise.all([
    supabase.from("contribution_votes").select(VOTE_COLUMNS).in("contribution_id", ids).limit(2000),
    supabase.from("edit_history").select(EDIT_COLUMNS).in("contribution_id", ids).limit(2000),
    supabase.from("contributions").select(CONTRIBUTION_COLUMNS).eq("contribution_type", "adjudication").in("payload->>contribution_id", ids).limit(500),
    supabase.from("contribution_tasks").select("id, task_type, status, target, created_at, closed_at").eq("task_type", "adjudicate").in("target->>contribution_id", ids).limit(500),
    originRowFor(supabase, target, id),
    politicianIds.length > 0 ? supabase.from("politicians").select("id, name").in("id", politicianIds) : Promise.resolve({ data: [], error: null }),
  ]);
  return {
    contributions,
    votes: ok<HistoryVote[]>(votes, "votes"),
    edits: ok<HistoryEdit[]>(edits, "edit_history"),
    adjudications: ok<HistoryContribution[]>(adjudications, "adjudications"),
    tasks: ok<HistoryTask[]>(tasks, "adjudicate tasks"),
    politician_names: Object.fromEntries(ok<Array<{ id: string; name: string }>>(names, "politician names").map((p) => [p.id, p.name])),
    origin_row: originRow.row,
    election_notes: originRow.notes,
  };
}

async function originRowFor(supabase: SupabaseLike, target: HistoryTarget, id: string): Promise<{ row: Obj | null; notes: string[] }> {
  if (target === "policy") {
    const res = await supabase.from("policies").select("id, title, source_url, ai_extracted, proposed_date").eq("id", id).maybeSingle();
    return { row: (res.data as Obj | null) ?? null, notes: [] };
  }
  if (target === "politician") {
    const [p, el] = await Promise.all([
      supabase.from("politicians").select("id, name").eq("id", id).maybeSingle(),
      supabase.from("politician_elections").select("source_note").eq("politician_id", id).limit(50),
    ]);
    return { row: (p.data as Obj | null) ?? null, notes: ((el.data ?? []) as Array<{ source_note: string | null }>).map((e) => e.source_note ?? "").filter(Boolean) };
  }
  return { row: null, notes: [] };
}

/** 純函式：cursor 分頁（cursor 是上一頁最後一筆的 at） */
export function pageEntries(entries: HistoryEntry[], limit: number, cursor: string | null): { items: HistoryEntry[]; has_more: boolean; next_cursor: string | null } {
  const filtered = cursor ? entries.filter((e) => e.at < cursor) : entries;
  const items = filtered.slice(0, limit);
  const has_more = filtered.length > limit;
  return { items, has_more, next_cursor: has_more ? items[items.length - 1].at : null };
}
