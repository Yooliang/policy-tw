/**
 * contributions-feed 單一 RPC（contributions_feed_bundle）的呼叫與回傳轉換
 * （Edge Function 內部 REST 瘦身 第 1 期 PR-2，migration 20261127093000）。
 *
 * 一次請求原本約 6～10 次 REST（清單、第一頁的筆數與統計、名稱對照兩輪、出處摘要），改成 1 次；
 * RPC 回錯（函式不存在、例外、形狀不對）就回 null，由呼叫端退回原本的多次查詢，並 console.warn 一行。
 * 只有純函式與一次 rpc 呼叫；名稱對照原料的形狀與 history_bundle 的 summary 相同，直接用 summaryLookupFromBundle 還原。
 */
import type { SummaryLookup } from "./contribution-summary.ts";
import { summaryLookupFromBundle, type HistoryBundle } from "./history-bundle.ts";
import type { SourceBrief } from "./source-read.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
// deno-lint-ignore no-explicit-any
type FeedRow = Record<string, any>;

export interface FeedBundleParams {
  status: string;
  agent_name: string | null;
  actor_id: string | null;
  type: string | null;
  limit: number;
  cursor: string | null;
  want_count: boolean;
  want_summary: boolean;
}

export interface FeedBundle {
  rows: FeedRow[];
  total: number | null;
  summary: unknown;
  lookup: HistoryBundle["summary"];
  source_briefs: SourceBrief[];
}

/** 回給 index.ts 的東西：形狀對得上原本 `await q`／`await rpc(...)` 的結果，後面的程式不用動 */
export interface FeedBundleResult {
  feedRes: { data: FeedRow[]; error: null; count: number | null };
  summaryRes: { data: unknown; error: null };
  lookup: SummaryLookup;
  briefs: Map<string, SourceBrief>;
}

const isArr = (v: unknown): boolean => Array.isArray(v);

export function isFeedBundle(x: unknown): x is FeedBundle {
  if (!x || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  const l = b.lookup as Record<string, unknown> | undefined;
  return isArr(b.rows) && isArr(b.source_briefs) && !!l && typeof l === "object" && isArr(l.politicians) && isArr(l.originals)
    && (b.total === null || typeof b.total === "number");
}

/** 純函式：RPC 回傳 → index.ts 原本拿到的四樣東西（清單與筆數、統計、名稱對照、出處摘要） */
export function feedResultFromBundle(b: FeedBundle, wantSummary: boolean): FeedBundleResult {
  const briefs = new Map<string, SourceBrief>();
  for (const r of b.source_briefs) if (r && typeof r.url === "string") briefs.set(r.url, r);
  return {
    feedRes: { data: b.rows, error: null, count: b.total },
    summaryRes: { data: wantSummary ? (b.summary ?? null) : null, error: null },
    lookup: summaryLookupFromBundle(b.lookup),
    briefs,
  };
}

/** 一次 RPC 撈齊；失敗（含 migration 還沒上）回 null 並 console.warn，呼叫端退回舊路徑 */
export async function readFeedBundle(supabase: SupabaseLike, params: FeedBundleParams): Promise<FeedBundleResult | null> {
  try {
    const res = await supabase.rpc("contributions_feed_bundle", { p_params: params });
    if (res.error) throw new Error(res.error.message ?? String(res.error));
    if (!isFeedBundle(res.data)) throw new Error("unexpected contributions_feed_bundle shape");
    return feedResultFromBundle(res.data, params.want_summary);
  } catch (e) {
    console.warn(`contributions_feed_bundle 失敗，退回多次查詢：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
