/**
 * console-fetch 的純函式與 I/O 層（2026-10-07，從私人 repo policy-console 的 scripts/fetch.mjs 搬來）。
 *
 * 做的事：抓 GA4（正見、政策の系譜兩個資源），寫進 Firestore（專案 policy-tw）。
 * 分工（2026-10-08 維護者裁定）：GA 只在這裡跑；AdSense 只在 policy-console 的 GitHub Actions 跑。
 * 所以這裡完全不碰 AdSense：不讀 ADSENSE_* 、不呼叫 AdSense、meta/status 只寫 GA 的欄位（updatedAt、sources.ga-*）。
 * 站務主控台（policy-console.web.app）只讀那個 Firestore。原本由 GitHub Actions 每小時跑，
 * GitHub 常跳過排程，所以搬到 Supabase Edge Function ＋ pg_cron。
 *
 * 跟 fetch.mjs 逐項相同：GA 指標、回填天數、GA_BATCH／GA_WORKERS、429 指數退避、
 * Firestore 文件路徑與欄位、meta/status。不一樣的只有幾處（見各處註解）：
 *   1. Firestore 走 REST（edge runtime 不保證能跑 gRPC 的 @google-cloud/firestore）；
 *   2. Google 存取權杖用服務帳號 JWT 自己換（Web Crypto RS256），不用 google-auth-library；
 *   3. 缺環境變數要寫失敗狀態並回錯；單一請求加 60 秒上限。
 *
 * 所有網路與時間都從 deps 注入，測試用假的 fetch 就能跑完整條流程；金鑰只在記憶體，絕不輸出。
 */
import { domainToUnicode } from "node:url";

// ---------- 設定（原 config/sites.json） ----------
export const CONSOLE_CONFIG = {
  sites: {
    tw: { name: "正見", country: "台灣", propertyId: "521879439" },
    jp: { name: "政策の系譜", country: "日本", propertyId: "557622261" },
  } as Record<string, { name: string; country: string; propertyId?: string }>,
  backfillDays: 30,
  maxHostsPerSite: 4,
};
export type ConsoleConfig = typeof CONSOLE_CONFIG;

export const PROJECT_ID = "policy-tw";
/** 與 GitHub 上同名；另一台機器用這個名稱設定 Supabase secret */
export const REQUIRED_ENV = ["GCP_SA_KEY"] as const;

export const GA_METRICS = ["activeUsers", "sessions", "screenPageViews", "userEngagementDuration"];
// GA 每個資源同時最多 10 個請求（一批裡每個查詢都算）：每批 4 個 × 2 個 worker＝8，留一點給別人
export const GA_BATCH = 4;
export const GA_WORKERS = 2;

/** 一個權杖同時管 GA 與 Firestore（原本是兩條路：GoogleAuth 與 Firestore 客戶端各自換） */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/datastore",
];

// ---------- 注入點 ----------
export interface Deps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  /** 現在的毫秒時間戳 */
  now: () => number;
  /** 寫日誌（只放帳號數、列數、期間這類，不放金鑰） */
  log: (...args: unknown[]) => void;
}
export const realDeps: Deps = {
  fetch: (...a) => fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: Math.random,
  now: Date.now,
  log: (...a) => console.log(...a),
};

// ---------- 日期（以台灣時間為準） ----------
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** 台灣時間的「n 天前」日期（yyyy-mm-dd）；nowMs 是現在的 UTC 毫秒 */
export function dayOffset(nowMs: number, n: number): string {
  const d = new Date(nowMs + 8 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() - n);
  return iso(d);
}

/** today 與回填區間 dates（舊→新，共 backfill 天，最後一天是 today） */
export function dateWindow(nowMs: number, backfill: number): { today: string; dates: string[] } {
  return {
    today: dayOffset(nowMs, 0),
    dates: Array.from({ length: backfill }, (_, i) => dayOffset(nowMs, backfill - 1 - i)),
  };
}

