/**
 * 站務 GA 數字另存一份到 Supabase 私有表（2026-10-20，policy-ops 工作單 #148，migration 20261020030000_ga_console_store.sql）。
 *
 * console-fetch 抓 GA4 之後原本只寫 Firestore（規則只准站長以 Google 登入讀），代理讀不到。這裡做兩件事：
 *   1. teeStore：包住 Firestore 的 Store，寫 `summary/{site}`、`daily/{site}_{date}` 時把同一份轉成列、先收在記憶體
 *      （不在 GA 主流程裡打網路，不拖慢、不卡住 Firestore 寫入），主流程跑完再由 flush() 整批 upsert 進 `ga_summary`、`ga_daily`
 *      （兩次請求）。Supabase 寫入失敗只記進結果，不丟出去、不影響 Firestore 與 meta/status；Firestore 寫入照舊會丟錯。
 *   2. runGaSearchSync：站內搜尋的 GA `search` 事件（lib/search-analytics.ts 送的 search_term、results_count）。
 *      先查 GA metadata 有沒有登記自訂維度 `customEvent:search_term`；沒有就回 unconfigured 並略過（不打報表、不寫表）。
 *      有就抓近 N 天、依 date × search_term（× results_count，有登記才帶）的 eventCount、totalUsers，upsert 進 `ga_search_terms`。
 *      任何一步失敗都回 error，不丟出去；主流程已經跑太久（超過 deadline）就回 skipped，不搶 Edge Function 的時間上限。
 *
 * 日期一律是 console-fetch 的 dayOffset（台灣時間）；訊息不含金鑰或權杖。
 */
import { callJson, dayOffset, type Deps, realDeps, type Store, type Totals } from "./console-fetch.ts";

// ---------- 列的形狀（與 migration 欄位一一對應） ----------
export interface GaDailyRow {
  site: string;
  date: string;
  property_id: string;
  users: number;
  sessions: number;
  views: number;
  engagement_sec: number;
  avg_engagement_sec: number;
  sources: unknown[];
  landing: unknown[];
  pages: unknown[];
  pairs: unknown[];
  hosts: unknown[];
  fetched_at: string;
}
export interface GaSummaryRow {
  site: string;
  range: SummaryRange;
  start_date: string;
  end_date: string;
  property_id: string;
  users: number;
  sessions: number;
  views: number;
  engagement_sec: number;
  avg_engagement_sec: number;
  updated_at: string;
}
export interface GaSearchRow {
  site: string;
  date: string;
  term: string;
  results_count: string;
  event_count: number;
  users: number;
  fetched_at: string;
}

/** 與資料庫的接縫（index.ts 用 service role 的 supabase-js 實作；測試注入假的） */
export interface GaMirror {
  upsertDaily(rows: GaDailyRow[]): Promise<void>;
  upsertSummary(rows: GaSummaryRow[]): Promise<void>;
  upsertSearch(rows: GaSearchRow[]): Promise<void>;
}

export const SUMMARY_RANGES = ["today", "yesterday", "last7", "last30"] as const;
export type SummaryRange = typeof SUMMARY_RANGES[number];

/** fetchGaSummary 的區間（台灣時間），與 console-fetch.ts 同一套 */
export function summaryRangeDates(nowMs: number): Record<SummaryRange, { start: string; end: string }> {
  const today = dayOffset(nowMs, 0);
  return {
    today: { start: today, end: today },
    yesterday: { start: dayOffset(nowMs, 1), end: dayOffset(nowMs, 1) },
    last7: { start: dayOffset(nowMs, 6), end: today },
    last30: { start: dayOffset(nowMs, 29), end: today },
  };
}

const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const totalsOf = (t: Partial<Totals> | undefined) => {
  const users = Math.round(n(t?.users));
  const avg = n(t?.avgEngagementSec);
  return {
    users,
    sessions: Math.round(n(t?.sessions)),
    views: Math.round(n(t?.views)),
    // Firestore 只存平均（小數一位），總秒數由平均×使用者還原，是近似值（誤差 ≤ 0.05 秒×使用者）
    engagement_sec: Math.round(avg * users),
    avg_engagement_sec: avg,
  };
};

const DAILY_PATH = /^daily\/([a-z]+)_(\d{4}-\d{2}-\d{2})$/;
const SUMMARY_PATH = /^summary\/([a-z]+)$/;

