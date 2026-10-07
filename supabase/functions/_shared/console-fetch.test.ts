import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  adsenseDocs,
  adsenseParams,
  ApiError,
  backoffMs,
  base64Url,
  buildJwtAssertion,
  callJson,
  CONSOLE_CONFIG,
  type Deps,
  dateWindow,
  dayOffset,
  documentUrl,
  encodeFields,
  encodeValue,
  fieldPathSegment,
  listReq,
  listsFromReports,
  makeFirestoreStore,
  makeStatus,
  makeTokenGetter,
  mergeFieldPaths,
  missingEnv,
  parseServiceAccountKey,
  pemToPkcs8,
  runConsoleFetch,
  scopeRequests,
  type Store,
  toTotals,
  withAllSitesDomain,
} from "./console-fetch.ts";

// ---------- 假依賴 ----------
// 2026-10-07 17:00 UTC＝台灣時間 2026-10-08 01:00（跨日，專門驗「以台灣時間為準」）
const NOW_MS = Date.UTC(2026, 9, 7, 17, 0, 0);

function fakeDeps(fetchImpl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const sleeps: number[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const logs: unknown[][] = [];
  const deps: Deps = {
    fetch: ((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(fetchImpl(String(url), init ?? {}));
    }) as typeof fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    now: () => NOW_MS,
    log: (...a) => {
      logs.push(a);
    },
  };
  return { deps, sleeps, calls, logs };
}
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// ---------- 日期 ----------
Deno.test("日期：以台灣時間為準（UTC 17:00 已經是隔天）", () => {
  assertEquals(dayOffset(NOW_MS, 0), "2026-10-08");
  assertEquals(dayOffset(NOW_MS, 1), "2026-10-07");
  assertEquals(dayOffset(NOW_MS, 8), "2026-09-30", "跨月");
  const w = dateWindow(NOW_MS, 3);
  assertEquals(w.today, "2026-10-08");
  assertEquals(w.dates, ["2026-10-06", "2026-10-07", "2026-10-08"], "舊→新、最後一天是今天");
  const w30 = dateWindow(NOW_MS, CONSOLE_CONFIG.backfillDays);
  assertEquals(w30.dates.length, 30);
  assertEquals(w30.dates[0], "2026-09-09");
  assertEquals(w30.dates[29], "2026-10-08");
});

Deno.test("日期：UTC 15:59 還是台灣的同一天、16:00 換日", () => {
  assertEquals(dayOffset(Date.UTC(2026, 9, 7, 15, 59), 0), "2026-10-07");
  assertEquals(dayOffset(Date.UTC(2026, 9, 7, 16, 0), 0), "2026-10-08");
});

// ---------- 設定 ----------
Deno.test("設定：與 policy-console 的 config/sites.json 一致", () => {
  assertEquals(CONSOLE_CONFIG.sites.tw, { name: "正見", country: "台灣", propertyId: "521879439" });
  assertEquals(CONSOLE_CONFIG.sites.jp, { name: "政策の系譜", country: "日本", propertyId: "557622261" });
  assertEquals(Object.keys(CONSOLE_CONFIG.sites), ["tw", "jp"]);
  assertEquals(CONSOLE_CONFIG.backfillDays, 30);
  assertEquals(CONSOLE_CONFIG.maxHostsPerSite, 4);
  assertEquals(CONSOLE_CONFIG.adsenseAccount, "accounts/pub-6687848895101003");
});

Deno.test("環境變數：缺哪些就回哪些名稱，空字串也算缺", () => {
  assertEquals(missingEnv({}), ["GCP_SA_KEY", "ADSENSE_REFRESH_TOKEN", "ADSENSE_CLIENT_ID", "ADSENSE_CLIENT_SECRET"]);
  assertEquals(missingEnv({ GCP_SA_KEY: "x", ADSENSE_REFRESH_TOKEN: "", ADSENSE_CLIENT_ID: "y", ADSENSE_CLIENT_SECRET: "z" }), ["ADSENSE_REFRESH_TOKEN"]);
  assertEquals(missingEnv({ GCP_SA_KEY: "x", ADSENSE_REFRESH_TOKEN: "a", ADSENSE_CLIENT_ID: "y", ADSENSE_CLIENT_SECRET: "z" }), []);
});

// ---------- GA 回應整理 ----------
Deno.test("toTotals：平均互動秒數＝總互動時間 ÷ 使用者、四捨五入到一位；沒有使用者就是 0", () => {
  assertEquals(toTotals({ metricValues: [{ value: "3" }, { value: "5" }, { value: "9" }, { value: "100" }] }), { users: 3, sessions: 5, views: 9, avgEngagementSec: 33.3 });
  assertEquals(toTotals({ metricValues: [{ value: "0" }, { value: "0" }, { value: "0" }, { value: "50" }] }).avgEngagementSec, 0);
  assertEquals(toTotals(undefined), { users: 0, sessions: 0, views: 0, avgEngagementSec: 0 });
  assertEquals(toTotals({ metricValues: [{ value: "abc" }] }).users, 0, "不是數字當 0");
});

Deno.test("listReq／scopeRequests：四組請求、只有指定主機時才帶 hostName 篩選", () => {
  const plain = scopeRequests("2026-10-07");
  assertEquals(plain.length, 4);
  assertEquals(plain.map((r) => r.limit), [20, 20, 20, 50]);
  assertEquals(plain.map((r) => r.dimensions.map((d) => d.name)), [["sessionSourceMedium"], ["landingPage"], ["pagePath"], ["sessionSourceMedium", "landingPage"]]);
  assertEquals(plain.map((r) => r.orderBys[0].metric.metricName), ["sessions", "sessions", "screenPageViews", "sessions"]);
  assert(plain.every((r) => !("dimensionFilter" in r)));
  const host = scopeRequests("2026-10-07", "xn--2lw665d.tw");
  assertEquals(host[0].dimensionFilter, { filter: { fieldName: "hostName", stringFilter: { matchType: "EXACT", value: "xn--2lw665d.tw" } } });
  assertEquals(listReq("d", ["a"], ["m"], "m", 1).dateRanges, [{ startDate: "d", endDate: "d" }]);
});

Deno.test("listsFromReports：四份報表各自整理成 sources／landing／pages／pairs", () => {
  const r = (dims: string[], mets: string[]) => ({ rows: [{ dimensionValues: dims.map((value) => ({ value })), metricValues: mets.map((value) => ({ value })) }] });
  const out = listsFromReports([r(["google / organic"], ["5", "3"]), r(["/"], ["4", "2"]), r(["/a"], ["8", "6"]), r(["google / organic", "/"], ["5"])]);
  assertEquals(out, {
    sources: [{ key: "google / organic", sessions: 5, users: 3 }],
    landing: [{ key: "/", sessions: 4, users: 2 }],
    pages: [{ key: "/a", views: 8, users: 6 }],
    pairs: [{ source: "google / organic", landing: "/", sessions: 5 }],
  });
  assertEquals(listsFromReports([{}, {}, {}, {}]), { sources: [], landing: [], pages: [], pairs: [] }, "沒有列也不會壞");
});

// ---------- AdSense 整理 ----------
Deno.test("adsenseParams：自訂區間、依日期＋網域、帶帳號時區", () => {
  const p = adsenseParams("2026-09-09", "2026-10-08");
  assertEquals(p.get("dateRange"), "CUSTOM");
  assertEquals([p.get("startDate.year"), p.get("startDate.month"), p.get("startDate.day")], ["2026", "9", "9"]);
  assertEquals([p.get("endDate.year"), p.get("endDate.month"), p.get("endDate.day")], ["2026", "10", "8"]);
  assertEquals(p.getAll("dimensions"), ["DATE", "DOMAIN_NAME"]);
  assertEquals(p.getAll("metrics"), ["ESTIMATED_EARNINGS", "IMPRESSIONS", "CLICKS", "PAGE_VIEWS", "PAGE_VIEWS_RPM"]);
  assertEquals(p.get("reportingTimeZone"), "ACCOUNT_TIME_ZONE");
  assertEquals(adsenseParams("2026-09-09", "2026-10-08", ["DATE"]).getAll("dimensions"), ["DATE"]);
});

const adsenseReport = () => ({
  headers: [
    { name: "DATE", type: "DIMENSION" },
    { name: "DOMAIN_NAME", type: "DIMENSION" },
    { name: "ESTIMATED_EARNINGS", type: "METRIC_CURRENCY", currencyCode: "TWD" },
    { name: "IMPRESSIONS", type: "METRIC_TALLY" },
    { name: "CLICKS", type: "METRIC_TALLY" },
    { name: "PAGE_VIEWS", type: "METRIC_TALLY" },
    { name: "PAGE_VIEWS_RPM", type: "METRIC_RATIO" },
  ],
  rows: [
    { cells: [{ value: "2026-10-07" }, { value: "a.tw" }, { value: "1.5" }, { value: "10" }, { value: "2" }, { value: "100" }, { value: "15" }] },
    { cells: [{ value: "2026-10-07" }, { value: "b.tw" }, { value: "0.5" }, { value: "5" }, { value: "1" }, { value: "100" }, { value: "5" }] },
    { cells: [{ value: "2026-10-08" }, { value: "a.tw" }, { value: "0" }, { value: "0" }, { value: "0" }, { value: "0" }, { value: "0" }] },
  ],
});

Deno.test("adsenseDocs：每天一份、依網域列出、合計的頁面 RPM＝總收益 ÷ 總瀏覽 × 1000、沒瀏覽時為 0", () => {
  const docs = adsenseDocs(adsenseReport(), "2026-10-08T00:00:00.000Z");
  assertEquals(docs.map((d) => d.date), ["2026-10-07", "2026-10-08"]);
  assertEquals(docs[0], {
    date: "2026-10-07",
    currency: "TWD",
    fetchedAt: "2026-10-08T00:00:00.000Z",
    domains: [
      { domain: "a.tw", earnings: 1.5, impressions: 10, clicks: 2, pageViews: 100, pageRpm: 15 },
      { domain: "b.tw", earnings: 0.5, impressions: 5, clicks: 1, pageViews: 100, pageRpm: 5 },
    ],
    total: { earnings: 2, impressions: 15, clicks: 3, pageViews: 200, pageRpm: 10 },
  });
  assertEquals(docs[1].total.pageRpm, 0);
  assertEquals(adsenseDocs({}, "x"), [], "沒有列就沒有文件");
});

Deno.test("withAllSitesDomain：只依日期的報表補上網域欄「全部網站」，整理出來跟依網域的同形", () => {
  const dateOnly = {
    headers: [{ name: "DATE" }, { name: "ESTIMATED_EARNINGS", currencyCode: "TWD" }, { name: "IMPRESSIONS" }, { name: "CLICKS" }, { name: "PAGE_VIEWS" }, { name: "PAGE_VIEWS_RPM" }],
    rows: [{ cells: [{ value: "2026-10-07" }, { value: "2" }, { value: "15" }, { value: "3" }, { value: "200" }, { value: "10" }] }],
  };
  const docs = adsenseDocs(withAllSitesDomain(dateOnly), "t");
  assertEquals(docs[0].currency, "TWD");
  assertEquals(docs[0].domains, [{ domain: "全部網站", earnings: 2, impressions: 15, clicks: 3, pageViews: 200, pageRpm: 10 }]);
});

// ---------- Firestore 編碼 ----------
Deno.test("Firestore 值編碼：整數 integerValue（字串）、小數 doubleValue、null、巢狀、陣列", () => {
  assertEquals(encodeValue(3), { integerValue: "3" });
  assertEquals(encodeValue(0), { integerValue: "0" });
  assertEquals(encodeValue(33.3), { doubleValue: 33.3 });
  assertEquals(encodeValue(-2), { integerValue: "-2" });
  assertEquals(encodeValue("字"), { stringValue: "字" });
  assertEquals(encodeValue(true), { booleanValue: true });
  assertEquals(encodeValue(null), { nullValue: null });
  assertEquals(encodeValue([]), { arrayValue: {} });
  assertEquals(encodeValue([1, "a"]), { arrayValue: { values: [{ integerValue: "1" }, { stringValue: "a" }] } });
  assertEquals(encodeValue({ a: { b: 1.5 } }), { mapValue: { fields: { a: { mapValue: { fields: { b: { doubleValue: 1.5 } } } } } } });
  assertEquals(encodeValue(NaN), { doubleValue: "NaN" });
});

Deno.test("Firestore 欄位編碼：undefined 的欄位略過，其餘照編", () => {
  assertEquals(encodeFields({ a: 1, b: undefined, c: null }), { a: { integerValue: "1" }, c: { nullValue: null } });
});

Deno.test("meta/status 的合併欄位：葉子逐一列出，含連字號的鍵用反引號；失敗時沒給 lastSuccess 就不在清單裡（舊值保留）", () => {
  const ok = makeStatus("GA4 正見（台灣）", "ok", null, "T", true);
  const bad = makeStatus("AdSense", "error", "壞了", "T");
  assertEquals(bad, { label: "AdSense", state: "error", message: "壞了", lastAttempt: "T" });
  assertEquals(mergeFieldPaths({ updatedAt: "T", sources: { "ga-tw": ok, adsense: bad } }), [
    "updatedAt",
    "sources.`ga-tw`.label",
    "sources.`ga-tw`.state",
    "sources.`ga-tw`.message",
    "sources.`ga-tw`.lastAttempt",
    "sources.`ga-tw`.lastSuccess",
    "sources.adsense.label",
    "sources.adsense.state",
    "sources.adsense.message",
    "sources.adsense.lastAttempt",
  ]);
  assertEquals(fieldPathSegment("a`b"), "`a\\`b`");
  assertEquals(fieldPathSegment("_ok1"), "_ok1");
  assertEquals(fieldPathSegment("1abc"), "`1abc`");
});

Deno.test("documentUrl：專案 policy-tw、(default) 資料庫、每段路徑各自編碼", () => {
  assertEquals(documentUrl("daily/tw_2026-10-07"), "https://firestore.googleapis.com/v1/projects/policy-tw/databases/(default)/documents/daily/tw_2026-10-07");
  assertEquals(documentUrl("meta/status"), "https://firestore.googleapis.com/v1/projects/policy-tw/databases/(default)/documents/meta/status");
  assertEquals(documentUrl("a/b c"), "https://firestore.googleapis.com/v1/projects/policy-tw/databases/(default)/documents/a/b%20c");
});
// ---------- HTTP 重試 ----------
Deno.test("backoffMs：429 指數退避 5s/10s/20s＋抖動、其餘 1.5s/3s/4.5s＋抖動", () => {
  assertEquals([0, 1, 2].map((a) => backoffMs(429, a, 0)), [5000, 10000, 20000]);
  assertEquals([0, 1, 2].map((a) => backoffMs(500, a, 0)), [1500, 3000, 4500]);
  assertEquals(backoffMs(429, 0, 0.5), 5500);
});

Deno.test("callJson：429 連續到底＝睡 3 次（不是 4 次）後丟 ApiError，帶狀態碼與 API 的錯誤訊息", async () => {
  const { deps, sleeps, calls } = fakeDeps(() => jsonRes({ error: { message: "Too many" } }, 429));
  const e = await assertRejects(() => callJson("https://x", {}, "GA 資料 API", deps), ApiError);
  assertEquals(e.status, 429);
  assertEquals(e.message, "GA 資料 API 429：Too many");
  assertEquals(calls.length, 4);
  assertEquals(sleeps, [5500, 10500, 20500]);
});

Deno.test("callJson：5xx 重試後成功；4xx 不重試直接丟；錯誤訊息的退路順序 error_description → error → 內文前 300 字", async () => {
  let n = 0;
  const a = fakeDeps(() => (++n < 3 ? new Response("boom", { status: 503 }) : jsonRes({ ok: 1 })));
  assertEquals(await callJson("https://x", {}, "L", a.deps), { ok: 1 });
  assertEquals(a.sleeps, [2000, 3500]);

  const b = fakeDeps(() => jsonRes({ error: "invalid_grant", error_description: "Token expired" }, 400));
  assertEquals((await assertRejects(() => callJson("https://x", {}, "AdSense 授權", b.deps), ApiError)).message, "AdSense 授權 400：Token expired");
  assertEquals(b.calls.length, 1);

  const c = fakeDeps(() => jsonRes({ error: "invalid_grant" }, 400));
  assertEquals((await assertRejects(() => callJson("https://x", {}, "L", c.deps), ApiError)).message, "L 400：invalid_grant");

  const d = fakeDeps(() => new Response("x".repeat(500), { status: 403 }));
  assertEquals((await assertRejects(() => callJson("https://x", {}, "L", d.deps), ApiError)).message, `L 403：${"x".repeat(300)}`);
});

// ---------- 服務帳號 JWT ----------
// 分開寫：scripts/scan-secrets.ts 會把連續的私鑰標頭當成外洩（這裡只是測試用的臨時金鑰）
const PEM_BEGIN = "-----BEGIN " + "PRIVATE KEY-----";
const PEM_END = "-----END " + "PRIVATE KEY-----";
async function makeTestKey() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const pem = `${PEM_BEGIN}\n${btoa(bin).replace(/(.{64})/g, "$1\n")}\n${PEM_END}\n`;
  return { pair, pem };
}
const unb64url = (x: string) => Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (x.length % 4)) % 4)), (ch) => ch.charCodeAt(0));