// ---------- meta/status ----------
export type SourceState = "ok" | "error" | "unconfigured" | "unauthorized";
export interface SourceStatus {
  label: string;
  state: SourceState;
  message: string | null;
  lastAttempt: string;
  lastSuccess?: string;
}
export function makeStatus(label: string, state: SourceState, message: string | null | undefined, nowIso: string, success = false): SourceStatus {
  return { label, state, message: message ?? null, lastAttempt: nowIso, ...(success ? { lastSuccess: nowIso } : {}) };
}

// ---------- 缺環境變數 ----------
/** 缺哪些（名稱，不含值）。空字串也算缺 */
export function missingEnv(env: Record<string, string | undefined>): string[] {
  return REQUIRED_ENV.filter((k) => !env[k]);
}

// ---------- Firestore 值編碼（REST） ----------
export type FsValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number | string }
  | { stringValue: string }
  | { arrayValue: { values?: FsValue[] } }
  | { mapValue: { fields?: Record<string, FsValue> } };

export function encodeValue(v: unknown): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  switch (typeof v) {
    case "boolean":
      return { booleanValue: v };
    case "number":
      if (Number.isNaN(v)) return { doubleValue: "NaN" };
      if (v === Infinity) return { doubleValue: "Infinity" };
      if (v === -Infinity) return { doubleValue: "-Infinity" };
      return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    case "string":
      return { stringValue: v };
    case "object":
      if (Array.isArray(v)) return { arrayValue: v.length ? { values: v.map(encodeValue) } : {} };
      return { mapValue: { fields: encodeFields(v as Record<string, unknown>) } };
    default:
      throw new Error(`Firestore 不收 ${typeof v} 型別的值`);
  }
}

/** 物件 → Firestore fields；值為 undefined 的欄位略過（原 SDK 會直接丟錯，這裡不讓一個空欄位毀掉整份文件） */
export function encodeFields(obj: Record<string, unknown>): Record<string, FsValue> {
  const out: Record<string, FsValue> = {};
  for (const [k, val] of Object.entries(obj)) {
    if (val === undefined) continue;
    out[k] = encodeValue(val);
  }
  return out;
}

/** updateMask 用的欄位路徑：一般識別字原樣，含連字號（ga-tw）等的用反引號包 */
export function fieldPathSegment(seg: string): string {
  return /^[A-Za-z_][A-Za-z_0-9]*$/.test(seg) ? seg : "`" + seg.replace(/\\/g, "\\\\").replace(/`/g, "\\`") + "`";
}

/**
 * set(data, { merge: true }) 的語意：巢狀物件逐層合併、只動有給的葉子欄位（陣列與純量算葉子）。
 * 例如 meta/status 失敗時沒給 lastSuccess，舊的 lastSuccess 就留著。
 */
export function mergeFieldPaths(obj: Record<string, unknown>, prefix: string[] = []): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const path = [...prefix, k];
    if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0) out.push(...mergeFieldPaths(v as Record<string, unknown>, path));
    else out.push(path.map(fieldPathSegment).join("."));
  }
  return out;
}

export function documentUrl(path: string, projectId = PROJECT_ID): string {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path.split("/").map(encodeURIComponent).join("/")}`;
}

// ---------- 服務帳號 JWT → 存取權杖 ----------
export interface ServiceAccountKey { client_email: string; private_key: string; token_uri?: string }

/** 解析 GCP_SA_KEY（服務帳號 JSON 全文）。錯誤訊息不含任何金鑰內容 */
export function parseServiceAccountKey(raw: string | undefined): ServiceAccountKey {
  if (!raw) throw new Error("沒有 GCP_SA_KEY");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GCP_SA_KEY 不是合法的 JSON");
  }
  if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string" || !parsed.client_email || !parsed.private_key) {
    throw new Error("GCP_SA_KEY 缺 client_email 或 private_key");
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key, ...(typeof parsed.token_uri === "string" ? { token_uri: parsed.token_uri } : {}) };
}