/** Firestore daily 文件 → ga_daily 列；不是 daily 路徑回 null */
export function toDailyRow(path: string, data: Record<string, unknown>): GaDailyRow | null {
  const m = DAILY_PATH.exec(path);
  if (!m) return null;
  const total = (data.total ?? {}) as Record<string, unknown>;
  return {
    site: m[1],
    date: m[2],
    property_id: String(data.propertyId ?? ""),
    ...totalsOf(total as Partial<Totals>),
    sources: arr(total.sources),
    landing: arr(total.landing),
    pages: arr(total.pages),
    pairs: arr(total.pairs),
    hosts: arr(data.hosts),
    fetched_at: String(data.fetchedAt ?? new Date().toISOString()),
  };
}

/** Firestore summary 文件 → ga_summary 四列；區間日期用文件的 updatedAt 換算（與抓的那一刻同一天） */
export function toSummaryRows(path: string, data: Record<string, unknown>): GaSummaryRow[] | null {
  const m = SUMMARY_PATH.exec(path);
  if (!m) return null;
  const updatedAt = String(data.updatedAt ?? new Date().toISOString());
  const ms = Date.parse(updatedAt);
  const dates = summaryRangeDates(Number.isFinite(ms) ? ms : Date.now());
  return SUMMARY_RANGES.map((range) => ({
    site: m[1],
    range,
    start_date: dates[range].start,
    end_date: dates[range].end,
    property_id: String(data.propertyId ?? ""),
    ...totalsOf(data[range] as Partial<Totals> | undefined),
    updated_at: updatedAt,
  }));
}

export interface MirrorResult {
  state: "ok" | "error";
  message: string | null;
  daily: number;
  summary: number;
  failed: number;
}

/**
 * 包住 Firestore 的 Store：寫 summary／daily 時把列收進記憶體（純計算、不會丟錯），再照舊寫 Firestore（照舊丟錯）。
 * 列在寫 Firestore 之前就收了——Firestore 壞掉那一天，Supabase 那份仍然會進去。
 * flush()：主流程跑完後整批 upsert（daily 一次、summary 一次），失敗只記進結果、不丟出去；
 * mirror 為 null（沒有 service role）時記失敗。
 */
export function teeStore(primary: Store, mirror: GaMirror | null): { store: Store; flush: () => Promise<MirrorResult> } {
  const daily = new Map<string, GaDailyRow>();
  const summary = new Map<string, GaSummaryRow>();
  const collect = (path: string, data: Record<string, unknown>) => {
    try {
      const d = toDailyRow(path, data);
      if (d) return void daily.set(`${d.site}|${d.date}`, d);
      for (const r of toSummaryRows(path, data) ?? []) summary.set(`${r.site}|${r.range}`, r);
    } catch { /* 轉列失敗不影響 Firestore（flush 時列數會少，看得出來） */ }
  };
  return {
    store: {
      async set(path, data) {
        collect(path, data);
        await primary.set(path, data);
      },
      merge: (path, data) => primary.merge(path, data),
    },
    async flush() {
      let failed = 0, ok_daily = 0, ok_summary = 0;
      const errors: string[] = [];
      const fail = (n: number, e: unknown) => {
        failed += n;
        errors.push((e as Error)?.message ?? String(e));
      };
      const d = [...daily.values()];
      const s = [...summary.values()];
      if (!mirror) {
        if (d.length + s.length) fail(d.length + s.length, new Error("沒有 SUPABASE_URL／SUPABASE_SERVICE_ROLE_KEY"));
      } else {
        if (d.length) {
          try {
            await mirror.upsertDaily(d);
            ok_daily = d.length;
          } catch (e) {
            fail(d.length, e);
          }
        }
        if (s.length) {
          try {
            await mirror.upsertSummary(s);
            ok_summary = s.length;
          } catch (e) {
            fail(s.length, e);
          }
        }
      }
      return {
        state: failed ? "error" : "ok",
        message: failed ? `Supabase 另存失敗 ${failed} 列：${errors.join("；")}` : null,
        daily: ok_daily,
        summary: ok_summary,
        failed,
      };
    },
  };
}

// ---------- 站內搜尋詞 ----------
export const SEARCH_TERM_DIM = "customEvent:search_term";
export const RESULTS_COUNT_DIM = "customEvent:results_count";
export const SEARCH_DAYS = 30;
export const SEARCH_PAGE_LIMIT = 10000;
export const SEARCH_MAX_PAGES = 5;

