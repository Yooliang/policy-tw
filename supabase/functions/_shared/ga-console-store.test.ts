import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { CONSOLE_CONFIG, type Deps, runConsoleFetch, type Store } from "./console-fetch.ts";
import {
  buildSearchRequest,
  type GaDailyRow,
  type GaMirror,
  type GaSearchRow,
  type GaSummaryRow,
  parseSearchRows,
  RESULTS_COUNT_DIM,
  runGaSearchSync,
  SEARCH_TERM_DIM,
  makeTimeoutFetch,
  searchDimsFromMetadata,
  summaryRangeDates,
  teeStore,
  toDailyRow,
  toSummaryRows,
} from "./ga-console-store.ts";

// GA 數字另存 Supabase 私有表（policy-ops #148，migration 20261020010000_ga_console_store.sql）

// 2026-10-19 17:00 UTC＝台灣時間 2026-10-20 01:00（跨日）
const NOW_MS = Date.UTC(2026, 9, 19, 17, 0, 0);
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fakeDeps(fetchImpl: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const deps: Deps = {
    fetch: ((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(fetchImpl(String(url), init ?? {}));
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    now: () => NOW_MS,
    log: () => {},
  };
  return { deps, calls };
}

function memMirror(fail?: "daily" | "summary" | "search" | "all") {
  const daily: GaDailyRow[] = [];
  const summary: GaSummaryRow[] = [];
  const search: GaSearchRow[] = [];
  const boom = (t: string) => Promise.reject(new Error(`${t}：permission denied`));
  const mirror: GaMirror = {
    upsertDaily: (r) => (fail === "daily" || fail === "all" ? boom("ga_daily") : (daily.push(...r), Promise.resolve())),
    upsertSummary: (r) => (fail === "summary" || fail === "all" ? boom("ga_summary") : (summary.push(...r), Promise.resolve())),
    upsertSearch: (r) => (fail === "search" || fail === "all" ? boom("ga_search_terms") : (search.push(...r), Promise.resolve())),
  };
  return { mirror, daily, summary, search };
}

function memStore(fail = false) {
  const sets = new Map<string, Record<string, unknown>>();
  const merges: string[] = [];
  const store: Store = {
    set: (p, d) => (fail ? Promise.reject(new Error(`Firestore 寫入 ${p} 503`)) : (sets.set(p, d), Promise.resolve())),
    merge: (p) => (merges.push(p), Promise.resolve()),
  };
  return { store, sets, merges };
}

const DAY_DOC = {
  site: "tw",
  date: "2026-10-19",
  propertyId: "521879439",
  fetchedAt: "2026-10-19T17:00:00.000Z",
  total: {
    users: 100,
    sessions: 130,
    views: 400,
    avgEngagementSec: 12.5,
    sources: [{ key: "google / organic", sessions: 50, users: 40 }],
    landing: [{ key: "/", sessions: 20, users: 18 }],
    pages: [{ key: "/", views: 90, users: 60 }],
    pairs: [{ source: "google / organic", landing: "/", sessions: 10 }],
  },
  hosts: [{ host: "xn--2lw665d.tw", label: "正見.tw", users: 90 }],
};

// ---------- 轉列 ----------
Deno.test("toDailyRow：Firestore daily 文件 → ga_daily 列（欄位對應、還原互動總秒數）；別的路徑回 null", () => {
  const r = toDailyRow("daily/tw_2026-10-19", DAY_DOC)!;
  assertEquals(r.site, "tw");
  assertEquals(r.date, "2026-10-19");
  assertEquals(r.property_id, "521879439");
  assertEquals([r.users, r.sessions, r.views, r.avg_engagement_sec, r.engagement_sec], [100, 130, 400, 12.5, 1250]);
  assertEquals(r.sources, DAY_DOC.total.sources);
  assertEquals(r.landing, DAY_DOC.total.landing);
  assertEquals(r.pages, DAY_DOC.total.pages);
  assertEquals(r.pairs, DAY_DOC.total.pairs);
  assertEquals(r.hosts, DAY_DOC.hosts);
  assertEquals(toDailyRow("islandmade/x", DAY_DOC), null);
  assertEquals(toDailyRow("meta/status", DAY_DOC), null);
  assertEquals(toDailyRow("adsense/2026-10-19", DAY_DOC), null);
  assertEquals(toDailyRow("daily/islandmade_2026-10-19", {})?.site, "islandmade");
  // 缺欄位不炸：數字補 0、清單補 []
  const empty = toDailyRow("daily/jp_2026-10-01", {})!;
  assertEquals([empty.users, empty.views, empty.pages.length, empty.hosts.length], [0, 0, 0, 0]);
});

Deno.test("toSummaryRows：四個區間、日期用台灣時間（UTC 17:00 已經是隔天）", () => {
  const doc = {
    site: "tw",
    propertyId: "521879439",
    updatedAt: new Date(NOW_MS).toISOString(),
    today: { users: 1, sessions: 2, views: 3, avgEngagementSec: 4 },
    yesterday: { users: 5, sessions: 6, views: 7, avgEngagementSec: 8 },
    last7: { users: 9, sessions: 10, views: 11, avgEngagementSec: 12 },
    last30: { users: 13, sessions: 14, views: 15, avgEngagementSec: 16 },
  };
  const rows = toSummaryRows("summary/tw", doc)!;
  assertEquals(rows.map((r) => r.range), ["today", "yesterday", "last7", "last30"]);
  assertEquals(rows.map((r) => [r.start_date, r.end_date]), [
    ["2026-10-20", "2026-10-20"],
    ["2026-10-19", "2026-10-19"],
    ["2026-10-14", "2026-10-20"],
    ["2026-09-21", "2026-10-20"],
  ]);
  assertEquals(rows[2].users, 9);
  assertEquals(rows[2].views, 11);
  assertEquals(toSummaryRows("daily/tw_2026-10-19", doc), null);
  assertEquals(summaryRangeDates(NOW_MS).today.start, "2026-10-20");
});

// ---------- teeStore 守門 ----------
Deno.test("teeStore 守門：Supabase 寫入失敗不擋 Firestore、flush 不丟錯，只記進結果", async () => {
  const fs = memStore();
  const mm = memMirror("all");
  const tee = teeStore(fs.store, mm.mirror);
  await tee.store.set("daily/tw_2026-10-19", DAY_DOC);
  await tee.store.set("summary/tw", { propertyId: "1", updatedAt: new Date(NOW_MS).toISOString() });
  assert(fs.sets.has("daily/tw_2026-10-19") && fs.sets.has("summary/tw"), "Firestore 照寫");
  const r = await tee.flush();
  assertEquals(r.state, "error");
  assertEquals(r.failed, 5, "1 列 daily＋4 列 summary");
  assert(r.message?.includes("permission denied"));
});

Deno.test("teeStore 守門：寫 Firestore 時不打 Supabase（只收列），flush 才整批寫、daily 與 summary 各一次", async () => {
  const fs = memStore();
  let calls = 0;
  const seen: number[] = [];
  const mirror: GaMirror = {
    upsertDaily: (r) => (calls++, seen.push(r.length), Promise.resolve()),
    upsertSummary: (r) => (calls++, seen.push(r.length), Promise.resolve()),
    upsertSearch: () => Promise.resolve(),
  };
  const tee = teeStore(fs.store, mirror);
  await tee.store.set("daily/tw_2026-10-19", DAY_DOC);
  await tee.store.set("daily/tw_2026-10-18", DAY_DOC);
  await tee.store.set("daily/tw_2026-10-18", DAY_DOC); // 同一天寫兩次只留一列
  await tee.store.set("summary/tw", { propertyId: "1", updatedAt: new Date(NOW_MS).toISOString() });
  assertEquals(calls, 0, "主流程中不打 Supabase");
  const r = await tee.flush();
  assertEquals(calls, 2);
  assertEquals(seen, [2, 4]);
  assertEquals(r, { state: "ok", message: null, daily: 2, summary: 4, failed: 0 });
});

Deno.test("teeStore 守門：Firestore 失敗照舊丟錯（主流程語意不變），但那一天的列已經收下、flush 會寫進 Supabase", async () => {
  const fs = memStore(true);
  const mm = memMirror();
  const tee = teeStore(fs.store, mm.mirror);
  await assertRejects(() => tee.store.set("daily/tw_2026-10-19", DAY_DOC), Error, "Firestore");
  assertEquals((await tee.flush()).state, "ok");
  assertEquals(mm.daily.length, 1);
});

Deno.test("teeStore：只另存 daily／summary；meta/status 的 merge 與其他路徑原樣交給 Firestore；沒有 service role 記失敗", async () => {
  const fs = memStore();
  const mm = memMirror();
  const tee = teeStore(fs.store, mm.mirror);
  await tee.store.merge("meta/status", { updatedAt: "T" });
  await tee.store.set("other/x", { a: 1 });
  assertEquals(fs.merges, ["meta/status"]);
  assert(fs.sets.has("other/x"));
  assertEquals((await tee.flush()).daily, 0);
  assertEquals([mm.daily.length, mm.summary.length], [0, 0]);
  const none = teeStore(fs.store, null);
  await none.store.set("daily/tw_2026-10-19", DAY_DOC);
  assertEquals((await none.flush()).state, "error", "沒有 service role 要記失敗，不是靜默成功");
});

Deno.test("makeTimeoutFetch：沒帶 signal 的請求自動加上逾時；有帶就用原本的", async () => {
  const seen: (AbortSignal | null | undefined)[] = [];
  const base = ((_u: unknown, i?: RequestInit) => (seen.push(i?.signal), Promise.resolve(new Response("{}")))) as typeof fetch;
  const f = makeTimeoutFetch(1000, base);
  await f("https://x/rest/v1/ga_daily", { method: "POST" });
  const own = new AbortController().signal;
  await f("https://x", { signal: own });
  assert(seen[0] instanceof AbortSignal, "要加逾時 signal");
  assertEquals(seen[1], own);
});

// ---------- 整條流程：GA 另存與 Firestore 並存 ----------
function fakeGa() {
  return fakeDeps((url, init) => {
    const u = new URL(url);
    if (u.host !== "analyticsdata.googleapis.com") return new Response("unexpected", { status: 599 });
    const requests = JSON.parse(String(init.body)).requests as { dateRanges: unknown[]; dimensions?: { name: string }[] }[];
    const mv = (...v: string[]) => v.map((value) => ({ value }));
    const isSummary = requests[0].dateRanges.length === 4;
    return jsonRes({
      reports: requests.map((r) => {
        if (isSummary) return { rows: ["today", "yesterday", "last7", "last30"].map((name) => ({ dimensionValues: mv(name), metricValues: mv("4", "5", "6", "40") })) };
        if (!r.dimensions) return { rows: [{ metricValues: mv("10", "12", "30", "100") }] };
        if (r.dimensions[0].name === "hostName") return { rows: [] };
        return { rows: [{ dimensionValues: r.dimensions.map((d) => ({ value: `${d.name}-v` })), metricValues: mv("7", "5") }] };
      }),
    });
  });
}

Deno.test("整條流程守門：runConsoleFetch 包上 teeStore，Supabase 全部失敗時 success 仍是 true、Firestore 照寫", async () => {
  const g = fakeGa();
  const fs = memStore();
  const mm = memMirror("all");
  const tee = teeStore(fs.store, mm.mirror);
  const res = await runConsoleFetch({ config: CONSOLE_CONFIG, env: { GCP_SA_KEY: "x" }, deps: g.deps, store: tee.store, getToken: () => Promise.resolve("t") });
  assertEquals(res.success, true);
  assert(Object.values(res.sources).every((s) => s.state === "ok"), "GA 來源不受另存失敗影響");
  assertEquals([...fs.sets.keys()].filter((p) => p.startsWith("daily/")).length, 90);
  assertEquals((await tee.flush()).state, "error");
});

Deno.test("整條流程：Supabase 正常時三站各 30 天＋各 4 個區間都另存，數字與 Firestore 同一份", async () => {
  const g = fakeGa();
  const fs = memStore();
  const mm = memMirror();
  const tee = teeStore(fs.store, mm.mirror);
  await runConsoleFetch({ config: CONSOLE_CONFIG, env: { GCP_SA_KEY: "x" }, deps: g.deps, store: tee.store, getToken: () => Promise.resolve("t") });
  const r = await tee.flush();
  assertEquals(mm.daily.filter((x) => x.site === "tw").length, 30);
  assertEquals(mm.daily.length, 90);
  assertEquals(mm.summary.length, 12);
  const d = mm.daily.find((x) => x.site === "tw" && x.date === "2026-10-20")!;
  assertEquals([d.users, d.sessions, d.views], [10, 12, 30]);
  assertEquals(d.pages, [{ key: "pagePath-v", views: 7, users: 5 }]);
  assertEquals(r, { state: "ok", message: null, daily: 90, summary: 12, failed: 0 });
});

// ---------- 站內搜尋詞 ----------
const META_BOTH = { dimensions: [{ apiName: "date" }, { apiName: SEARCH_TERM_DIM }, { apiName: RESULTS_COUNT_DIM }] };

Deno.test("searchDimsFromMetadata：認得兩個自訂維度", () => {
  assertEquals(searchDimsFromMetadata(META_BOTH), { term: true, results: true });
  assertEquals(searchDimsFromMetadata({ dimensions: [{ apiName: SEARCH_TERM_DIM }] }), { term: true, results: false });
  assertEquals(searchDimsFromMetadata(null), { term: false, results: false });
});

Deno.test("站內搜尋詞守門：GA 沒登記 search_term 自訂維度 → unconfigured，不打報表、不寫表、不丟錯", async () => {
  const g = fakeDeps((url) => (url.endsWith("/metadata") ? jsonRes({ dimensions: [{ apiName: "date" }] }) : jsonRes({ rows: [] })));
  const mm = memMirror();
  const r = await runGaSearchSync({ site: "tw", propertyId: "521879439", getToken: () => Promise.resolve("t"), mirror: mm.mirror, deps: g.deps });
  assertEquals(r.state, "unconfigured");
  assert(r.message?.includes(SEARCH_TERM_DIM));
  assertEquals(g.calls.length, 1, "只查 metadata，不打 runReport");
  assertEquals(mm.search.length, 0);
});

Deno.test("站內搜尋詞守門：GA 或寫入失敗都回 error、不丟出去", async () => {
  const bad = fakeDeps(() => jsonRes({ error: { message: "forbidden" } }, 403));
  const r1 = await runGaSearchSync({ site: "tw", propertyId: "1", getToken: () => Promise.resolve("t"), mirror: memMirror().mirror, deps: bad.deps });
  assertEquals(r1.state, "error");
  assert(r1.message?.startsWith("GA metadata 失敗"), "metadata 失敗要在原地轉成 error（訊息說明是哪一步）");
  const reportFail = fakeDeps((url) => (url.endsWith("/metadata") ? jsonRes(META_BOTH) : jsonRes({ error: { message: "bad" } }, 400)));
  const r2 = await runGaSearchSync({ site: "tw", propertyId: "1", getToken: () => Promise.resolve("t"), mirror: memMirror().mirror, deps: reportFail.deps });
  assertEquals(r2.state, "error");
  const ok = fakeDeps((url) => (url.endsWith("/metadata") ? jsonRes(META_BOTH) : jsonRes({ rows: [{ dimensionValues: [{ value: "20261019" }, { value: "侯友宜" }, { value: "3" }], metricValues: [{ value: "2" }, { value: "1" }] }] })));
  const r3 = await runGaSearchSync({ site: "tw", propertyId: "1", getToken: () => Promise.resolve("t"), mirror: memMirror("search").mirror, deps: ok.deps });
  assertEquals(r3.state, "error");
  const r4 = await runGaSearchSync({ site: "tw", propertyId: "1", getToken: () => Promise.reject(new Error("token")), mirror: memMirror().mirror, deps: ok.deps });
  assertEquals(r4.state, "error");
  const r5 = await runGaSearchSync({ site: "tw", propertyId: "1", getToken: () => Promise.resolve("t"), mirror: null, deps: ok.deps });
  assertEquals(r5.state, "error");
});

Deno.test("站內搜尋詞：有登記就抓近 30 天 search 事件（台灣時間）、date×詞×結果數，寫進 ga_search_terms", async () => {
  const mv = (...v: string[]) => v.map((value) => ({ value }));
  const g = fakeDeps((url) =>
    url.endsWith("/metadata") ? jsonRes(META_BOTH) : jsonRes({
      rows: [
        { dimensionValues: mv("20261019", "侯友宜", "3"), metricValues: mv("5", "4") },
        { dimensionValues: mv("20261019", "沒這個人", "0"), metricValues: mv("2", "2") },
        { dimensionValues: mv("20261018", "(not set)", "0"), metricValues: mv("9", "9") },
      ],
    })
  );
  const mm = memMirror();
  const r = await runGaSearchSync({ site: "tw", propertyId: "521879439", getToken: () => Promise.resolve("t"), mirror: mm.mirror, deps: g.deps });
  assertEquals(r.state, "ok");
  assertEquals(r.rows, 2);
  const req = JSON.parse(String(g.calls[1].init.body));
  assertEquals(g.calls[1].url, "https://analyticsdata.googleapis.com/v1beta/properties/521879439:runReport");
  assertEquals(req.dateRanges, [{ startDate: "2026-09-21", endDate: "2026-10-20" }]);
  assertEquals(req.dimensionFilter.filter, { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: "search" } });
  assertEquals(req.dimensions.map((d: { name: string }) => d.name), ["date", SEARCH_TERM_DIM, RESULTS_COUNT_DIM]);
  assertEquals(mm.search.map((s) => [s.date, s.term, s.results_count, s.event_count, s.users]), [
    ["2026-10-19", "侯友宜", "3", 5, 4],
    ["2026-10-19", "沒這個人", "0", 2, 2],
  ]);
});

Deno.test("站內搜尋詞守門：過了 deadline 不開始（skipped，不打 GA）；mirror 同步丟錯也不往外丟", async () => {
  const g = fakeDeps(() => jsonRes(META_BOTH));
  const r = await runGaSearchSync({ site: "tw", propertyId: "1", getToken: () => Promise.resolve("t"), mirror: memMirror().mirror, deps: g.deps, deadlineMs: NOW_MS - 1 });
  assertEquals(r.state, "skipped");
  assertEquals(g.calls.length, 0);
  const ok = fakeDeps((url) => (url.endsWith("/metadata") ? jsonRes(META_BOTH) : jsonRes({ rows: [{ dimensionValues: [{ value: "20261019" }, { value: "x" }, { value: "1" }], metricValues: [{ value: "1" }, { value: "1" }] }] })));
  const throwing: GaMirror = { upsertDaily: () => Promise.resolve(), upsertSummary: () => Promise.resolve(), upsertSearch: () => { throw new Error("sync boom"); } };
  const r2 = await runGaSearchSync({ site: "tw", propertyId: "1", getToken: () => Promise.resolve("t"), mirror: throwing, deps: ok.deps });
  assertEquals(r2.state, "error");
  const badGetToken = (() => { throw new Error("sync token"); }) as unknown as () => Promise<string>;
  const r3 = await runGaSearchSync({ site: "tw", propertyId: "1", getToken: badGetToken, mirror: memMirror().mirror, deps: ok.deps });
  assertEquals(r3.state, "error");
  // 不在任何一步 try 裡的意外（例如時鐘丟錯）也要由外層轉成 error
  const brokenClock = { ...ok.deps, now: () => { throw new Error("clock"); } };
  const r4 = await runGaSearchSync({ site: "tw", propertyId: "1", getToken: () => Promise.resolve("t"), mirror: memMirror().mirror, deps: brokenClock, deadlineMs: 1 });
  assertEquals(r4.state, "error");
  assert(r4.message?.includes("意外失敗"));
});

Deno.test("站內搜尋詞：翻滿頁數上限要標 truncated；(other) 不當成搜尋詞", async () => {
  const full = Array.from({ length: 10000 }, (_, i) => ({ dimensionValues: [{ value: "20261019" }, { value: `t${i}` }, { value: "1" }], metricValues: [{ value: "1" }, { value: "1" }] }));
  const g = fakeDeps((url) => (url.endsWith("/metadata") ? jsonRes(META_BOTH) : jsonRes({ rows: full, rowCount: 60000 })));
  const mm = memMirror();
  const r = await runGaSearchSync({ site: "tw", propertyId: "1", getToken: () => Promise.resolve("t"), mirror: mm.mirror, deps: g.deps });
  assertEquals(r.state, "ok");
  assertEquals(r.truncated, true);
  assertEquals(g.calls.length, 1 + 5, "metadata＋5 頁");
  assert(r.message?.includes("報表共 60000 列"));
  // 剛好 5 萬列（rowCount 等於拿到的）不算截斷
  const exact = fakeDeps((url) => (url.endsWith("/metadata") ? jsonRes(META_BOTH) : jsonRes({ rows: full, rowCount: 50000 })));
  const r2 = await runGaSearchSync({ site: "tw", propertyId: "1", getToken: () => Promise.resolve("t"), mirror: memMirror().mirror, deps: exact.deps });
  assertEquals(r2.truncated, false);
  assertEquals(r2.message, null);
  // metadata 之後才過 deadline：不打 runReport、回 skipped
  let t = NOW_MS;
  const late = fakeDeps((url) => (url.endsWith("/metadata") ? (t = NOW_MS + 10, jsonRes(META_BOTH)) : jsonRes({ rows: full })));
  late.deps.now = () => t;
  const r3 = await runGaSearchSync({ site: "tw", propertyId: "1", getToken: () => Promise.resolve("t"), mirror: memMirror().mirror, deps: late.deps, deadlineMs: NOW_MS + 5 });
  assertEquals(r3.state, "skipped");
  assertEquals(late.calls.length, 1, "只打了 metadata");
  const rows = parseSearchRows([{ dimensionValues: [{ value: "20261019" }, { value: "(other)" }, { value: "1" }], metricValues: [{ value: "9" }, { value: "9" }] }], "tw", true, "T");
  assertEquals(rows, []);
});

Deno.test("站內搜尋詞：只有 search_term 沒有 results_count 時不帶那個維度、results_count 留空", () => {
  const req = buildSearchRequest(NOW_MS, 30, false);
  assertEquals(req.dimensions.map((d) => d.name), ["date", SEARCH_TERM_DIM]);
  const rows = parseSearchRows([{ dimensionValues: [{ value: "20261019" }, { value: " 蔣萬安 " }], metricValues: [{ value: "1" }, { value: "1" }] }, { dimensionValues: [{ value: "20261019" }, { value: "蔣萬安" }], metricValues: [{ value: "2" }, { value: "1" }] }], "tw", false, "T");
  assertEquals(rows.map((r) => [r.term, r.results_count, r.event_count, r.users]), [["蔣萬安", "", 3, 2]]);
});

// ---------- migration 守門：三張表私有 ----------
const MIG = await Deno.readTextFile(new URL("../../migrations/20261020010000_ga_console_store.sql", import.meta.url));
const MIG_BODY = MIG.replace(/--.*$/gm, "");
const TABLES = ["ga_daily", "ga_summary", "ga_search_terms"];

Deno.test("migration 守門：三張表都開 RLS、收回 PUBLIC／anon／authenticated 全部權限、沒有任何 policy、不授權給 anon／authenticated", () => {
  for (const t of TABLES) {
    assert(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t} \\(`).test(MIG_BODY), `要建 ${t}`);
    assert(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY;`).test(MIG_BODY), `${t} 要開 RLS`);
    assert(new RegExp(`REVOKE ALL ON TABLE public\\.${t}\\s+FROM PUBLIC, anon, authenticated;`).test(MIG_BODY), `${t} 要收回 PUBLIC／anon／authenticated`);
    assert(MIG_BODY.search(new RegExp(`REVOKE ALL ON TABLE public\\.${t}\\b`)) > MIG_BODY.search(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t}\\b`)), `${t} 先建再收回`);
  }
  assertEquals(/CREATE POLICY/i.test(MIG_BODY), false, "不得建 policy（私有表只有 service_role）");
  for (const g of MIG_BODY.match(/GRANT [^;]*;/gi) ?? []) {
    assert(!/\b(anon|authenticated|PUBLIC)\b/i.test(g.replace(/^GRANT [A-Z, ]+ ON TABLE public\.\w+/i, "")), `只能授權給 service_role：${g}`);
    assert(/TO service_role;$/.test(g.trim()), `只能授權給 service_role：${g}`);
  }
  assertEquals(/SECURITY DEFINER/i.test(MIG_BODY), false, "這支不建繞過權限的函式");
});

Deno.test("migration：主鍵與 upsert 的 onConflict 一致（site,date／site,range／site,date,term,results_count）", async () => {
  assert(/ga_daily \([\s\S]*?PRIMARY KEY \(site, date\)/.test(MIG_BODY));
  assert(/ga_summary \([\s\S]*?PRIMARY KEY \(site, range\)/.test(MIG_BODY));
  assert(/ga_search_terms \([\s\S]*?PRIMARY KEY \(site, date, term, results_count\)/.test(MIG_BODY));
  const src = await Deno.readTextFile(new URL("./ga-console-store.ts", import.meta.url));
  assert(src.includes('up("ga_daily", rows, "site,date")'));
  assert(src.includes('up("ga_summary", rows, "site,range")'));
  assert(src.includes('"site,date,term,results_count"'));
});

// ---------- 接線守門 ----------
const IDX = await Deno.readTextFile(new URL("../console-fetch/index.ts", import.meta.url));

Deno.test("接線守門：index.ts 用 teeStore 包住 Firestore 交給 runConsoleFetch，搜尋詞在驗證之後才跑，兩者都不影響 success", () => {
  assert(IDX.includes('from "../_shared/ga-console-store.ts"'), "要 import ga-console-store（affected-functions 才會在改 _shared 時重部）");
  assert(/teeStore\(makeFirestoreStore\(getToken, realDeps\), gaMirror\)/.test(IDX), "Firestore store 要包上 teeStore");
  assert(/const store = tee\.store;/.test(IDX));
  assert(/runConsoleFetch\(\{[^}]*\bstore\b/.test(IDX), "runConsoleFetch 收到的是包過的 store");
  const reject = IDX.indexOf("if (!check.ok) return json(");
  for (const later of ["teeStore(", "runGaSearchSync(", "makeSupabaseGaMirror("]) assert(IDX.indexOf(later) > reject, `${later} 要在驗證之後`);
  assert(/const ga_store = await tee\.flush\(\);/.test(IDX), "主流程跑完要 flush");
  assert(IDX.indexOf("tee.flush()") > IDX.indexOf("runConsoleFetch({"), "flush 在 runConsoleFetch 之後");
  assert(/createClient\(supabaseUrl, serviceRoleKey, \{ global: \{ fetch: makeTimeoutFetch\(\) \} \}\)/.test(IDX), "另存用的連線要帶逾時 fetch");
  assert(/deadlineMs: started \+ SEARCH_DEADLINE_MS/.test(IDX), "搜尋詞要帶 deadline");
  assert(/result\.success \? 200 : 500/.test(IDX), "狀態碼仍只看 GA／Firestore 的結果");
  assert(!/success:[^,\n]*(ga_store|search)\./.test(IDX), "success 不看 ga_store／search");
});