export function base64Url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN [A-Z ]+-----/g, "").replace(/-----END [A-Z ]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/** 簽好的 JWT assertion（RS256） */
export async function buildJwtAssertion(sa: ServiceAccountKey, scopes: string[], nowSec: number): Promise<string> {
  const aud = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({ iss: sa.client_email, scope: scopes.join(" "), aud, iat: nowSec, exp: nowSec + 3600 }));
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${base64Url(new Uint8Array(sig))}`;
}

/** 換存取權杖。一次執行換一次、記在記憶體（權杖有效 1 小時，整輪不到幾分鐘） */
export function makeTokenGetter(sa: ServiceAccountKey, deps: Deps = realDeps): () => Promise<string> {
  let cached: Promise<string> | undefined;
  return () => {
    if (!cached) {
      const p = (async () => {
        const assertion = await buildJwtAssertion(sa, GOOGLE_SCOPES, Math.floor(deps.now() / 1000));
        const body = await callJson(
          sa.token_uri ?? "https://oauth2.googleapis.com/token",
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
          },
          "服務帳號權杖",
          deps,
        ) as { access_token?: string } | null;
        if (!body?.access_token) throw new Error("無法取得服務帳號權杖");
        return body.access_token;
      })();
      // 失敗不要記住：同一輪後面的資料源可以再試
      p.catch(() => {
        if (cached === p) cached = undefined;
      });
      cached = p;
    }
    return cached;
  };
}

// ---------- 共用 HTTP ----------
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 重試前等多久：GA 的 429 多半是同時請求數用完（每個資源最多 10 個），要等別的請求做完；等久一點、錯開 */
export function backoffMs(status: number, attempt: number, rand: number): number {
  return (status === 429 ? 5000 * 2 ** attempt : 1500 * (attempt + 1)) + rand * 1000;
}

/** 單一請求最久等多久：沒有上限的話一個卡住的請求會拖到函式被砍、meta/status 也寫不出去（fetch.mjs 沒有這一條） */
export const REQUEST_TIMEOUT_MS = 60_000;

// deno-lint-ignore no-explicit-any
export async function callJson(url: string, init: RequestInit, label: string, deps: Deps = realDeps): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await deps.fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...init });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (res.ok) return body;
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await deps.sleep(backoffMs(res.status, attempt, deps.random()));
      continue;
    }
    const msg = body?.error?.message ?? body?.error_description ?? body?.error ?? text.slice(0, 300);
    throw new ApiError(res.status, `${label} ${res.status}：${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
  }
}

// ---------- Firestore REST 寫入 ----------
export interface Store {
  /** 整份取代（Firestore SDK 的 set(data)） */
  set(path: string, data: Record<string, unknown>): Promise<void>;
  /** 合併（SDK 的 set(data, { merge: true })） */
  merge(path: string, data: Record<string, unknown>): Promise<void>;
}

export function makeFirestoreStore(getToken: () => Promise<string>, deps: Deps = realDeps, projectId = PROJECT_ID): Store {
  const write = async (path: string, data: Record<string, unknown>, mask?: string[]) => {
    const qs = mask ? "?" + mask.map((p) => `updateMask.fieldPaths=${encodeURIComponent(p)}`).join("&") : "";
    await callJson(
      documentUrl(path, projectId) + qs,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: encodeFields(data) }),
      },
      `Firestore 寫入 ${path}`,
      deps,
    );
  };
  return {
    set: (path, data) => write(path, data),
    merge: (path, data) => write(path, data, mergeFieldPaths(data)),
  };
}

// ---------- GA4 ----------
const num = (v: unknown): number => Number(v ?? 0) || 0;
interface GaRow { dimensionValues: { value: string }[]; metricValues: { value: string }[] }
interface GaReport { rows?: GaRow[] }
const rows = (r: GaReport | undefined): GaRow[] => r?.rows ?? [];

export interface Totals { users: number; sessions: number; views: number; avgEngagementSec: number }
export function toTotals(row: { metricValues?: { value?: string }[] } | undefined): Totals {
  const m = row?.metricValues ?? [];
  const users = num(m[0]?.value);
  return {
    users,
    sessions: num(m[1]?.value),
    views: num(m[2]?.value),
    avgEngagementSec: users > 0 ? Math.round((num(m[3]?.value) / users) * 10) / 10 : 0,
  };
}