Deno.test("JWT：RS256 簽章驗得過、claims 帶 iss／scope／aud／iat／exp", async () => {
  const { pair, pem } = await makeTestKey();
  const jwt = await buildJwtAssertion({ client_email: "sa@policy-tw.iam.gserviceaccount.com", private_key: pem }, ["s1", "s2"], 1_700_000_000);
  const [h, c, s] = jwt.split(".");
  const dec = (x: string) => JSON.parse(new TextDecoder().decode(unb64url(x)));
  assertEquals(dec(h), { alg: "RS256", typ: "JWT" });
  assertEquals(dec(c), { iss: "sa@policy-tw.iam.gserviceaccount.com", scope: "s1 s2", aud: "https://oauth2.googleapis.com/token", iat: 1_700_000_000, exp: 1_700_003_600 });
  assert(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, unb64url(s), new TextEncoder().encode(`${h}.${c}`)), "簽章要能用公鑰驗過");
  assert(!/[=+/]/.test(jwt), "base64url 不含 = + /");
});

Deno.test("base64Url／pemToPkcs8", () => {
  assertEquals(base64Url("??>>"), "Pz8-Pg");
  assertEquals(new Uint8Array(pemToPkcs8(`${PEM_BEGIN}\nAQID\nBAU=\n${PEM_END}\n`)), new Uint8Array([1, 2, 3, 4, 5]));
});

