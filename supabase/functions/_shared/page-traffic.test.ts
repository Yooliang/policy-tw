import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  buildTrafficRequest,
  fetchPageTraffic,
  GA_MAX_PAGES,
  GA_PAGE_LIMIT,
  GA_PATH_FILTER,
  PAGE_PATH_RE,
  parseTrafficRows,
  runPageTrafficSync,
  TRAFFIC_PROPERTY_ID,
  type TrafficRow,
  type TrafficStore,
} from "./page-traffic.ts";
import { CONSOLE_CONFIG, type Deps } from "./console-fetch.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const row = (path: string, users: string, views: string) => ({ dimensionValues: [{ value: path }], metricValues: [{ value: users }, { value: views }] });

Deno.test("台灣站的 GA 資源編號沿用 console-fetch 的站台設定（不另寫一份）", () => {
  assertEquals(TRAFFIC_PROPERTY_ID, "521879439");
  assertEquals(TRAFFIC_PROPERTY_ID, CONSOLE_CONFIG.sites.tw.propertyId);
});

Deno.test("路徑樣式：只收 /politician/<uuid> 與 /policy/<uuid>（可有一個尾斜線），其餘一律不收", () => {
  for (const ok of [`/politician/${A}`, `/politician/${A}/`, `/policy/${A}`, `/policy/${A.toUpperCase()}`]) assert(PAGE_PATH_RE.test(ok), ok);
  for (const bad of ["/", "/politician", "/politician/", "/politicians/3", `/politician/${A}/extra`, `/politician/${A}?x=1`, `/analysis/${A}`, `/policy/${A}x`, `/policy/not-a-uuid`, `/lineage/${A}`, `/election/2026/${A}`, `//politician/${A}`, ""]) {
    assert(!PAGE_PATH_RE.test(bad), bad);
  }
  // 丟給 GA 的樣式與本地樣式同一組 uuid 規則
  assert(new RegExp(`^${GA_PATH_FILTER}$`).test(`/politician/${A}`) && !new RegExp(`^${GA_PATH_FILTER}$`).test(`/politician/${A}/extra`));
});

Deno.test("解析：兩個網域路徑相同的列合併加總、大小寫與尾斜線視為同一頁、不符的略過、輸出排序穩定", () => {
  const out = parseTrafficRows([
    row(`/politician/${B}`, "3", "10"),
    row(`/politician/${A}`, "5", "20"), // 正見.tw
    row(`/politician/${A}`, "2", "4"), // web.app 同一路徑（GA 若分列就加總）
    row(`/politician/${A.toUpperCase()}/`, "1", "1"),
    row(`/policy/${A}`, "7", "9"),
    row("/", "999", "999"),
    row(`/politician/${A}/extra`, "999", "999"),
    row(`/analysis/${A}`, "999", "999"),
    { dimensionValues: [], metricValues: [] },
    { dimensionValues: [{ value: `/policy/${B}` }] }, // 缺指標：當 0
  ]);
  assertEquals(out, [
    { kind: "policy", target_id: A, users: 7, views: 9 },
    { kind: "policy", target_id: B, users: 0, views: 0 },
    { kind: "politician", target_id: A, users: 8, views: 25 },
    { kind: "politician", target_id: B, users: 3, views: 10 },
  ]);
});

Deno.test("解析：指標值不是數字、負數、小數都收斂成合法的非負整數；沒有列就是空陣列", () => {
  assertEquals(parseTrafficRows(undefined), []);
  assertEquals(parseTrafficRows([]), []);
  assertEquals(parseTrafficRows([row(`/policy/${A}`, "abc", "-4"), row(`/policy/${B}`, "2.6", "")]), [
    { kind: "policy", target_id: A, users: 0, views: 0 },
    { kind: "policy", target_id: B, users: 3, views: 0 },
  ]);
});