/** GA metadata（properties/{id}/metadata）裡登記了哪些自訂維度 */
export function searchDimsFromMetadata(meta: unknown): { term: boolean; results: boolean } {
  const dims = (meta as { dimensions?: { apiName?: string }[] } | null)?.dimensions ?? [];
  const names = new Set(dims.map((d) => d?.apiName ?? ""));
  return { term: names.has(SEARCH_TERM_DIM), results: names.has(RESULTS_COUNT_DIM) };
}

export function buildSearchRequest(nowMs: number, days: number, withResults: boolean, offset = 0) {
  return {
    dateRanges: [{ startDate: dayOffset(nowMs, days - 1), endDate: dayOffset(nowMs, 0) }],
    dimensions: [{ name: "date" }, { name: SEARCH_TERM_DIM }, ...(withResults ? [{ name: RESULTS_COUNT_DIM }] : [])],
    metrics: [{ name: "eventCount" }, { name: "totalUsers" }],
    dimensionFilter: { filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: "search" } } },
    orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
    limit: SEARCH_PAGE_LIMIT,
    offset,
  };
}

interface GaRowLike { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }

/** GA 的 date 維度是 yyyymmdd；(not set)／空詞略過；同一鍵出現多列加總 */
export function parseSearchRows(rows: GaRowLike[] | undefined, site: string, withResults: boolean, fetchedAt: string): GaSearchRow[] {
  const merged = new Map<string, GaSearchRow>();
  for (const r of rows ?? []) {
    const raw = r.dimensionValues?.[0]?.value ?? "";
    const dm = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
    const term = (r.dimensionValues?.[1]?.value ?? "").trim();
    // (not set)：事件沒帶這個參數；(other)：GA 高基數時把長尾併成一列，都不是真的搜尋詞
    if (!dm || !term || term === "(not set)" || term === "(other)") continue;
    const rc = withResults ? (r.dimensionValues?.[2]?.value ?? "") : "";
    const results_count = rc === "(not set)" ? "" : rc;
    const date = `${dm[1]}-${dm[2]}-${dm[3]}`;
    const key = JSON.stringify([date, term, results_count]);
    const ev = Math.round(n(r.metricValues?.[0]?.value));
    const us = Math.round(n(r.metricValues?.[1]?.value));
    const cur = merged.get(key);
    if (cur) {
      cur.event_count += ev;
      cur.users += us;
    } else merged.set(key, { site, date, term, results_count, event_count: ev, users: us, fetched_at: fetchedAt });
  }
  return [...merged.values()];
}

export interface SearchResult {
  state: "ok" | "unconfigured" | "skipped" | "error";
  message: string | null;
  rows?: number;
  results_count_dim?: boolean;
  /** 翻到 SEARCH_MAX_PAGES 還有下一頁（只存了前面那些） */
  truncated?: boolean;
}

/** 外層保險：runGaSearchSyncInner 任何意外（包括同步的程式錯誤）都轉成 error，不往外丟 */
export async function runGaSearchSync(input: SearchInput): Promise<SearchResult> {
  try {
    return await runGaSearchSyncInner(input);
  } catch (e) {
    return { state: "error", message: `站內搜尋詞意外失敗：${(e as Error)?.message ?? String(e)}` };
  }
}

export interface SearchInput {
  site: string;
  propertyId: string;
  getToken: () => Promise<string>;
  mirror: GaMirror | null;
  deps?: Deps;
  days?: number;
  /** 超過這個時間點（毫秒時間戳）就不開始，回 skipped；index.ts 給「開始＋100 秒」 */
  deadlineMs?: number;
}

