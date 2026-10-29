/**
 * 查核履歷：某個人物／政見（或單筆貢獻）被誰交、誰驗、改了什麼、有沒有裁決或還原。
 * 資料來源：contributions（誰交的）＋ contribution_votes（誰驗的、理由）＋ edit_history（欄位舊值新值、還原）＋
 *           adjudication 貢獻與 adjudicate 任務（裁決）。不回任何 ip_hash。
 * collect*（碰 DB）與 buildHistory（純函式，可測）分開。
 */

import { summarizeContribution, type SummaryLookup } from "./contribution-summary.ts";
import { partyDisplayName } from "./party-alias.ts";
import { loadSummaryLookup } from "./summary-lookup.ts";
import { contributionScore, SCORE_COLUMNS } from "./contribution-score.ts";
import { fetchSourceBriefs, primaryUrlOf, type SourceBrief, type SourceView, viewFromList, viewSources } from "./source-read.ts";

// 代理交的 payload 可能把 id 寫成 "null"、"unknown"；不是 uuid 的不拿去查，否則整份履歷 400
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;

export type HistoryTarget = "politician" | "policy" | "contribution" | "question";
export const HISTORY_TARGETS: readonly HistoryTarget[] = ["politician", "policy", "contribution", "question"];
export const HISTORY_MAX_LIMIT = 50;

export interface HistoryContribution {
  id: string; contribution_type: string; payload: Obj; source_urls: string[] | null; note: string | null;
  agent_name: string | null; agent_tool: string | null; status: string; review_notes: string | null;
  applied_at: string | null; applied_politician_id: string | null; applied_policy_id: string | null; created_at: string;
  agree_count?: number | null; disagree_count?: number | null; unsure_count?: number | null; task_id?: string | null;
  /** 分數與目標分數的來源欄位（SCORE_COLUMNS）；跟貢獻看板同一份取法，見 contribution-score.ts */
  score?: number | null; effective_agree?: number | null;
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
  policy_titles?: Record<string, string>;
  election_labels?: Record<string, string>;
  /** 摘要用的完整 id → 名稱對照（政見、脈絡、政黨、地區、裁決的原貢獻…）；上面三個舊欄位保留給只給名字的呼叫端 */
  summary_lookup?: SummaryLookup;
  /** 交件的 source_urls 在出處表裡的等級、認定根據與存檔網址（#347 第二階段 A）；沒給就照網域自動判斷 */
  source_briefs?: ReadonlyMap<string, SourceBrief>;
}

export interface HistoryVerifier { agent_name: string | null; agent_tool: string | null; verdict: string; note: string | null; evidence_url: string | null; resolved_politician_id: string | null; created_at: string }
export interface HistoryEditOut { table: string; record_id: string; field: string; field_label: string; old_value: unknown; new_value: unknown; applied_at: string; reverted_at: string | null; reverted_by: string | null }
export interface HistoryAdjudication { contribution_id: string; task_id: string | null; task_status: string | null; verdict: string | null; reason: string | null; agent_name: string | null; status: string; checked_urls: string[]; created_at: string }
export interface HistoryEntry {
  id: string;
  contribution_type: string;
  type_label: string;
  summary: string;
  /** 去掉「誰＋做了什麼」前綴的版本（人物頁／政見頁的履歷已有型別標籤、頁面就是那個對象，用這個不重複）；沒有可去的前綴就等於 summary */
  detail: string;
  status: string;
  status_label: string;
  agent_name: string | null;
  agent_tool: string | null;
  source_urls: string[];
  /** 同一批網址，帶出處表的等級（official／self／media／other）、認定根據與存檔網址；畫面用小標籤與「存檔」連結（#347 第二階段 A） */
  sources: SourceView[];
  note: string | null;
  review_notes: string | null;
  created_at: string;
  applied_at: string | null;
  /** 排序用：落庫時間，沒有就提交時間 */
  at: string;
  reverted: boolean;
  agree_count: number; disagree_count: number; unsure_count: number;
  /** 分數制（2026-09-21）：累計分數（可為負）與目標分數，取法與貢獻看板一致（contribution-score.ts）；畫面畫成拉鋸條 */
  score: number; target_score: number;
  verifiers: HistoryVerifier[];
  edits: HistoryEditOut[];
  adjudications: HistoryAdjudication[];
}