export const listReq = (date: string, dimensions: string[], metrics: string[], orderMetric: string, limit: number, hostFilter?: string) => ({
  dateRanges: [{ startDate: date, endDate: date }],
  dimensions: dimensions.map((name) => ({ name })),
  metrics: metrics.map((name) => ({ name })),
  orderBys: [{ metric: { metricName: orderMetric }, desc: true }],
  limit,
  ...(hostFilter ? { dimensionFilter: { filter: { fieldName: "hostName", stringFilter: { matchType: "EXACT", value: hostFilter } } } } : {}),
});

export function listsFromReports([sources, landing, pages, pairs]: GaReport[]) {
  return {
    sources: rows(sources).map((r) => ({ key: r.dimensionValues[0].value, sessions: num(r.metricValues[0].value), users: num(r.metricValues[1].value) })),
    landing: rows(landing).map((r) => ({ key: r.dimensionValues[0].value, sessions: num(r.metricValues[0].value), users: num(r.metricValues[1].value) })),
    pages: rows(pages).map((r) => ({ key: r.dimensionValues[0].value, views: num(r.metricValues[0].value), users: num(r.metricValues[1].value) })),
    pairs: rows(pairs).map((r) => ({ source: r.dimensionValues[0].value, landing: r.dimensionValues[1].value, sessions: num(r.metricValues[0].value) })),
  };
}

export const scopeRequests = (date: string, hostFilter?: string) => [
  listReq(date, ["sessionSourceMedium"], ["sessions", "activeUsers"], "sessions", 20, hostFilter),
  listReq(date, ["landingPage"], ["sessions", "activeUsers"], "sessions", 20, hostFilter),
  listReq(date, ["pagePath"], ["screenPageViews", "activeUsers"], "screenPageViews", 20, hostFilter),
  listReq(date, ["sessionSourceMedium", "landingPage"], ["sessions"], "sessions", 50, hostFilter),
];

export async function gaBatch(propertyId: string, token: string, requests: unknown[], deps: Deps = realDeps): Promise<GaReport[]> {
  const out: GaReport[] = [];
  for (let i = 0; i < requests.length; i += GA_BATCH) {
    const chunk = requests.slice(i, i + GA_BATCH);
    const body = await callJson(
      `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:batchRunReports`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requests: chunk }),
      },
      "GA 資料 API",
      deps,
    );
    out.push(...(body?.reports ?? []));
  }
  return out;
}

export async function fetchGaDay(propertyId: string, token: string, date: string, maxHosts: number, deps: Deps = realDeps) {
  const totalReq = {
    dateRanges: [{ startDate: date, endDate: date }],
    metrics: GA_METRICS.map((name) => ({ name })),
  };
  const hostReq = listReq(date, ["hostName"], GA_METRICS, "screenPageViews", 10);
  const reports = await gaBatch(propertyId, token, [totalReq, hostReq, ...scopeRequests(date)], deps);
  const total = { ...toTotals(rows(reports[0])[0]), ...listsFromReports(reports.slice(2, 6)) };
  const hostRows = rows(reports[1])
    .filter((r) => r.dimensionValues[0].value && r.dimensionValues[0].value !== "(not set)" && num(r.metricValues[2].value) > 0)
    .slice(0, maxHosts);
  const hosts = [];
  for (const hr of hostRows) {
    const host = hr.dimensionValues[0].value;
    const hostReports = await gaBatch(propertyId, token, scopeRequests(date, host), deps);
    hosts.push({ host, label: domainToUnicode(host) || host, ...toTotals(hr), ...listsFromReports(hostReports) });
  }
  return { total, hosts };
}