Deno.test("請求形狀：台灣時間近 N 天（含今天）、pagePath × (totalUsers, screenPageViews)、先在 GA 端濾路徑、N 是參數不是常數", () => {
  const now = Date.UTC(2026, 9, 8, 3, 0, 0); // UTC 03:00＝台灣 11:00，2026-10-08
  const r7 = buildTrafficRequest(now, 7);
  assertEquals(r7.dateRanges, [{ startDate: "2026-10-02", endDate: "2026-10-08" }]);
  assertEquals(r7.dimensions, [{ name: "pagePath" }]);
  assertEquals(r7.metrics, [{ name: "totalUsers" }, { name: "screenPageViews" }]);
  assertEquals(r7.dimensionFilter.filter.stringFilter, { matchType: "FULL_REGEXP", value: GA_PATH_FILTER });
  assertEquals(r7.limit, GA_PAGE_LIMIT);
  assertEquals(r7.offset, 0);
  assertEquals(buildTrafficRequest(now, 14, 10000).dateRanges, [{ startDate: "2026-09-25", endDate: "2026-10-08" }]);
  assertEquals(buildTrafficRequest(now, 1).dateRanges, [{ startDate: "2026-10-08", endDate: "2026-10-08" }]);
  assertEquals(buildTrafficRequest(now, 7, 10000).offset, 10000);
  // 台灣日界：UTC 17:00 已經是台灣隔天
  assertEquals(buildTrafficRequest(Date.UTC(2026, 9, 8, 17, 0, 0), 1).dateRanges, [{ startDate: "2026-10-09", endDate: "2026-10-09" }]);
});

// ---------- 假的網路 ----------
function fakeDeps(handler: (url: string, init: RequestInit) => { status: number; body: unknown }, log: string[] = []): { deps: Deps; calls: { url: string; body: any }[]; sleeps: number[] } {
  const calls: { url: string; body: any }[] = [];
  const sleeps: number[] = [];
  return {
    calls,
    sleeps,
    deps: {
      fetch: ((url: string, init: RequestInit) => {
        calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null });
        const r = handler(String(url), init);
        return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
      }) as typeof fetch,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0,
      now: () => Date.UTC(2026, 9, 8, 3, 0, 0),
      log: (...a) => log.push(a.map(String).join(" ")),
    },
  };
}

Deno.test("抓取：翻頁到不滿一頁為止；遇到 429 退避重試；一次只送一個請求；用 Bearer 權杖打 runReport", async () => {
  const full = Array.from({ length: GA_PAGE_LIMIT }, (_, i) => row(`/politician/${(i + 1).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`, "1", "1"));
  const tail = [row(`/policy/${A}`, "4", "6")];
  let n = 0;
  const f = fakeDeps(() => {
    n++;
    if (n === 1) return { status: 429, body: { error: { message: "Too many concurrent requests" } } };
    return { status: 200, body: { rows: n === 2 ? full : tail } };
  });
  const out = await fetchPageTraffic("521879439", "tok", f.deps.now(), 7, f.deps);
  assertEquals(out.length, GA_PAGE_LIMIT + 1);
  assertEquals(f.calls.length, 3, "429 一次、第一頁、第二頁");
  assert(f.calls.every((c) => c.url === "https://analyticsdata.googleapis.com/v1beta/properties/521879439:runReport"));
  assertEquals(f.calls.map((c) => c.body.offset), [0, 0, GA_PAGE_LIMIT]);
  assertEquals(f.sleeps.length, 1, "429 退避過一次");
  assert(f.sleeps[0] >= 5000, "429 的退避比一般錯誤久（沿用 console-fetch 的 backoffMs）");
});

Deno.test("抓取：翻頁有上限，不會無限翻", async () => {
  const full = Array.from({ length: GA_PAGE_LIMIT }, (_, i) => row(`/politician/${(i + 1).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`, "1", "1"));
  const f = fakeDeps(() => ({ status: 200, body: { rows: full } }));
  await fetchPageTraffic("521879439", "tok", f.deps.now(), 7, f.deps);
  assertEquals(f.calls.length, GA_MAX_PAGES);
});