Deno.test("parseServiceAccountKey：缺欄位或不是 JSON 都丟錯，錯誤訊息不含金鑰內容", () => {
  const sa = parseServiceAccountKey(JSON.stringify({ client_email: "a@b", private_key: "SECRET-KEY-BODY", extra: 1 }));
  assertEquals(sa, { client_email: "a@b", private_key: "SECRET-KEY-BODY" });
  for (const bad of [undefined, "", "{not json SECRET-KEY-BODY", JSON.stringify({ client_email: "a@b", private_key: "" }), JSON.stringify({ private_key: "SECRET-KEY-BODY" })]) {
    let msg = "";
    try {
      parseServiceAccountKey(bad);
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(msg, `應該丟錯：${String(bad)}`);
    assert(!msg.includes("SECRET-KEY-BODY"), "錯誤訊息不得帶出金鑰內容");
  }
});

Deno.test("makeTokenGetter：用 JWT bearer 換權杖（GA＋Firestore 兩個 scope）、同一輪只換一次；失敗不記住", async () => {
  const { pem } = await makeTestKey();
  const sa = { client_email: "sa@x", private_key: pem };
  let n = 0;
  const ok = fakeDeps(() => (++n === 1 ? jsonRes({ error: "x" }, 400) : jsonRes({ access_token: "tok-1" })));
  const get = makeTokenGetter(sa, ok.deps);
  await assertRejects(() => get(), ApiError);
  assertEquals(await get(), "tok-1", "上一次失敗，這次重換");
  assertEquals(await get(), "tok-1");
  assertEquals(ok.calls.length, 2, "成功之後不再打");
  const body = new URLSearchParams(String(ok.calls[1].init.body));
  assertEquals(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const claims = JSON.parse(new TextDecoder().decode(unb64url(body.get("assertion")!.split(".")[1])));
  assertEquals(claims.scope, "https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/datastore");
});

Deno.test("Firestore store：set 不帶 updateMask（整份取代）、merge 帶欄位遮罩；都用 PATCH ＋ Bearer", async () => {
  const { deps, calls } = fakeDeps(() => jsonRes({}));
  const store = makeFirestoreStore(() => Promise.resolve("TOK"), deps);
  await store.set("daily/tw_2026-10-07", { site: "tw", n: 2 });
  await store.merge("meta/status", { updatedAt: "T", sources: { "ga-tw": { state: "ok" } } });
  assertEquals(calls[0].url, "https://firestore.googleapis.com/v1/projects/policy-tw/databases/(default)/documents/daily/tw_2026-10-07");
  assertEquals(calls[0].init.method, "PATCH");
  assertEquals((calls[0].init.headers as Record<string, string>).Authorization, "Bearer TOK");
  assertEquals(JSON.parse(String(calls[0].init.body)), { fields: { site: { stringValue: "tw" }, n: { integerValue: "2" } } });
  const u = new URL(calls[1].url);
  assertEquals(u.searchParams.getAll("updateMask.fieldPaths"), ["updatedAt", "sources.`ga-tw`.state"]);
});
// ---------- 整條流程（假 GA／AdSense／Firestore） ----------
const ADSENSE_ENV = { GCP_SA_KEY: "(unused)", ADSENSE_REFRESH_TOKEN: "r", ADSENSE_CLIENT_ID: "c", ADSENSE_CLIENT_SECRET: "s" };
const getTok = () => Promise.resolve("ga-token");

function memStore(failPath?: string) {
  const sets = new Map<string, Record<string, unknown>>();
  const merges: { path: string; data: Record<string, unknown> }[] = [];
  const fail = (path: string) => Promise.reject(new Error(`Firestore 寫入 ${path} 503`));
  const store: Store = {
    set: (path, data) => {
      if (path === failPath) return fail(path);
      sets.set(path, data);
      return Promise.resolve();
    },
    merge: (path, data) => {
      if (path === failPath) return fail(path);
      merges.push({ path, data });
      return Promise.resolve();
    },
  };
  return { store, sets, merges };
}
type Sources = Record<string, { state: string; message: string | null; lastSuccess?: string; label: string }>;
const statusOf = (m: ReturnType<typeof memStore>) => (m.merges[0].data as { sources: Sources }).sources;

// 假 Google：依請求形狀回資料。opts.gaFail＝逐日請求回這個狀態碼（摘要那次探測仍成功）
function fakeGoogle(opts: { gaFail?: number; adsenseDomainRows?: boolean; adsenseNoAccount?: boolean } = {}) {
  type GaReq = { dateRanges: { startDate: string }[]; dimensions?: { name: string }[]; dimensionFilter?: unknown };
  const gaCalls: { property: string; requests: GaReq[] }[] = [];
  const t = fakeDeps((url, init) => {
    const u = new URL(url);
    if (u.host === "analyticsdata.googleapis.com") {
      const property = u.pathname.split("/")[3].split(":")[0];
      const requests: GaReq[] = JSON.parse(String(init.body)).requests;
      gaCalls.push({ property, requests });
      const isSummary = requests[0].dateRanges.length === 4;
      if (opts.gaFail && !isSummary) return jsonRes({ error: { message: "forbidden" } }, opts.gaFail);
      const mv = (...v: string[]) => v.map((value) => ({ value }));
      const reports = requests.map((r) => {
        if (isSummary) {
          return { rows: ["today", "yesterday", "last7", "last30"].map((name, i) => ({ dimensionValues: mv(name), metricValues: mv(String(i + 1), "2", "3", "40") })) };
        }
        const dim = r.dimensions?.[0]?.name;
        if (!dim) return { rows: [{ metricValues: mv("10", "12", "30", "100") }] };
        if (dim === "hostName") {
          return {
            rows: [
              { dimensionValues: mv("xn--2lw665d.tw"), metricValues: mv("8", "9", "20", "80") },
              { dimensionValues: mv("(not set)"), metricValues: mv("1", "1", "5", "1") },
              { dimensionValues: mv("zero.tw"), metricValues: mv("0", "0", "0", "0") },
            ],
          };
        }
        return { rows: [{ dimensionValues: r.dimensions!.map((d) => ({ value: `${d.name}-v` })), metricValues: mv("7", "5") }] };
      });
      return jsonRes({ reports });
    }
    if (u.host === "oauth2.googleapis.com") return jsonRes({ access_token: "adsense-token" });
    if (u.host === "adsense.googleapis.com") {
      if (u.pathname === "/v2/accounts") {
        return jsonRes({ accounts: opts.adsenseNoAccount ? [{ name: "accounts/pub-1", displayName: "別人" }] : [{ name: "accounts/pub-6687848895101003", displayName: "我" }, { name: "accounts/pub-2" }] });
      }
      const dims = u.searchParams.getAll("dimensions");
      if (dims.length === 2) return jsonRes(opts.adsenseDomainRows ? adsenseReport() : { headers: [], rows: [] });
      return jsonRes({
        headers: [{ name: "DATE" }, { name: "ESTIMATED_EARNINGS", currencyCode: "TWD" }, { name: "IMPRESSIONS" }, { name: "CLICKS" }, { name: "PAGE_VIEWS" }, { name: "PAGE_VIEWS_RPM" }],
        rows: [{ cells: [{ value: "2026-10-07" }, { value: "2" }, { value: "15" }, { value: "3" }, { value: "200" }, { value: "10" }] }],
        totals: { cells: [{ value: "2" }] },
      });
    }
    return new Response("unexpected " + url, { status: 599 });
  });
  return { ...t, gaCalls };
}
const run = (g: { deps: Deps }, m: ReturnType<typeof memStore>, env: Record<string, string | undefined> = ADSENSE_ENV, config = CONSOLE_CONFIG) =>
  runConsoleFetch({ config, env, deps: g.deps, store: m.store, getToken: getTok });

Deno.test("整條流程：兩站各 30 天＋摘要、AdSense 依網域、meta/status 全 ok", async () => {
  const g = fakeGoogle({ adsenseDomainRows: true });
  const m = memStore();
  const res = await run(g, m);
  assertEquals(res.success, true);
  assertEquals(res.missing, []);

  // 文件路徑
  const paths = [...m.sets.keys()];
  assertEquals(paths.filter((p) => p.startsWith("daily/tw_")).length, 30);
  assertEquals(paths.filter((p) => p.startsWith("daily/jp_")).length, 30);
  assert(m.sets.has("summary/tw") && m.sets.has("summary/jp"));
  assertEquals(paths.filter((p) => p.startsWith("adsense/")).sort(), ["adsense/2026-10-07", "adsense/2026-10-08"]);
  assert(m.sets.has("daily/tw_2026-10-08") && m.sets.has("daily/tw_2026-09-09") && !m.sets.has("daily/tw_2026-09-08"));

  // summary 欄位
  const sum = m.sets.get("summary/tw")!;
  assertEquals(Object.keys(sum).sort(), ["last30", "last7", "propertyId", "site", "today", "updatedAt", "yesterday"]);
  assertEquals(sum.propertyId, "521879439");
  assertEquals(sum.today, { users: 1, sessions: 2, views: 3, avgEngagementSec: 40 });
  assertEquals(m.sets.get("summary/jp")!.propertyId, "557622261");

  // 逐日欄位：total＋hosts（只留有瀏覽、非 (not set) 的主機，label 為解碼後網域）
  const day = m.sets.get("daily/tw_2026-10-07") as { site: string; date: string; propertyId: string; total: Record<string, unknown>; hosts: Record<string, unknown>[] };
  assertEquals([day.site, day.date, day.propertyId], ["tw", "2026-10-07", "521879439"]);
  assertEquals(Object.keys(day).sort(), ["date", "fetchedAt", "hosts", "propertyId", "site", "total"]);
  assertEquals(day.total.users, 10);
  assertEquals(day.total.avgEngagementSec, 10);
  assertEquals(Object.keys(day.total).sort(), ["avgEngagementSec", "landing", "pages", "pairs", "sessions", "sources", "users", "views"]);
  assertEquals(day.hosts.length, 1);
  assertEquals(day.hosts[0].host, "xn--2lw665d.tw");
  assertEquals(day.hosts[0].label, "正見.tw");
  assertEquals(day.hosts[0].views, 20);
  assertEquals(Object.keys(day.hosts[0]).sort(), ["avgEngagementSec", "host", "label", "landing", "pages", "pairs", "sessions", "sources", "users", "views"]);

  // GA 請求：每批最多 4 個查詢（GA_BATCH）；每個資源的查詢都帶對 property
  assert(g.gaCalls.every((c) => c.requests.length <= 4));
  assertEquals(new Set(g.gaCalls.map((c) => c.property)), new Set(["521879439", "557622261"]));
  // 每日：整體 6 個查詢切成 4＋2、有一個主機再一批 4 個
  const perDay = g.gaCalls.filter((c) => c.property === "521879439" && c.requests[0].dateRanges[0].startDate === "2026-10-07");
  assertEquals(perDay.map((c) => c.requests.length), [4, 2, 4]);
  assert(perDay[2].requests.every((r) => r.dimensionFilter), "主機那批要帶 hostName 篩選");

  // AdSense 文件
  const ad = m.sets.get("adsense/2026-10-07") as { currency: string; domains: unknown[]; total: { pageRpm: number } };
  assertEquals(ad.currency, "TWD");
  assertEquals(ad.domains.length, 2);
  assertEquals(ad.total.pageRpm, 10);

  // meta/status：一次合併寫入、三個來源
  assertEquals(m.merges.length, 1);
  assertEquals(m.merges[0].path, "meta/status");
  const sources = statusOf(m);
  assertEquals(Object.keys(sources), ["ga-tw", "ga-jp", "adsense"]);
  assertEquals(sources["ga-tw"].label, "GA4 正見（台灣）");
  assertEquals(sources["ga-jp"].label, "GA4 政策の系譜（日本）");
  for (const s of Object.values(sources)) {
    assertEquals(s.state, "ok");
    assertEquals(s.message, null);
    assert(s.lastSuccess);
  }
  assert(g.logs.some((l) => String(l[0]).startsWith("AdSense 帳號數")));
});

Deno.test("AdSense 依網域沒有列：退回只依日期，網域記成「全部網站」", async () => {
  const g = fakeGoogle({ adsenseDomainRows: false });
  const m = memStore();
  await run(g, m);
  const ad = m.sets.get("adsense/2026-10-07") as { domains: { domain: string }[]; currency: string };
  assertEquals(ad.domains.map((d) => d.domain), ["全部網站"]);
  assertEquals(ad.currency, "TWD");
  assertEquals(statusOf(m).adsense.state, "ok");
});

Deno.test("GA 逐日請求被拒（403）：佇列清空、不再往下打；該站記 error 並帶第一個錯誤；AdSense 照跑", async () => {
  const g = fakeGoogle({ gaFail: 403, adsenseDomainRows: true });
  const m = memStore();
  const res = await run(g, m);
  assertEquals(res.success, true, "資料源失敗只記 meta/status、不算整體失敗（與 fetch.mjs 一致）");
  assertEquals([...m.sets.keys()].filter((p) => p.startsWith("daily/")).length, 0);
  assert(m.sets.has("summary/tw"), "摘要那次探測成功、照寫");
  const s = statusOf(m);
  assertEquals(s["ga-tw"].state, "error");
  assert(s["ga-tw"].message!.startsWith("部分日期失敗（"), s["ga-tw"].message!);
  assert(s["ga-tw"].message!.includes("GA 資料 API 403：forbidden"));
  assertEquals(s.adsense.state, "ok");
  // 403 不重試、佇列清空：每站「摘要 1 次＋最多 GA_WORKERS 個在途請求」
  assert(g.gaCalls.filter((c) => c.property === "521879439").length <= 1 + 2);
});

Deno.test("摘要就失敗（例如沒有 GA 權限）：該站只記 error，不寫任何 GA 文件", async () => {
  const t = fakeDeps((url) => (url.includes("analyticsdata") ? jsonRes({ error: { message: "no access" } }, 403) : url.includes("oauth2") ? jsonRes({ access_token: "a" }) : jsonRes({ headers: [], rows: [] })));
  const m = memStore();
  await run(t, m);
  assertEquals([...m.sets.keys()].filter((p) => p.startsWith("daily/") || p.startsWith("summary/")), []);
  assertEquals(statusOf(m)["ga-tw"].message, "GA 資料 API 403：no access");
});

Deno.test("缺 AdSense 環境變數：adsense 記 error 並指名缺哪些、整體 success＝false，GA 照跑", async () => {
  const g = fakeGoogle();
  const m = memStore();
  const res = await run(g, m, { GCP_SA_KEY: "x", ADSENSE_CLIENT_ID: "c" });
  assertEquals(res.success, false);
  assertEquals(res.missing, ["ADSENSE_REFRESH_TOKEN", "ADSENSE_CLIENT_SECRET"]);
  assertEquals(res.sources.adsense, { state: "error", message: "缺少環境變數：ADSENSE_REFRESH_TOKEN、ADSENSE_CLIENT_SECRET" });
  assertEquals(res.sources["ga-tw"].state, "ok");
  assert(!g.calls.some((c) => c.url.includes("adsense") || c.url.includes("oauth2")), "缺環境變數就不打 AdSense");
  assert([...m.sets.keys()].some((p) => p.startsWith("daily/tw_")));
  assertEquals(m.merges.length, 1, "失敗狀態有寫進 meta/status");
  assertEquals(statusOf(m).adsense.state, "error");
});

Deno.test("AdSense 帳號對不上設定的 pub 編號：記 error，說出只看得到哪些", async () => {
  const g = fakeGoogle({ adsenseNoAccount: true });
  const m = memStore();
  const res = await run(g, m);
  assertEquals(res.sources.adsense.state, "error");
  assert(res.sources.adsense.message!.includes("pub-6687848895101003") && res.sources.adsense.message!.includes("只看得到：pub-1"));
});

Deno.test("ADSENSE_ACCOUNT 環境變數指定帳號時不查帳號清單", async () => {
  const g = fakeGoogle({ adsenseDomainRows: true });
  const m = memStore();
  await run(g, m, { ...ADSENSE_ENV, ADSENSE_ACCOUNT: "accounts/pub-9" });
  assert(!g.calls.some((c) => c.url.endsWith("/v2/accounts")));
  assert(g.calls.some((c) => c.url.includes("/v2/accounts/pub-9/reports:generate")));
});

Deno.test("沒設定 GA 資源編號的站：記 unconfigured、不打 GA", async () => {
  const g = fakeGoogle({ adsenseDomainRows: true });
  const m = memStore();
  const res = await run(g, m, ADSENSE_ENV, { ...CONSOLE_CONFIG, sites: { jp: { name: "政策の系譜", country: "日本" } } });
  assertEquals(res.sources["ga-jp"], { state: "unconfigured", message: "尚未設定 GA 資源編號" });
  assertEquals(g.gaCalls.length, 0);
});

Deno.test("Firestore 連 meta/status 都寫不進去：整個流程丟錯（對應 fetch.mjs 的非零結束）", async () => {
  const g = fakeGoogle({ adsenseDomainRows: true });
  await assertRejects(() => run(g, memStore("meta/status")), Error, "meta/status");
});

Deno.test("單日的 Firestore 寫入失敗：只算那天失敗，其他天照寫", async () => {
  const g = fakeGoogle({ adsenseDomainRows: true });
  const m = memStore("daily/tw_2026-10-01");
  const res = await run(g, m);
  assertEquals([...m.sets.keys()].filter((p) => p.startsWith("daily/tw_")).length, 29);
  assertEquals(res.sources["ga-tw"].state, "error");
  assertEquals(res.sources["ga-tw"].message, "部分日期失敗（1/30）：Firestore 寫入 daily/tw_2026-10-01 503");
  assertEquals(res.sources["ga-jp"].state, "ok");
});