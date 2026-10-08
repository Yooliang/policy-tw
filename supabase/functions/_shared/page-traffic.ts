/**
 * 人物頁、政見頁的流量（2026-10-08，migration 20261008190000_page_traffic_boost.sql）。
 *
 * console-fetch 每小時抓完 GA4 之後多做這一件：台灣站（property 521879439）近 N 天、維度 pagePath、指標 totalUsers＋screenPageViews，
 * 只取路徑完整符合 /politician/<uuid> 或 /policy/<uuid> 的；正見.tw 與 web.app 兩個網域路徑相同，GA 沒有 hostName 維度就已經合併
 * （totalUsers 是跨網域去重後的人數），萬一同一路徑出現多列（尾斜線、大小寫）再加總。
 * 結果經 service_role RPC replace_page_traffic 整批覆寫 Supabase 的 page_traffic（upsert 並清掉這次沒出現的）。
 *
 * 時間窗 N 不寫在這裡：它是 traffic_boost_settings.window_days（SQL 單一真相，維護者可調），這裡每次先讀、抓同樣的天數，
 * 寫入時再把 N 一起交給 RPC，資料庫端核對相同才收。門檻、層、暫停天數也都只在資料庫端用，這裡完全不知道。
 *
 * 純函式（解析、請求形狀）與 I/O 分開；網路與時間從 deps 注入。GA 的 429 與重試沿用 console-fetch 的 callJson（指數退避、單一請求 60 秒上限），
 * 一次只送一個請求（不與主流程的批次並行），所以不會多佔 GA 的同時請求數。
 */
import { CONSOLE_CONFIG, callJson, dayOffset, type Deps, realDeps } from "./console-fetch.ts";

/** 台灣站的 GA 資源編號：與 console-fetch 的站台設定同一份，不另寫一個 */
export const TRAFFIC_PROPERTY_ID = CONSOLE_CONFIG.sites.tw.propertyId as string;

export type PageKind = "politician" | "policy";
export interface TrafficRow {
  kind: PageKind;
  target_id: string;
  users: number;
  views: number;
}

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
/** 人物頁、政見頁的路徑（pagePath 不含查詢字串）；允許一個尾斜線 */
export const PAGE_PATH_RE = new RegExp(`^/(politician|policy)/(${UUID})/?$`);
/** 丟給 GA 的 FULL_REGEXP（RE2，整個值要吻合）：先在 GA 端濾掉其他頁，回應只剩人物頁、政見頁 */
export const GA_PATH_FILTER = `/(politician|policy)/${UUID}/?`;

/** 單頁最多取幾列、最多翻幾頁（人物頁＋政見頁約 2 萬個，一頁 10000 列翻到 5 頁已經遠超過實際） */
export const GA_PAGE_LIMIT = 10000;
export const GA_MAX_PAGES = 5;

