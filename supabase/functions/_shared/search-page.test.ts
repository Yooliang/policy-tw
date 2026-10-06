/**
 * 搜尋結果頁不是出處、也不算查過的網址（2026-10-06，小良哥點頭）。
 *
 * 起因：a-zhen 交「查無異動」說台南安南區四草里 2022 里長吳文振查無政見，checked_urls 六個全是
 * google.com/search?q=…；中選會選舉公報 eebulletin.cec.gov.tw/111/06臺南市/05村里長/36安南/四草里.pdf
 * 就列了他四條政見。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { isSearchResultPage, searchPageVerdict } from "./search-page.ts";
import { searchPageProblems, stripSearchPages } from "./search-page-guard.ts";
import { notFoundSearchShortfall, notFoundSearchMessage } from "./not-found-guard.ts";
import { handleContribute } from "./contribute-handler.ts";

const SEARCH = [
  // 搜尋引擎
  "https://www.google.com/search?q=%E5%90%B3%E6%96%87%E6%8C%AF+%E6%94%BF%E8%A6%8B",
  "https://www.google.com.tw/search?q=吳文振 四草里 政見",
  "https://google.co.jp/search?q=x",
  "https://www.google.com/webhp?q=x#q=x",
  "https://www.google.com/?q=吳文振",
  "https://www.google.com/#q=吳文振",
  "https://news.google.com/search?q=吳文振&hl=zh-TW",
  "https://scholar.google.com/scholar?q=x",
  "https://cse.google.com/cse?cx=123&q=x",
  "https://www.bing.com/search?q=吳文振+政見",
  "https://cn.bing.com/news/search?q=x",
  "https://duckduckgo.com/?q=吳文振",
  "https://html.duckduckgo.com/html/?q=x",
  "https://tw.search.yahoo.com/search?p=吳文振",
  "https://search.yahoo.co.jp/search?p=x",
  "https://www.baidu.com/s?wd=吳文振",
  "https://m.baidu.com/s?word=x",
  "https://search.naver.com/search.naver?query=x",
  "https://yandex.ru/search/?text=x",
  "https://www.sogou.com/web?query=x",
  "https://www.so.com/s?q=x",
  "https://www.ecosia.org/search?q=x",
  "https://search.brave.com/search?q=x",
  "https://www.startpage.com/sp/search?query=x",
  "https://www.youtube.com/results?search_query=吳文振",
  "https://www.perplexity.ai/search/abc-123",
  // 搜尋語法（任何網域）
  "https://example.com/find?q=site:cec.gov.tw+吳文振",
  "https://www.google.com.tw/url?q=site%3Afacebook.com+%E5%90%B3",
  // 站內搜尋
  "https://search.ltn.com.tw/list?keyword=吳文振",
  "https://udn.com/search/word/2/吳文振",
  "https://www.cna.com.tw/search/hysearchws.aspx?q=吳文振",
  "https://www.ettoday.net/news_search/doSearch.php?keywords=吳文振",
  "https://www.facebook.com/search/top?q=吳文振",
  "https://x.com/search?q=吳文振",
  "https://zh.wikipedia.org/w/index.php?search=吳文振",
  "https://zh.wikipedia.org/wiki/Special:Search?search=x",
  "https://www.tncc.gov.tw/SearchResult.aspx?keyword=吳文振",
  "https://www.tainan.gov.tw/Search.aspx?q=x",
  "https://gsearch.tainan.gov.tw/kmportal/front/search?q=x",
  "https://www.tainan.gov.tw/News.aspx?n=13370&sms=9748&keyword=吳文振",
  // web.archive.org 的存檔照原網址算
  "https://web.archive.org/web/20221101000000/https://www.google.com/search?q=x",
];

const NOT_SEARCH = [
  "https://eebulletin.cec.gov.tw/111/06臺南市/05村里長/36安南/四草里.pdf",
  "https://eebulletin.cec.gov.tw/?dir=111",
  "https://bulletin.cec.gov.tw/?dir=01選舉公報",
  "https://db.cec.gov.tw/ElecTable/Election/ElecTickets?dataType=tickets&typeId=ELC&subjectId=V1",
  "https://www.google.com/maps/search/台南市安南區四草里",
  "https://www.google.com/maps/place/四草里",
  "https://maps.google.com/?q=四草里",
  "https://docs.google.com/document/d/abc/edit",
  "https://drive.google.com/file/d/abc/view",
  "https://books.google.com/books?id=abc",
  "https://www.google.com/url?q=https://news.ltn.com.tw/news/1",
  "https://www.google.com/",
  "https://www.youtube.com/watch?v=abc",
  "https://tw.news.yahoo.com/吳文振-123.html",
  "https://news.ltn.com.tw/news/politics/breakingnews/4000000",
  "https://www.cna.com.tw/news/aipl/202210010001.aspx",
  "https://udn.com/news/story/6656/6700000",
  "https://www.facebook.com/wuwenzhen",
  "https://www.tainan.gov.tw/News_Content.aspx?n=13370&s=8000000",
  "https://www.tncc.gov.tw/cp.aspx?n=123",
  "https://zh.wikipedia.org/wiki/吳文振",
  "https://example.org/research/2022/report",
  "https://example.org/searchlight-news",
  "https://whoareyou.readr.tw/politics/123",
  "https://www.ly.gov.tw/Pages/List.aspx?nodeid=109",
];

Deno.test("搜尋結果頁：搜尋引擎、搜尋語法、站內搜尋都認得", () => {
  for (const u of SEARCH) assert(isSearchResultPage(u), `應該認成搜尋結果頁：${u}`);
});

Deno.test("不是搜尋結果頁：地圖、文件、公報、新聞、政府公告、文章網址裡只含有 search 字樣的", () => {
  for (const u of NOT_SEARCH) assertEquals(searchPageVerdict(u), null, `不該擋：${u}`);
});

Deno.test("判斷的類別與說明", () => {
  assertEquals(searchPageVerdict(SEARCH[0])?.kind, "search_engine");
  assertEquals(searchPageVerdict(SEARCH[0])?.label, "Google 搜尋結果頁");
  assertEquals(searchPageVerdict("https://example.com/find?q=site:cec.gov.tw")?.kind, "search_operator");
  assertEquals(searchPageVerdict("https://search.ltn.com.tw/list?keyword=x")?.kind, "site_search");
  assertEquals(searchPageVerdict("not a url"), null);
  assertEquals(searchPageVerdict(""), null);
  assertEquals(searchPageVerdict(undefined), null);
});

// ---- 交件守門（純函式） ----

const G = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
const BULLETIN = "https://eebulletin.cec.gov.tw/111/06臺南市/05村里長/36安南/四草里.pdf";

Deno.test("守門：source_urls 全是搜尋結果頁 → 擋；有一個實際頁面就過", () => {
  const all = searchPageProblems([{ contribution_type: "policy", payload: {}, source_urls: [G("a"), G("b")] }]);
  assertEquals(all.length, 1);
  assertEquals(all[0].path, "source_urls");
  assertEquals(all[0].remaining, 0);
  assertStringIncludes(all[0].message, "搜尋結果頁不是出處，請附實際打開的頁面");
  assertEquals(searchPageProblems([{ contribution_type: "policy", payload: {}, source_urls: [G("a"), BULLETIN] }]).length, 0);
  assertEquals(searchPageProblems([{ contribution_type: "policy", payload: {}, source_urls: [BULLETIN] }]).length, 0);
});

Deno.test("守門：吳文振那筆——no_change 的 checked_urls 六個全是 google 搜尋 → 擋", () => {
  const checked = ["吳文振 政見", "吳文振 四草里", "吳文振 里長 2022", "吳文振 臉書", "四草里 里長 政見", "吳文振 選舉公報"].map(G);
  const problems = searchPageProblems([{ contribution_type: "no_change", payload: { checked_urls: checked, outcome: "not_found" }, source_urls: checked }]);
  assertEquals(problems.length, 1, "source_urls 與 checked_urls 是同一個陣列時只報一次");
  assertEquals(problems[0].search_urls.length, 6);
});

Deno.test("守門：單一出處欄是搜尋結果頁 → 擋（三要素、脈絡角色、交接、correction 換 source_url）", () => {
  const items = [
    { contribution_type: "policy_elements", payload: { elements: [{ element: "target", source_url: G("x") }, { element: "deadline", source_url: BULLETIN }] }, source_urls: [BULLETIN] },
    { contribution_type: "lineage_participants", payload: { participants: [{ source_url: "https://search.ltn.com.tw/list?keyword=x" }] }, source_urls: [BULLETIN] },
    { contribution_type: "lineage_handover", payload: { source_url: G("y") }, source_urls: [BULLETIN] },
    { contribution_type: "correction", payload: { target_table: "policies", target_id: "x", changes: [{ field: "title", correct_value: "a" }, { field: "source_url", correct_value: G("z") }] }, source_urls: [BULLETIN] },
    { contribution_type: "correction", payload: { target_table: "policies", target_id: "x", field: "source_url", correct_value: BULLETIN }, source_urls: [BULLETIN] },
  ];
  const paths = searchPageProblems(items).map((p) => `${p.index}:${p.path}`);
  assertEquals(paths, ["0:payload.elements[0].source_url", "1:payload.participants[0].source_url", "2:payload.source_url", "3:payload.changes[1].correct_value"]);
});

Deno.test("通過後把搜尋結果頁從 source_urls 與 checked_urls 拿掉，回報拿掉了哪些", () => {
  const checked = [G("a"), BULLETIN, "https://news.ltn.com.tw/news/1"];
  const items = [
    { contribution_type: "no_change", payload: { checked_urls: checked } as Record<string, unknown>, source_urls: checked },
    { contribution_type: "policy", payload: {}, source_urls: [BULLETIN] },
  ];
  const removed = stripSearchPages(items);
  assertEquals(items[0].source_urls, [BULLETIN, "https://news.ltn.com.tw/news/1"]);
  assertEquals(items[0].payload.checked_urls, [BULLETIN, "https://news.ltn.com.tw/news/1"]);
  assertEquals(removed.get(0), [G("a")]);
  assertEquals(removed.has(1), false);
});

// ---- 查無守門：搜尋結果頁不計入 5 個網址 ----

const PID = "98b8b1ff-d085-4597-8384-a02461f773f6";
const pages = (n: number) => Array.from({ length: n }, (_, i) => `https://site${i}.tw/news/${i}`);

Deno.test("查無守門：4 個實際頁面＋3 個搜尋結果頁 → 只算 4 個，擋，訊息講搜尋結果頁不計入", () => {
  const s = notFoundSearchShortfall(`auto:term_policy_missing:${PID}:2022`, { outcome: "not_found", checked_urls: [...pages(4), G("a"), G("b"), G("c")] });
  assert(s !== null);
  assertEquals(s.checked, 4);
  assertEquals(s.search_pages, 3);
  const msg = notFoundSearchMessage(s);
  assertStringIncludes(msg, "搜尋結果頁不是出處，請附實際打開的頁面");
  assert(!msg.includes("至少要有一個搜尋結果頁"), "舊說法（至少一個搜尋結果頁）要拿掉");
  assertEquals(notFoundSearchShortfall(`auto:term_policy_missing:${PID}:2022`, { outcome: "not_found", checked_urls: [...pages(5), G("a")] }), null, "5 個實際頁面就夠");
});

// ---- 交件端整合 ----

function fakeSupabase() {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  let nextId = 1;
  const client = {
    // deno-lint-ignore no-explicit-any
    from(table: string): any {
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain, eq: () => chain, in: () => chain, gte: () => chain, order: () => chain, limit: () => chain, neq: () => chain, is: () => chain, or: () => chain, not: () => chain, ilike: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        insert: (row: Record<string, unknown> | Record<string, unknown>[]) => {
          const rows = (Array.isArray(row) ? row : [row]).map((r) => ({ id: `row-${nextId++}`, ...r }));
          for (const r of rows) inserted.push({ table, row: r });
          const selectResult = {
            then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res),
            maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
          };
          return { error: null, select: () => selectResult };
        },
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        delete: () => ({ in: () => Promise.resolve({ error: null }) }),
        then: (res: (v: { data: unknown; error: null; count: number }) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(res),
      };
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  return { client, inserted };
}

Deno.test("交件：吳文振那筆（村里長任務的查無，checked_urls 全是 google 搜尋）→ 400 search_page_not_source，記 gate_rejections，不建 contributions", async () => {
  const { client, inserted } = fakeSupabase();
  const checked = ["吳文振 政見", "吳文振 四草里", "吳文振 里長 2022", "吳文振 臉書", "四草里 里長 政見", "吳文振 選舉公報"].map(G);
  const res = await handleContribute(client, "https://x", {
    agent_name: "a-zhen",
    contribution_type: "no_change",
    payload: { task_id: `auto:roster_check:${PID}`, outcome: "not_found", checked_urls: checked, finding: "搜了六組關鍵字，都沒有吳文振 2022 里長的政見。" },
  }, "ip-1");
  assertEquals(res.status, 400);
  const b = res.body as Record<string, unknown>;
  assertEquals(b.error, "search_page_not_source");
  assertStringIncludes(String(b.message), "搜尋結果頁不是出處，請附實際打開的頁面");
  assertStringIncludes(String(b.message), "不算被拒");
  assertEquals(inserted.filter((r) => r.table === "contributions").length, 0);
  assertEquals(inserted.filter((r) => r.table === "gate_rejections").map((r) => r.row.gate), ["search_page_not_source"]);
});

Deno.test("交件：補政見的查無，5 個實際頁面不到（搜尋結果頁扣掉後）→ 400，gate 記成 search_page_not_source", async () => {
  const { client, inserted } = fakeSupabase();
  const res = await handleContribute(client, "https://x", {
    agent_name: "tester",
    contribution_type: "no_change",
    payload: { task_id: `auto:policy_missing:${PID}`, outcome: "not_found", checked_urls: [...pages(3), G("a"), G("b")], finding: "搜了「王小明 政見」「王小明 參選 2026」「王小明 臉書」，都沒有具體政見。" },
  }, "ip-1");
  assertEquals(res.status, 400);
  const b = res.body as Record<string, unknown>;
  assertEquals(b.error, "not_found_search_insufficient");
  assertEquals(b.search_pages_excluded, 2);
  assertEquals(b.checked, 3);
  assertStringIncludes(String(b.message), "搜尋結果頁不是出處");
  assertEquals(inserted.filter((r) => r.table === "gate_rejections").map((r) => r.row.gate), ["search_page_not_source"]);
});

Deno.test("交件：查無附了 5 個實際頁面＋1 個 google 搜尋 → 收下，存的出處與 checked_urls 都沒有搜尋頁，回應的 notice 講拿掉了幾個", async () => {
  const { client, inserted } = fakeSupabase();
  const res = await handleContribute(client, "https://x", {
    agent_name: "tester",
    contribution_type: "no_change",
    payload: { task_id: `auto:policy_missing:${PID}`, outcome: "not_found", checked_urls: [G("王小明 政見"), ...pages(5)], finding: "搜了「王小明 政見」「王小明 參選 2026」「王小明 臉書」，都沒有具體政見。" },
  }, "ip-1");
  assertEquals(res.status, 201, JSON.stringify(res.body));
  const row = inserted.find((r) => r.table === "contributions")!.row;
  assertEquals(row.source_urls, pages(5));
  assertEquals((row.payload as Record<string, unknown>).checked_urls, pages(5));
  assertStringIncludes(String((res.body as Record<string, unknown>).notice), "1 個搜尋結果頁沒有算進出處");
});

Deno.test("交件：政見只附一則新聞＋一個 google 搜尋 → 搜尋頁拿掉後只剩一個網站，唯一出處守門照擋", async () => {
  const { client } = fakeSupabase();
  const res = await handleContribute(client, "https://x", {
    agent_name: "tester",
    contribution_type: "policy",
    payload: { politician_id: PID, title: "爭取四草里活動中心整修經費", description: "爭取經費整修四草里活動中心，改善里民集會與長者共餐空間。", category: "社會福利", election_id: 2022 },
    source_urls: [G("吳文振 政見"), "https://news.ltn.com.tw/news/politics/breakingnews/4000000"],
  }, "ip-1");
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).error, "single_non_official_source");
});