const TYPE_LABEL: Record<string, string> = {
  politician: "更新人物欄位", candidacy: "參選狀態", policy: "新增政見", policy_progress: "進度更新", correction: "更正",
  task_suggestion: "任務提議", no_change: "無異動", adjudication: "裁決", answer: "回答提問", audit: "文件核對",
  // 政策脈絡（#349）
  lineage: "政策脈絡", lineage_participants: "脈絡參與角色", lineage_handover: "脈絡交接", lineage_link: "脈絡上下級關聯",
  // 政黨（#346 第二階段）
  party_info: "政黨資訊",
  // 日本站人物頭像（policy-ops#162）
  politician_avatar: "人物頭像",
};
const STATUS_LABEL: Record<string, string> = {
  pending: "待驗證", verified: "已驗證", applied: "已上線", apply_failed: "上線中（自動重試）", superseded: "同宣稱已由他筆上線", disputed: "裁決中", rejected: "退件", withdrawn: "已撤回", reverted: "已還原",
};
const FIELD_LABEL: Record<string, string> = {
  name: "姓名", party: "政黨", birth_year: "出生年", current_position: "現職", region: "縣市", sub_region: "選區", education_level: "學歷", bio: "簡介", avatar_url: "照片網址",
  // 參選狀態：2026-10-06 起落庫寫 candidacy_status；舊履歷的 candidate_status／election_result 留著（#345，第二階段 B 刪欄後歷史仍要看得懂）
  candidate_status: "參選狀態", candidacy_status: "參選狀態", election_result: "選舉結果", position: "職位", election_type: "選舉類型", title: "標題", description: "說明", category: "分類", status: "狀態", proposed_date: "提出日期", election_id: "所屬選舉",
  source_url: "來源網址", progress: "進度", last_updated: "最後更新", source_note: "來源備註", audit: "核對來源", "*": "整列",
  // 政見三要素（#364）
  stated: "原文有沒有寫", text: "要素內容", deadline_date: "期限日期", source_locator: "原句位置",
  // 政策脈絡（#349）
  lineage_id: "所屬脈絡", origin: "政見來源", summary: "摘要", role: "角色", basis: "依據", note: "說明",
  handover_type: "交接型態", decided_on: "判定日期", link_type: "關聯型態",
  // 參選紀錄（#345 後續）：退選前有沒有登記；不參選重查蓋的章
  withdrawn_after_filing: "退選前有沒有登記", verified: "核對過登記名冊",
  // 參選紀錄的政黨：觸發器 politician_election_party_from_candidacy 補 party 時寫（20261018020000）
  party_id: "推薦政黨", party_basis: "政黨依據",
  // 政黨（#346 第二階段）
  valid_from: "名稱起始日", valid_to: "名稱停用日", predecessor_id: "前身",
};
const TABLE_LABEL: Record<string, string> = {
  politicians: "人物", politician_elections: "參選紀錄", policies: "政見", tracking_logs: "追蹤紀錄", contribution_tasks: "任務", policy_elements: "政見三要素",
  lineages: "政策脈絡", lineage_participants: "脈絡參與角色", handovers: "脈絡交接", lineage_links: "脈絡上下級關聯", lineage_candidate_reviews: "脈絡候選清查",
  parties: "政黨",
};

/** party_basis 的值（參選紀錄上政黨的根據）→ 給人看的字 */
const PARTY_BASIS_LABEL: Record<string, string> = { contribution: "交件", person_single: "人物唯一一筆參選紀錄", cec: "中選會名冊（系統直接寫）" };

/**
 * 履歷的 party_id／party_basis 變更：值換成給人看的字，UI 不印 id（#650）。
 * party_id 的數字 → 政黨名稱（對照表沒有就「（已記錄）」）；party_id 空而同一次改動的 party_basis 有值＝那一次是無黨籍。
 * party_id 空而依據也空＝不知道，維持空。
 */