Deno.test("抓取：非 429／5xx 的錯誤（例如 403 沒權限）直接丟出，不重試", async () => {
  const f = fakeDeps(() => ({ status: 403, body: { error: { message: "no access" } } }));
  await assertRejects(() => fetchPageTraffic("521879439", "tok", f.deps.now(), 7, f.deps), Error, "403");
  assertEquals(f.calls.length, 1);
});

// ---------- 一輪 ----------
function fakeStore(settings: { enabled: boolean; window_days: number } | Error, replaceResult: number | Error = 0) {
  const seen: { rows: TrafficRow[]; windowDays: number }[] = [];
  const store: TrafficStore = {
    readSettings: () => settings instanceof Error ? Promise.reject(settings) : Promise.resolve(settings),
    replace: (rows, windowDays) => {
      seen.push({ rows, windowDays });
      return replaceResult instanceof Error ? Promise.reject(replaceResult) : Promise.resolve(replaceResult);
    },
  };
  return { store, seen };
}

Deno.test("一輪：用設定表的天數抓、把同一個天數交給 RPC；沒有秘密外洩到訊息", async () => {
  const f = fakeDeps(() => ({ status: 200, body: { rows: [row(`/politician/${A}`, "6", "12"), row("/x", "1", "1")] } }));
  const s = fakeStore({ enabled: true, window_days: 14 }, 1);
  const res = await runPageTrafficSync({ getToken: () => Promise.resolve("SECRET-TOKEN"), store: s.store, deps: f.deps });
  assertEquals(res, { state: "ok", message: null, rows: 1 });
  assertEquals(s.seen, [{ rows: [{ kind: "politician", target_id: A, users: 6, views: 12 }], windowDays: 14 }]);
  assertEquals(f.calls[0].body.dateRanges, [{ startDate: "2026-09-25", endDate: "2026-10-08" }], "天數來自設定表");
  assert(!JSON.stringify(res).includes("SECRET-TOKEN"));
});

Deno.test("一輪：設定停用就不抓 GA、不寫入", async () => {
  const f = fakeDeps(() => ({ status: 200, body: { rows: [] } }));
  const s = fakeStore({ enabled: false, window_days: 7 });
  const res = await runPageTrafficSync({ getToken: () => Promise.resolve("t"), store: s.store, deps: f.deps });
  assertEquals(res.state, "skipped");
  assertEquals(f.calls.length, 0);
  assertEquals(s.seen.length, 0);
});

Deno.test("一輪：GA 抓失敗不呼叫 RPC（保留上一輪的數字，不把整張表清空）；讀設定失敗、RPC 失敗各自回 error 而不是丟出去", async () => {
  const bad = fakeDeps(() => ({ status: 403, body: { error: { message: "denied" } } }));
  const s1 = fakeStore({ enabled: true, window_days: 7 });
  const r1 = await runPageTrafficSync({ getToken: () => Promise.resolve("t"), store: s1.store, deps: bad.deps });
  assertEquals(r1.state, "error");
  assert(r1.message?.includes("GA 頁面流量抓取失敗"));
  assertEquals(s1.seen.length, 0);

  const tokenFail = await runPageTrafficSync({ getToken: () => Promise.reject(new Error("無法取得服務帳號權杖")), store: fakeStore({ enabled: true, window_days: 7 }).store, deps: bad.deps });
  assertEquals(tokenFail.state, "error");

  const s2 = fakeStore(new Error("relation does not exist"));
  const r2 = await runPageTrafficSync({ getToken: () => Promise.resolve("t"), store: s2.store, deps: bad.deps });
  assertEquals(r2.state, "error");
  assert(r2.message?.includes("traffic_boost_settings"));

  const ok = fakeDeps(() => ({ status: 200, body: { rows: [] } }));
  const s3 = fakeStore({ enabled: true, window_days: 7 }, new Error("時間窗不符"));
  const r3 = await runPageTrafficSync({ getToken: () => Promise.resolve("t"), store: s3.store, deps: ok.deps });
  assertEquals(r3.state, "error");
  assert(r3.message?.includes("replace_page_traffic"));
  assertEquals(s3.seen[0].rows, [], "GA 回空＝這一小時沒有任何頁有流量：照樣覆寫成空，舊的數字不留著");
});
