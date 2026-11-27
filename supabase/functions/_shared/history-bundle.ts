/**
 * history 單一 RPC（history_bundle）的回傳形狀與轉換。
 * 資料庫端一次撈齊 history.ts 原本分約 20 次查的資料（migration 20261127073000），這裡把它還原成
 * 原本多次查詢路徑組出來的同一份 HistoryData／網站請求輸入，後面的 buildHistory、describeOrigin、buildWebRequests 不用動。
 * 只有純函式、不碰資料庫；history.ts 的型別只用 type import（沒有循環載入）。
 */

import { summarizeContribution, type SummaryLookup } from "./contribution-summary.ts";
import { regionLabel } from "./summary-lookup.ts";
import type { SourceBrief } from "./source-read.ts";
import type { HistoryContribution, HistoryData, HistoryEdit, HistoryTask, HistoryVote } from "./history.ts";

type Obj = Record<string, unknown>;

/** 單一 RPC 的 history_bundle 能處理的對象；question 沒有做進 RPC，仍走多次查詢 */
export const BUNDLE_TARGETS: readonly string[] = ["politician", "policy", "contribution"];

export interface HistoryBundle {
  limit: number;
  contributions: HistoryContribution[];
  votes: HistoryVote[];
  edits: HistoryEdit[];
  adjudications: HistoryContribution[];
  tasks: HistoryTask[];
  summary: {
    politicians: Array<{ id: string; name: string }>;
    policies: Array<{ id: string; title: string }>;
    lineages: Array<{ id: string; title: string }>;
    parties: Array<{ id: number | string; name: string }>;
    elections: Array<{ id: number | string; election_id: unknown; election_type: string | null; politician_name: string | null }>;
    regions: Array<{ code: string; county: string | null; town: string | null; village: string | null }>;
    originals: Array<{ id: string; contribution_type: string; payload: unknown; applied_politician_id: string | null; applied_policy_id: string | null }>;
  };
  source_briefs: SourceBrief[];
  origin_row: Obj | null;
  election_notes: string[];
  web_requests: {
    rows: Array<{ id: string; task_type: string; status: string; created_at: string; closed_at: string | null }>;
    parked: string[];
    reports: Obj[];
  };
}

const isArr = (v: unknown): boolean => Array.isArray(v);

/** RPC 回來的東西長得像 history_bundle 嗎（舊環境沒有這支函式、或回了別的東西，就退回多次查詢） */
export function isHistoryBundle(x: unknown): x is HistoryBundle {
  if (!x || typeof x !== "object") return false;
  const b = x as Obj;
  const s = b.summary as Obj | undefined;
  const w = b.web_requests as Obj | undefined;
  return isArr(b.contributions) && isArr(b.votes) && isArr(b.edits) && isArr(b.adjudications) && isArr(b.tasks)
    && isArr(b.source_briefs) && isArr(b.election_notes)
    && !!s && typeof s === "object" && isArr(s.politicians) && isArr(s.originals)
    && !!w && typeof w === "object" && isArr(w.rows) && isArr(w.parked) && isArr(w.reports);
}

/** 名稱對照：規則同 summary-lookup.ts 的 loadSummaryLookup（含原貢獻的一句話摘要、履歷 party_id 的政黨名稱） */
export function summaryLookupFromBundle(summary: HistoryBundle["summary"]): SummaryLookup {
  const lookup: SummaryLookup = {
    politicians: Object.fromEntries(summary.politicians.map((x) => [x.id, x.name])),
    policies: Object.fromEntries(summary.policies.map((x) => [x.id, x.title])),
    lineages: Object.fromEntries(summary.lineages.map((x) => [x.id, x.title])),
    parties: Object.fromEntries(summary.parties.map((x) => [String(x.id), x.name])),
    elections: Object.fromEntries(summary.elections.map((x) => [
      String(x.id), `${x.politician_name ?? "某位政治人物"} ${x.election_id ?? ""} ${x.election_type ?? ""}`.trim(),
    ])),
    regions: Object.fromEntries(summary.regions.map((x) => [x.code, regionLabel(x)])),
    contributions: {},
  };
  for (const o of summary.originals) {
    lookup.contributions![o.id] = summarizeContribution({
      contribution_type: o.contribution_type, payload: o.payload,
      applied_politician_id: o.applied_politician_id, applied_policy_id: o.applied_policy_id, lookup: { ...lookup, contributions: {} },
    }).summary;
  }
  return lookup;
}

/** 還原成 collectHistory 的回傳（沒有任何貢獻時只帶來源說明，跟多次查詢路徑一樣） */
export function collectedFromBundle(b: HistoryBundle): HistoryData & { origin_row: Obj | null; election_notes: string[] } {
  if (b.contributions.length === 0) {
    return { contributions: [], votes: [], edits: [], adjudications: [], tasks: [], origin_row: b.origin_row ?? null, election_notes: b.election_notes };
  }
  const lookup = summaryLookupFromBundle(b.summary);
  const briefs = new Map<string, SourceBrief>();
  for (const r of b.source_briefs) if (r && typeof r.url === "string") briefs.set(r.url, r);
  return {
    contributions: b.contributions,
    votes: b.votes,
    edits: b.edits,
    adjudications: b.adjudications,
    tasks: b.tasks,
    politician_names: lookup.politicians,
    policy_titles: lookup.policies,
    election_labels: lookup.elections,
    summary_lookup: lookup,
    origin_row: b.origin_row ?? null,
    election_notes: b.election_notes,
    source_briefs: briefs,
  };
}