function displayEditValues(edits: HistoryEditOut[], lookup: SummaryLookup): HistoryEditOut[] {
  const basisOf = (e: HistoryEditOut, side: "old_value" | "new_value") =>
    edits.find((b) => b.field === "party_basis" && b.table === e.table && b.record_id === e.record_id)?.[side] ?? null;
  const partyName = (v: unknown): string => lookup.parties?.[String(v)] ?? "（已記錄）";
  return edits.map((e) => {
    if (e.field === "party_id") {
      const one = (side: "old_value" | "new_value") => {
        const v = e[side];
        return v === null || v === undefined || v === "" ? (basisOf(e, side) ? "無黨籍" : null) : partyName(v);
      };
      return { ...e, old_value: one("old_value"), new_value: one("new_value") };
    }
    if (e.field === "party_basis") {
      const one = (v: unknown) => (typeof v === "string" ? (PARTY_BASIS_LABEL[v] ?? "（已記錄）") : null);
      return { ...e, old_value: one(e.old_value), new_value: one(e.new_value) };
    }
    return e;
  });
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "（空）";
  if (typeof v === "string") return v.length > 60 ? `${v.slice(0, 60)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "（整列）";
}

/**
 * 有單一欄位更新時用「把 X 從 A 改為 B」，否則沿用 feed 的一句話摘要。
 * detail＝同一句拿掉「把人物／政見的」這種頁面本身已經講過的前綴。
 */
function summaryFor(c: HistoryContribution, edits: HistoryEditOut[], lookup: SummaryLookup): { summary: string; detail: string } {
  const updates = edits.filter((e) => e.field !== "*");
  const inserts = edits.filter((e) => e.field === "*");
  // 改的就是頁面主體（人物、政見）時省掉「把人物的」；其他表（參選紀錄、追蹤紀錄…）要留著讓讀者知道改了哪一筆
  const selfTable = (t: string) => t === "politicians" || t === "policies";
  if (c.contribution_type === "correction" && updates.length === 1) {
    const e = updates[0];
    const change = `${e.field_label}從「${fmtValue(e.old_value)}」改為「${fmtValue(e.new_value)}」`;
    const head = TABLE_LABEL[e.table] ?? "資料";
    return { summary: `把${head}的${change}`, detail: selfTable(e.table) ? change : `${head}的${change}` };
  }
  if (c.contribution_type === "correction" && updates.length > 1) {
    const head = TABLE_LABEL[updates[0].table] ?? "資料";
    const changes = updates.map((e) => `${e.field_label}「${fmtValue(e.old_value)}」→「${fmtValue(e.new_value)}」`).join("；");
    return { summary: `更正${head}的 ${updates.length} 個欄位：${changes}`, detail: selfTable(updates[0].table) ? `${updates.length} 個欄位：${changes}` : `${head}的 ${updates.length} 個欄位：${changes}` };
  }
  if (c.contribution_type === "politician" && inserts.some((e) => e.table === "politicians")) {
    const who = typeof c.payload.name === "string" ? c.payload.name : "（未填姓名）";
    return { summary: `新增人物「${who}」`, detail: `「${who}」` };
  }
  if (c.contribution_type === "politician" && updates.length > 0) {
    const s = `補上${updates.map((e) => e.field_label).join("、")}`;
    return { summary: s, detail: updates.map((e) => e.field_label).join("、") };
  }
  // 補政黨的 candidacy（party_roster 臂）：參選狀態其實沒改——沒有整列新增、也沒有狀態欄的變動——標題照實際改的欄位講，
  // 不能沿用摘要的「參選狀態改為…」（蘇清吉 2026-10-18 的履歷就因此跟 10-07 的名冊清查長得一模一樣）
  if (c.contribution_type === "candidacy" && edits.length > 0
    && !edits.some((e) => e.field === "*" || e.field === "candidacy_status" || e.field === "candidate_status" || e.field === "election_result")) {
    const party = updates.find((e) => e.field === "party_id");
    if (party) {
      const name = typeof party.new_value === "string" && party.new_value !== "（已記錄）" ? party.new_value : partyDisplayName(typeof c.payload.party === "string" ? c.payload.party : "") || "（已記錄）";
      return { summary: `補上這一屆的推薦政黨：${name}`, detail: `推薦政黨：${name}` };
    }
    const labels = [...new Set(updates.map((e) => e.field_label))].join("、");
    return { summary: `更新參選紀錄的${labels}`, detail: labels };
  }
  const polId = c.applied_policy_id
    ?? (typeof c.payload.policy_id === "string" ? c.payload.policy_id : null)
    ?? (c.payload.target_table === "policies" && typeof c.payload.target_id === "string" ? c.payload.target_id : null);
  const pid = c.applied_politician_id ?? (typeof c.payload.politician_id === "string" ? c.payload.politician_id : null);
  const withName = typeof c.payload.name === "string" || !pid || !lookup.politicians?.[pid] ? c.payload : { ...c.payload, name: lookup.politicians[pid] };
  const withTitle = typeof c.payload.policy_title === "string" || !polId || !lookup.policies?.[polId]
    ? withName
    : { ...withName, policy_title: lookup.policies[polId] };
  const elecKey = c.payload.target_table === "politician_elections" && (typeof c.payload.target_id === "string" || typeof c.payload.target_id === "number")
    ? String(c.payload.target_id)
    : null;
  const payload = elecKey && lookup.elections?.[elecKey] ? { ...withTitle, target_label: lookup.elections[elecKey] } : withTitle;
  const r = summarizeContribution({ contribution_type: c.contribution_type, payload, applied_politician_id: c.applied_politician_id, applied_policy_id: c.applied_policy_id, lookup });
  return { summary: r.summary, detail: r.detail };
}

/** 舊三欄（只給名字的呼叫端）與完整對照合併；完整對照優先 */
function summaryLookupOf(data: HistoryData): SummaryLookup {
  const l = data.summary_lookup ?? {};
  return {
    ...l,
    politicians: { ...(data.politician_names ?? {}), ...(l.politicians ?? {}) },
    policies: { ...(data.policy_titles ?? {}), ...(l.policies ?? {}) },
    elections: { ...(data.election_labels ?? {}), ...(l.elections ?? {}) },
  };
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
      const edits: HistoryEditOut[] = displayEditValues((editsBy.get(c.id) ?? [])
        .sort((a, b) => a.id - b.id)
        .map((e) => ({ table: e.table_name, record_id: e.record_id, field: e.field, field_label: FIELD_LABEL[e.field] ?? e.field, old_value: e.old_value ?? null, new_value: e.new_value ?? null, applied_at: e.applied_at, reverted_at: e.reverted_at ?? null, reverted_by: e.reverted_by ?? null })), summaryLookupOf(data));
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
        ...summaryFor(c, edits, summaryLookupOf(data)),
        status,
        status_label: STATUS_LABEL[status] ?? status,
        agent_name: c.agent_name,
        agent_tool: c.agent_tool,
        source_urls: c.source_urls ?? [],
        sources: viewSources(c.source_urls, data.source_briefs ?? new Map()),
        note: c.note,
        review_notes: c.review_notes,
        created_at: c.created_at,
        applied_at: c.applied_at,
        at: c.applied_at ?? c.created_at,
        reverted: status === "reverted" || edits.some((e) => e.reverted_at !== null),
        agree_count: c.agree_count ?? 0, disagree_count: c.disagree_count ?? 0, unsure_count: c.unsure_count ?? 0,
        ...contributionScore(c),
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
  /** 同一個出處帶等級與存檔網址（出處表的主要出處；#347 第二階段 B 起沒有舊欄位 policies.source_url 的退路） */
  source?: SourceView | null;
  source_notes?: string[];
}

/** 純函式：沒有履歷時，從既有欄位講清楚資料哪來的 */
export function describeOrigin(target: HistoryTarget, row: Obj | null, electionNotes: string[], hasEntries: boolean): HistoryOrigin {
  if (hasEntries) return { kind: "contributions", note: null };
  if (target === "policy") {
    // 出處表的主要出處（#347 第二階段 B：資料表沒有 source_url 欄了）；沒有出處列＝我們沒有出處
    const sourceUrl = primaryUrlOf(row?.sources);
    const ai = row?.ai_extracted === true;
    return {
      kind: sourceUrl || ai ? "imported" : "unknown",
      note: ai ? "早期由 AI 搜尋匯入，尚未經過貢獻流程；來源見下方網址" : sourceUrl ? "由匯入資料建立，尚未經過 AI 貢獻流程；來源見下方網址" : "這筆資料尚未經過 AI 貢獻流程，也沒有記錄來源",
      source_url: sourceUrl,
      source: sourceUrl ? viewFromList(row?.sources, sourceUrl) : null,
    };
  }
  if (target === "question") {
    // 訪客的提問：沒有任何處理紀錄時要講清楚，不要留白（2026-09-20：一題 Facebook 提問卡了八天，頁面只寫「正在查證」）
    return { kind: "unknown", note: "還沒有 AI 代理處理過這一題；派出後每一次處理（回答、查不到的回報、驗證投票）都會列在這裡" };
  }
  if (target === "politician") {
    const notes = electionNotes.filter((n) => typeof n === "string" && n.trim().length > 0);
    return { kind: notes.length > 0 ? "imported" : "unknown", note: notes.length > 0 ? "由匯入資料建立，尚未經過 AI 貢獻流程；參選紀錄的來源備註如下" : "這筆資料尚未經過 AI 貢獻流程，也沒有記錄來源", source_notes: [...new Set(notes)] };
  }
  return { kind: "unknown", note: "找不到這筆貢獻" };
}

const CONTRIBUTION_COLUMNS = "id, contribution_type, payload, source_urls, note, agent_name, agent_tool, status, review_notes, applied_at, applied_politician_id, applied_policy_id, created_at, agree_count, disagree_count, unsure_count, task_id";
/**
 * 要列在履歷上的貢獻：多撈分數與目標分數兩欄（SCORE_COLUMNS）。
 * effective_agree 是 PostgREST 計算欄位，每列會多跑一次 SQL 函式，所以裁決那條查詢（只當附註、不列在時間軸上）不帶。
 */
export const HISTORY_ENTRY_COLUMNS = `${CONTRIBUTION_COLUMNS}, ${SCORE_COLUMNS}`;
const VOTE_COLUMNS ="contribution_id, verdict, note, evidence_url, agent_name, agent_tool, resolved_politician_id, created_at";
const EDIT_COLUMNS = "id, contribution_id, table_name, record_id, field, old_value, new_value, applied_at, reverted_at, reverted_by";

function ok<T>(res: { data: T | null; error: { message: string } | null }, where: string): T {
  if (res.error) throw new Error(`${where}: ${res.error.message}`);
  return (res.data ?? ([] as unknown as T));
}

async function contributionsForTarget(supabase: SupabaseLike, target: HistoryTarget, id: string): Promise<HistoryContribution[]> {
  if (target === "contribution") {
    const res = await supabase.from("contributions").select(HISTORY_ENTRY_COLUMNS).eq("id", id).limit(1);
    return ok<HistoryContribution[]>(res, "contribution read");
  }
  if (target === "question") {
    // 這一題的所有處理：回答（payload.question_id）、掛在提問任務上的任何貢獻（no_change「查不到」也算一次處理）
    const tasks = ok<Array<{ id: string }>>(await supabase.from("contribution_tasks").select("id").eq("task_type", "question").eq("target->>question_id", id).limit(20), "question tasks");
    const taskIds = tasks.map((t) => String(t.id));
    const [answers, byTask] = await Promise.all([
      supabase.from("contributions").select(HISTORY_ENTRY_COLUMNS).eq("payload->>question_id", id).limit(200),
      taskIds.length > 0 ? supabase.from("contributions").select(HISTORY_ENTRY_COLUMNS).in("task_id", taskIds).limit(200) : Promise.resolve({ data: [], error: null }),
    ]);
    return [...ok<HistoryContribution[]>(answers, "question answers"), ...ok<HistoryContribution[]>(byTask, "question task contributions")];
  }
  const appliedCol = target === "policy" ? "applied_policy_id" : "applied_politician_id";
  const payloadCol = target === "policy" ? "payload->>policy_id" : "payload->>politician_id";
  const targetTable = target === "policy" ? "policies" : "politicians";
  const [applied, referenced, corrections] = await Promise.all([
    supabase.from("contributions").select(HISTORY_ENTRY_COLUMNS).eq(appliedCol, id).limit(500),
    supabase.from("contributions").select(HISTORY_ENTRY_COLUMNS).eq(payloadCol, id).limit(500),
    // correction 的目標寫在 payload.target_table／target_id
    supabase.from("contributions").select(HISTORY_ENTRY_COLUMNS).eq("contribution_type", "correction").eq("payload->>target_table", targetTable).eq("payload->>target_id", id).limit(500),
  ]);
  return [
    ...ok<HistoryContribution[]>(applied, "contributions applied"),
    ...ok<HistoryContribution[]>(referenced, "contributions referenced"),
    ...ok<HistoryContribution[]>(corrections, "contributions corrections"),
  ];
}

/** edit_history 直接掛在這個對象（或它的子列：參選紀錄／追蹤紀錄）上的貢獻 id */
async function contributionIdsFromEdits(supabase: SupabaseLike, target: HistoryTarget, id: string): Promise<{ ids: string[]; edits: HistoryEdit[] }> {
  if (target === "contribution" || target === "question") return { ids: [], edits: [] };
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
  const extra = missing.length > 0 ? ok<HistoryContribution[]>(await supabase.from("contributions").select(HISTORY_ENTRY_COLUMNS).in("id", missing), "contributions via edits") : [];
  const contributions = [...new Map([...direct, ...extra].map((c) => [c.id, c])).values()];
  const ids = contributions.map((c) => c.id);
  if (ids.length === 0) {
    const originRow = await originRowFor(supabase, target, id);
    return { contributions: [], votes: [], edits: [], adjudications: [], tasks: [], origin_row: originRow.row, election_notes: originRow.notes };
  }
  const [votes, edits, adjudications, tasks, originRow, summaryLookup, sourceBriefs] = await Promise.all([
    // 1000 是伺服器上限（PostgREST max-rows），寫 2000 拿不到更多、只會讓人以為有保護。
    // 實測一筆查核履歷的票與 edit 最多 61 筆（2026-09-18 算過最壞情況）。
    supabase.from("contribution_votes").select(VOTE_COLUMNS).in("contribution_id", ids).limit(1000),
    supabase.from("edit_history").select(EDIT_COLUMNS).in("contribution_id", ids).limit(1000),
    supabase.from("contributions").select(CONTRIBUTION_COLUMNS).eq("contribution_type", "adjudication").in("payload->>contribution_id", ids).limit(500),
    supabase.from("contribution_tasks").select("id, task_type, status, target, created_at, closed_at").eq("task_type", "adjudicate").in("target->>contribution_id", ids).limit(500),
    originRowFor(supabase, target, id),
    // 摘要裡出現的所有 id（人物、政見、參選紀錄、脈絡、政黨、地區、裁決的原貢獻）一次批次換成名稱
    loadSummaryLookup(supabase, contributions),
    // 交件的網址在出處表的等級與存檔網址（#347 第二階段 A）；出處表拿不到就是空表，照網域自動判斷
    fetchSourceBriefs(supabase, contributions.flatMap((c) => c.source_urls ?? [])),
  ]);
  const editRows = ok<HistoryEdit[]>(edits, "edit_history");
  // 履歷的 party_id 變更要顯示政黨名稱：交件 payload 裡只有政黨文字，id 要另外查（缺的才查，一次）
  const editPartyIds = [...new Set(editRows.filter((e) => e.field === "party_id").flatMap((e) => [e.old_value, e.new_value])
    .filter((v): v is number => typeof v === "number" && Number.isInteger(v)).map(String))].filter((v) => !summaryLookup.parties?.[v]);
  if (editPartyIds.length > 0) {
    const named = ok<Array<{ id: number; name: string }>>(await supabase.from("parties").select("id, name").in("id", editPartyIds).limit(500), "party names (edits)");
    summaryLookup.parties = { ...(summaryLookup.parties ?? {}), ...Object.fromEntries(named.map((x) => [String(x.id), x.name])) };
  }
  return {
    contributions,
    votes: ok<HistoryVote[]>(votes, "votes"),
    edits: editRows,
    adjudications: ok<HistoryContribution[]>(adjudications, "adjudications"),
    tasks: ok<HistoryTask[]>(tasks, "adjudicate tasks"),
    politician_names: summaryLookup.politicians,
    policy_titles: summaryLookup.policies,
    election_labels: summaryLookup.elections,
    summary_lookup: summaryLookup,
    origin_row: originRow.row,
    election_notes: originRow.notes,
    source_briefs: sourceBriefs,
  };
}

async function originRowFor(supabase: SupabaseLike, target: HistoryTarget, id: string): Promise<{ row: Obj | null; notes: string[] }> {
  if (target === "policy") {
    const res = await supabase.from("policies").select("id, title, ai_extracted, proposed_date").eq("id", id).maybeSingle();
    const row = (res.data as Obj | null) ?? null;
    if (row) {
      // 出處表的出處清單（主要在前）；RPC 出錯就不帶，來源說明就當沒有出處（不會誤報成別的網址）
      try {
        const listed = await supabase.rpc("source_brief_list", { p_table: "policies", p_id: id });
        if (!listed.error && Array.isArray(listed.data)) row.sources = listed.data;
      } catch { /* 不帶出處清單 */ }
    }
    return { row, notes: [] };
  }
  if (target === "question") {
    const res = await supabase.from("citizen_questions").select("id, question, status, answer_count, created_at").eq("id", id).maybeSingle();
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

// ------------------------------------------------------------
// 網站請求（維護者 2026-10-28：資料來源與查核履歷也列網站請求）
// 訪客在人物頁／政見頁按「請 AI 幫忙查」建的任務（contribution_tasks.source='web_request'）。
// 只回日期、查什麼、狀態；不回來源 IP 或雜湊、不回是誰按的。
// ------------------------------------------------------------
/** 這筆網站請求之後有人交的貢獻（掛在這個任務上的）：展開時列出，讓人看得到「誰回報了什麼、現在到哪一步」 */
export interface HistoryWebRequestReport { id: string; type_label: string; status: string; status_label: string; created_at: string; agent_name: string | null }
export interface HistoryWebRequest {
  id: string;
  task_type: string;
  kind_label: string;
  /** open＝排隊處理中；parked＝停放（等官方公報）；closed＝已處理完 */
  status: "open" | "parked" | "closed";
  status_label: string;
  created_at: string;
  closed_at: string | null;
  /** 掛在這個任務上的貢獻（新到舊）；沒有就是還沒有代理交件 */
  reports: HistoryWebRequestReport[];
}
const WEB_REQUEST_KIND_LABEL: Record<string, string> = {
  policy_missing: "查承諾與政見", profile_gap: "查簡介與學經歷", progress_stale: "查政見進度", policy_validity: "查政見是否有效", audit: "核對文件與政見",
};
export const WEB_REQUEST_LIMIT = 30;

/** 純函式：任務列 → 履歷上的網站請求（新到舊）。parkedIds＝目前停放中的任務 id */
export function buildWebRequests(
  rows: ReadonlyArray<{ id: string; task_type: string; status: string; created_at: string; closed_at: string | null }>,
  parkedIds: ReadonlySet<string> = new Set(),
  contributions: ReadonlyArray<{ id: string; task_id: string | null; payload?: Obj | null; contribution_type: string; status: string; created_at: string; agent_name: string | null }> = [],
): HistoryWebRequest[] {
  const reportsBy = new Map<string, HistoryWebRequestReport[]>();
  for (const c of contributions) {
    const tid = c.task_id ?? (typeof c.payload?.task_id === "string" ? c.payload.task_id : null);
    if (!tid) continue;
    reportsBy.set(tid, [...(reportsBy.get(tid) ?? []), {
      id: c.id, type_label: TYPE_LABEL[c.contribution_type] ?? c.contribution_type, status: c.status,
      status_label: STATUS_LABEL[c.status] ?? c.status, created_at: c.created_at, agent_name: c.agent_name ?? null,
    }]);
  }
  return rows
    .map((r): HistoryWebRequest => {
      const closed = r.status !== "open";
      const parked = !closed && parkedIds.has(String(r.id));
      return {
        id: String(r.id),
        task_type: r.task_type,
        kind_label: WEB_REQUEST_KIND_LABEL[r.task_type] ?? "查資料",
        status: closed ? "closed" : parked ? "parked" : "open",
        status_label: closed ? "已處理完" : parked ? "等官方選舉公報上架後處理" : "排隊處理中",
        created_at: r.created_at,
        closed_at: r.closed_at ?? null,
        reports: (reportsBy.get(String(r.id)) ?? []).sort((a, b) => b.created_at.localeCompare(a.created_at)),
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** 碰 DB：某人物（或政見）被網站訪客請求查過的紀錄；其他對象（貢獻、提問）沒有 */
export async function collectWebRequests(supabase: SupabaseLike, target: HistoryTarget, id: string): Promise<HistoryWebRequest[]> {
  if (target !== "politician" && target !== "policy") return [];
  const key = target === "policy" ? "target->>policy_id" : "target->>politician_id";
  const rows = ok<Array<{ id: string; task_type: string; status: string; created_at: string; closed_at: string | null }>>(
    await supabase.from("contribution_tasks").select("id, task_type, status, created_at, closed_at")
      .eq("source", "web_request").eq(key, id).order("created_at", { ascending: false }).limit(WEB_REQUEST_LIMIT),
    "web requests",
  );
  // 停放中的（等官方公報）：失敗就當沒停放，不讓履歷整份讀不出來
  const parked = new Set<string>();
  for (const r of rows) {
    if (r.status !== "open") continue;
    try {
      const res = await supabase.rpc("web_request_parked", { p_task_id: r.id });
      if (!res.error && res.data === true) parked.add(String(r.id));
    } catch { /* 當沒停放 */ }
  }
  // 掛在這些任務上的貢獻（task_id 欄，或 no_change 只寫在 payload.task_id）
  const ids = rows.map((r) => String(r.id));
  const cols = "id, task_id, payload, contribution_type, status, created_at, agent_name";
  const [byTask, byPayload] = ids.length === 0 ? [[], []] : await Promise.all([
    supabase.from("contributions").select(cols).in("task_id", ids).limit(200),
    supabase.from("contributions").select(cols).eq("contribution_type", "no_change").is("task_id", null).in("payload->>task_id", ids).limit(200),
  ]).then(([a, b]) => [ok<Array<Obj>>(a, "web request reports"), ok<Array<Obj>>(b, "web request reports (no_change)")]);
  return buildWebRequests(rows, parked, [...byTask, ...byPayload] as never);
}

/** 純函式：cursor 分頁（cursor 是上一頁最後一筆的 at） */
export function pageEntries(entries: HistoryEntry[], limit: number, cursor: string | null): { items: HistoryEntry[]; has_more: boolean; next_cursor: string | null } {
  const filtered = cursor ? entries.filter((e) => e.at < cursor) : entries;
  const items = filtered.slice(0, limit);
  const has_more = filtered.length > limit;
  return { items, has_more, next_cursor: has_more ? items[items.length - 1].at : null };
}