async function runGaSearchSyncInner(input: SearchInput): Promise<SearchResult> {
  const deps = input.deps ?? realDeps;
  const days = input.days ?? SEARCH_DAYS;
  if (input.deadlineMs !== undefined && deps.now() > input.deadlineMs) {
    return { state: "skipped", message: "主流程已用掉太多時間，這輪不抓站內搜尋詞（下一輪再抓）" };
  }
  if (!input.mirror) return { state: "error", message: "沒有 SUPABASE_URL／SUPABASE_SERVICE_ROLE_KEY" };
  const base = `https://analyticsdata.googleapis.com/v1beta/properties/${input.propertyId}`;
  let token: string;
  let dims: { term: boolean; results: boolean };
  try {
    token = await input.getToken();
    const meta = await callJson(`${base}/metadata`, { method: "GET", headers: { Authorization: `Bearer ${token}` } }, "GA metadata", deps);
    dims = searchDimsFromMetadata(meta);
  } catch (e) {
    return { state: "error", message: `GA metadata 失敗：${(e as Error).message}` };
  }
  if (!dims.term) {
    const message = `GA 尚未登記自訂維度 ${SEARCH_TERM_DIM}（事件範圍），略過站內搜尋詞`;
    deps.log("站內搜尋詞：", message);
    return { state: "unconfigured", message, results_count_dim: dims.results };
  }
  const nowMs = deps.now();
  const fetchedAt = new Date(nowMs).toISOString();
  const all: GaRowLike[] = [];
  let truncated = false;
  let stoppedByDeadline = false;
  let rowCount = 0;
  try {
    for (let page = 0; page < SEARCH_MAX_PAGES; page++) {
      if (input.deadlineMs !== undefined && deps.now() > input.deadlineMs) {
        stoppedByDeadline = true;
        break;
      }
      const body = await callJson(
        `${base}:runReport`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(buildSearchRequest(nowMs, days, dims.results, page * SEARCH_PAGE_LIMIT)),
        },
        "GA 站內搜尋詞",
        deps,
      ) as { rows?: GaRowLike[]; rowCount?: number } | null;
      const rows = body?.rows ?? [];
      all.push(...rows);
      rowCount = Math.max(rowCount, Number(body?.rowCount ?? 0) || 0);
      if (rows.length < SEARCH_PAGE_LIMIT) break;
    }
    // GA 回的 rowCount 是整份報表的列數；比實際拿到的多才算截斷（剛好 5 萬列不算）
    truncated = !stoppedByDeadline && rowCount > all.length;
  } catch (e) {
    return { state: "error", message: `GA 站內搜尋詞抓取失敗：${(e as Error).message}`, results_count_dim: dims.results };
  }
  if (stoppedByDeadline && all.length === 0) {
    return { state: "skipped", message: "查完 metadata 已超過時間，這輪不抓站內搜尋詞（下一輪再抓）", results_count_dim: dims.results };
  }
  const rows = parseSearchRows(all, input.site, dims.results, fetchedAt);
  try {
    if (rows.length) await input.mirror.upsertSearch(rows);
  } catch (e) {
    return { state: "error", message: `ga_search_terms 寫入失敗：${(e as Error).message}`, results_count_dim: dims.results };
  }
  deps.log("站內搜尋詞：", { rows: rows.length, results_count_dim: dims.results, truncated, stoppedByDeadline });
  const notes = [
    ...(dims.results ? [] : [`GA 尚未登記 ${RESULTS_COUNT_DIM}，results_count 留空`]),
    ...(truncated ? [`報表共 ${rowCount} 列，超過上限 ${SEARCH_MAX_PAGES * SEARCH_PAGE_LIMIT}，只存了前面的`] : []),
    ...(stoppedByDeadline ? [`時間到，只存了已抓的 ${all.length} 列`] : []),
  ];
  return { state: "ok", message: notes.length ? notes.join("；") : null, rows: rows.length, results_count_dim: dims.results, truncated: truncated || stoppedByDeadline };
}

/** service role 的 supabase-js → GaMirror（upsert 依主鍵）。db 由 index.ts 建，fetch 帶逾時（makeTimeoutFetch），不會卡住 */
// deno-lint-ignore no-explicit-any
export function makeSupabaseGaMirror(db: any): GaMirror {
  const up = async (table: string, rows: unknown[], onConflict: string) => {
    const { error } = await db.from(table).upsert(rows, { onConflict });
    if (error) throw new Error(`${table}：${error.message}`);
  };
  return {
    upsertDaily: (rows) => up("ga_daily", rows, "site,date"),
    upsertSummary: (rows) => up("ga_summary", rows, "site,range"),
    upsertSearch: async (rows) => {
      for (let i = 0; i < rows.length; i += 500) await up("ga_search_terms", rows.slice(i, i + 500), "site,date,term,results_count");
    },
  };
}

/** 給 supabase-js 的 fetch：每個請求最多等 ms 毫秒（PostgREST 卡住時不拖到 Edge Function 被砍） */
export const MIRROR_TIMEOUT_MS = 20_000;
export function makeTimeoutFetch(ms = MIRROR_TIMEOUT_MS, base: typeof fetch = fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => base(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(ms) })) as typeof fetch;
}