interface GaRow {
  dimensionValues?: { value?: string }[];
  metricValues?: { value?: string }[];
}
export interface GaReportLike {
  rows?: GaRow[];
  rowCount?: number;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/** 把 GA 的 pagePath 報表列解析成流量列：不符合人物頁／政見頁的略過；同一頁出現多列就加總；結果依 kind、id 排序（輸出穩定） */
export function parseTrafficRows(reportRows: GaRow[] | undefined): TrafficRow[] {
  const merged = new Map<string, TrafficRow>();
  for (const r of reportRows ?? []) {
    const m = PAGE_PATH_RE.exec(r.dimensionValues?.[0]?.value ?? "");
    if (!m) continue;
    const kind = m[1] as PageKind;
    const target_id = m[2].toLowerCase();
    const key = `${kind}:${target_id}`;
    const users = num(r.metricValues?.[0]?.value);
    const views = num(r.metricValues?.[1]?.value);
    const cur = merged.get(key);
    if (cur) {
      cur.users += users;
      cur.views += views;
    } else {
      merged.set(key, { kind, target_id, users, views });
    }
  }
  return [...merged.values()].sort((a, b) => (a.kind === b.kind ? a.target_id.localeCompare(b.target_id) : a.kind.localeCompare(b.kind)));
}

/** runReport 請求：近 windowDays 天（含今天，台灣時間日界），pagePath × (totalUsers, screenPageViews)，只取人物頁、政見頁 */
export function buildTrafficRequest(nowMs: number, windowDays: number, offset = 0) {
  return {
    dateRanges: [{ startDate: dayOffset(nowMs, windowDays - 1), endDate: dayOffset(nowMs, 0) }],
    dimensions: [{ name: "pagePath" }],
    metrics: [{ name: "totalUsers" }, { name: "screenPageViews" }],
    dimensionFilter: { filter: { fieldName: "pagePath", stringFilter: { matchType: "FULL_REGEXP", value: GA_PATH_FILTER } } },
    orderBys: [{ metric: { metricName: "totalUsers" }, desc: true }],
    limit: GA_PAGE_LIMIT,
    offset,
  };
}

/** 抓一份流量：翻頁到沒有更多列為止（或翻到上限），回傳解析後的列 */
export async function fetchPageTraffic(
  propertyId: string,
  token: string,
  nowMs: number,
  windowDays: number,
  deps: Deps = realDeps,
): Promise<TrafficRow[]> {
  const all: GaRow[] = [];
  for (let page = 0; page < GA_MAX_PAGES; page++) {
    const body = await callJson(
      `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildTrafficRequest(nowMs, windowDays, page * GA_PAGE_LIMIT)),
      },
      "GA 頁面流量",
      deps,
    ) as GaReportLike | null;
    const rows = body?.rows ?? [];
    all.push(...rows);
    if (rows.length < GA_PAGE_LIMIT) break;
  }
  return parseTrafficRows(all);
}

// ---------- 與資料庫的接縫（測試注入假的） ----------
export interface TrafficStore {
  /** traffic_boost_settings 的 enabled、window_days（單列） */
  readSettings(): Promise<{ enabled: boolean; window_days: number }>;
  /** RPC replace_page_traffic：回傳寫入列數 */
  replace(rows: TrafficRow[], windowDays: number): Promise<number>;
}

export type TrafficState = "ok" | "skipped" | "error";
export interface TrafficResult {
  state: TrafficState;
  message: string | null;
  rows?: number;
}

/**
 * 一輪：讀設定（停用就不抓）→ 抓 GA → 整批覆寫。任何一步失敗都回 error 而不是丟出去（不影響主流程的 Firestore 寫入），
 * 而且 GA 沒抓成功就不呼叫 RPC（保留上一輪的數字，過了 stale_after_hours 自己失效；不會因為抓失敗把整張表清空）。
 * 訊息不含金鑰或權杖。
 */
export async function runPageTrafficSync(input: {
  propertyId?: string;
  getToken: () => Promise<string>;
  store: TrafficStore;
  deps?: Deps;
}): Promise<TrafficResult> {
  const deps = input.deps ?? realDeps;
  const propertyId = input.propertyId ?? TRAFFIC_PROPERTY_ID;
  let settings;
  try {
    settings = await input.store.readSettings();
  } catch (e) {
    return { state: "error", message: `讀 traffic_boost_settings 失敗：${(e as Error).message}` };
  }
  if (!settings.enabled) return { state: "skipped", message: "traffic_boost_settings.enabled=false" };
  let rows: TrafficRow[];
  try {
    rows = await fetchPageTraffic(propertyId, await input.getToken(), deps.now(), settings.window_days, deps);
  } catch (e) {
    return { state: "error", message: `GA 頁面流量抓取失敗：${(e as Error).message}` };
  }
  try {
    const n = await input.store.replace(rows, settings.window_days);
    deps.log("頁面流量：", { window_days: settings.window_days, rows: n });
    return { state: "ok", message: null, rows: n };
  } catch (e) {
    return { state: "error", message: `replace_page_traffic 失敗：${(e as Error).message}` };
  }
}