export async function fetchGaSummary(propertyId: string, token: string, nowMs: number, deps: Deps = realDeps) {
  const today = dayOffset(nowMs, 0);
  const ranges = [
    { name: "today", startDate: today, endDate: today },
    { name: "yesterday", startDate: dayOffset(nowMs, 1), endDate: dayOffset(nowMs, 1) },
    { name: "last7", startDate: dayOffset(nowMs, 6), endDate: today },
    { name: "last30", startDate: dayOffset(nowMs, 29), endDate: today },
  ];
  const [report] = await gaBatch(propertyId, token, [
    { dateRanges: ranges, metrics: GA_METRICS.map((name) => ({ name })) },
  ], deps);
  const out: Record<string, Totals> = {};
  for (const r of ranges) out[r.name] = toTotals(undefined);
  for (const row of rows(report)) out[row.dimensionValues[0].value] = toTotals(row);
  return out;
}

// ---------- 主流程 ----------
export interface RunInput {
  config: ConsoleConfig;
  /** 環境變數（只讀 REQUIRED_ENV） */
  env: Record<string, string | undefined>;
  deps: Deps;
  store: Store;
  getToken: () => Promise<string>;
}
export interface RunResult {
  success: boolean;
  /** 缺的環境變數名稱（不含值） */
  missing: string[];
  sources: Record<string, { state: SourceState; message: string | null }>;
}

export async function runConsoleFetch(input: RunInput): Promise<RunResult> {
  const { config, env, deps, store, getToken } = input;
  const backfill = config.backfillDays ?? 30;
  const maxHosts = config.maxHostsPerSite ?? 4;
  const startMs = deps.now();
  const { dates } = dateWindow(startMs, backfill);
  const nowIso = () => new Date(deps.now()).toISOString();
  const sourceStatus: Record<string, SourceStatus> = {};
  const setStatus = (id: string, label: string, state: SourceState, message?: string | null, success = false) => {
    sourceStatus[id] = makeStatus(label, state, message, nowIso(), success);
  };

  async function runGaSite(siteId: string, site: { name: string; country: string; propertyId?: string }) {
    const sid = `ga-${siteId}`;
    const label = `GA4 ${site.name}（${site.country}）`;
    if (!site.propertyId) {
      setStatus(sid, label, "unconfigured", "尚未設定 GA 資源編號");
      return;
    }
    const propertyId = site.propertyId;
    try {
      const token = await getToken();
      // 先用一次輕量查詢確認有權限，沒權限就只記錯誤、不再打一堆請求
      const summary = await fetchGaSummary(propertyId, token, startMs, deps);
      await store.set(`summary/${siteId}`, { site: siteId, updatedAt: nowIso(), propertyId, ...summary });
      let failed = 0;
      let firstError = "";
      const queue = [...dates].reverse(); // 新的先抓
      const worker = async () => {
        while (queue.length) {
          const date = queue.shift()!;
          try {
            const day = await fetchGaDay(propertyId, token, date, maxHosts, deps);
            await store.set(`daily/${siteId}_${date}`, { site: siteId, date, propertyId, fetchedAt: nowIso(), ...day });
          } catch (e) {
            failed++;
            firstError ||= (e as Error).message;
            if (e instanceof ApiError && (e.status === 403 || e.status === 404)) queue.length = 0;
          }
        }
      };
      await Promise.all(Array.from({ length: GA_WORKERS }, worker));
      if (failed) setStatus(sid, label, "error", `部分日期失敗（${failed}/${dates.length}）：${firstError}`);
      else setStatus(sid, label, "ok", null, true);
    } catch (e) {
      setStatus(sid, label, "error", (e as Error).message);
    }
  }

  const missing = missingEnv(env);
  for (const [id, site] of Object.entries(config.sites)) await runGaSite(id, site);
  // 任一資料源失敗只記錄到 meta/status；只有這一步（Firestore 寫入本身壞掉）會往外丟。
  // 只寫 GA 的欄位（updatedAt、sources.ga-*）：merge 的 updateMask 逐葉列出，別人寫的 sources.* 不會被動到。
  await store.merge("meta/status", { updatedAt: nowIso(), sources: sourceStatus });
  const summary = Object.fromEntries(Object.entries(sourceStatus).map(([k, v]) => [k, { state: v.state, message: v.message }]));
  deps.log("完成：", Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, `${v.state}${v.message ? " - " + v.message : ""}`])));
  return { success: missing.length === 0, missing, sources: summary };
}