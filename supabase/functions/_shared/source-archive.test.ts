import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  acceptExistingSnapshot,
  archiveOne,
  type ArchiveOutcome,
  type ArchivePatch,
  BULLETIN_HOSTS,
  type ClaimedSource,
  docKindOf,
  normalizeSnapshotUrl,
  NOTICE_HOSTS,
  parseAvailability,
  parseSaveResponse,
  retryDelayMinutes,
  runArchiveRound,
  snapshotTime,
} from "./source-archive.ts";

// issue #347 第一階段：出處表與存檔。這組測試不打網路，Wayback 用假的 fetch。

const MIGRATION = new URL("../../migrations/20261005000347_sources_table.sql", import.meta.url);
const sql = await Deno.readTextFile(MIGRATION);

/** 取出某個 SQL 函式從 CREATE 到結尾 $$; 的本體 */
function sqlFunction(name: string): string {
  const at = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert(at >= 0, `migration 裡找不到 ${name}`);
  const open = sql.indexOf("$$", at);
  const close = sql.indexOf("$$;", open + 2);
  return sql.slice(at, close + 3);
}

const BUL = "https://bulletin.cec.gov.tw/01%E9%81%B8%E8%88%89%E5%85%AC%E5%A0%B1/05/111/a.pdf";
const EBUL = "https://eebulletin.cec.gov.tw/111/03%E6%96%B0%E5%8C%97%E5%B8%82/x.pdf";
const NOTICE_PDF = "https://web.cec.gov.tw/api/file/ccd7e51a-5fd0-4ea0-a81b-a120cd550c9c.pdf";
const NOTICE_PAGE = "https://www.cec.gov.tw/central/cms/115news/12345";

// ── 文件類別 ──────────────────────────────────────────

Deno.test("文件類別：公報站兩個、中選會官網是公告；選舉資料庫與其他網站不算", () => {
  assertEquals(docKindOf(BUL), "election_bulletin");
  assertEquals(docKindOf(EBUL), "election_bulletin");
  assertEquals(docKindOf(NOTICE_PDF), "election_notice");
  assertEquals(docKindOf(NOTICE_PAGE), "election_notice", "www. 開頭照樣認得");
  assertEquals(docKindOf("https://db.cec.gov.tw/ElecTable/Election"), null, "選舉資料庫是長期保存的，不用存檔");
  assertEquals(docKindOf("https://news.ltn.com.tw/news/1"), null);
  assertEquals(docKindOf("https://web.archive.org/web/20240101000000/https://bulletin.cec.gov.tw/a.pdf"), null, "已經是存檔網址");
  assertEquals(docKindOf("ftp://bulletin.cec.gov.tw/a.pdf"), null);
  assertEquals(docKindOf("不是網址"), null);
});

Deno.test("SQL 與 TS 一致：source_doc_kind() 的兩組網域等於 BULLETIN_HOSTS／NOTICE_HOSTS", () => {
  const fn = sqlFunction("source_doc_kind");
  const arrays = [...fn.matchAll(/ARRAY\[([^\]]+)\]/g)].map((m) => m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")));
  assertEquals(arrays.length, 2, "公報、公告兩組");
  assertEquals(arrays[0], [...BULLETIN_HOSTS]);
  assertEquals(arrays[1], [...NOTICE_HOSTS]);
  assert(/THEN 'election_bulletin'/.test(fn) && /THEN 'election_notice'/.test(fn));
});

// ── 出處等級：本人來源要有認定根據 ──────────────────────────

Deno.test("本人來源沒有認定根據就寫不進來：self ⇔ self_evidence 有值，擋在資料庫", () => {
  assert(
    /CONSTRAINT sources_self_needs_evidence CHECK \(\(source_kind = 'self'\) = \(self_evidence IS NOT NULL\)\)/.test(sql),
    "sources 表要有 self ⇔ self_evidence 的約束（防冒名：沒有根據的本人帳號視為媒體）",
  );
  assert(/self_evidence\s+TEXT CHECK \(self_evidence IN \('linked_by_official', 'mutual_link', 'platform_verified'\)\)/.test(sql), "三種認定根據");
});

Deno.test("自動判斷的等級：社群算媒體、永遠不給 self", () => {
  const fn = sqlFunction("source_auto_kind");
  assert(/WHEN 'social' THEN 'media'/.test(fn), "沒有認定根據的社群貼文算 media");
  assert(!/'self'/.test(fn), "自動判斷不可以產生 self（self 只能由流程附根據設定）");
});

// ── 第一階段只加不刪；觸發器不能擋正式資料的寫入 ─────────────────

Deno.test("第一階段只加新的：不刪欄位、不改名、不刪舊表（CLAUDE.md：刪改欄位分兩次上）", () => {
  const body = sql.replace(/--[^\n]*/g, "");
  assert(!/DROP\s+COLUMN/i.test(body), "不刪欄位");
  assert(!/RENAME/i.test(body), "不改名");
  assert(!/DROP\s+TABLE/i.test(body), "不刪表");
});

Deno.test("同步觸發器出錯只記警告、不擋原本的寫入（落庫是正式資料的唯一路徑）", () => {
  for (const name of ["sources_sync_policy", "sources_sync_tracking_log", "sources_sync_policy_source", "sources_sync_contribution"]) {
    const fn = sqlFunction(name);
    assert(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING/.test(fn), `${name} 要把錯誤吞成警告`);
    assert(/RETURN NEW;\s*END;\s*\$\$;$/.test(fn.trim()), `${name} 最後一定 RETURN NEW`);
  }
});

Deno.test("交件當下就登記公報類網址（不等投票），落庫才記其他網址", () => {
  const fn = sqlFunction("sources_sync_contribution");
  assert(/IF TG_OP = 'INSERT' THEN[\s\S]*source_doc_kind\(btrim\(v_url\)\) IS NOT NULL[\s\S]*ELSIF/.test(fn), "INSERT 只登記 source_doc_kind 有值的網址");
  assert(/AFTER INSERT OR UPDATE OF applied_policy_id ON contributions/.test(sql));
});

// ── 存檔網址的解析 ────────────────────────────────────

Deno.test("存檔網址：補成 https 完整網址、去掉 id_ 之類的修飾，不是存檔網址回 null", () => {
  assertEquals(normalizeSnapshotUrl("/web/20261005010203/https://bulletin.cec.gov.tw/a.pdf"), "https://web.archive.org/web/20261005010203/https://bulletin.cec.gov.tw/a.pdf");
  assertEquals(normalizeSnapshotUrl("http://web.archive.org/web/20261005010203id_/https://x.tw/a"), "https://web.archive.org/web/20261005010203/https://x.tw/a");
  assertEquals(normalizeSnapshotUrl("https://web.archive.org/save/https://x.tw/a"), null, "save 頁不是存檔");
  assertEquals(normalizeSnapshotUrl("https://web.archive.org/web/2026/https://x.tw/a"), null, "沒有完整時間戳不是特定存檔");
  assertEquals(normalizeSnapshotUrl(null), null);
  assertEquals(snapshotTime("https://web.archive.org/web/20261005010203/https://x.tw/a")?.toISOString(), "2026-10-05T01:02:03.000Z");
});

Deno.test("可用性 API：只收 status 200、available 的存檔", () => {
  const ok = { archived_snapshots: { closest: { available: true, status: "200", url: "http://web.archive.org/web/20221101000000/https://bulletin.cec.gov.tw/a.pdf", timestamp: "20221101000000" } } };
  assertEquals(parseAvailability(ok), "https://web.archive.org/web/20221101000000/https://bulletin.cec.gov.tw/a.pdf");
  assertEquals(parseAvailability({ archived_snapshots: { closest: { ...ok.archived_snapshots.closest, status: "404" } } }), null, "存到的是 404 頁");
  assertEquals(parseAvailability({ archived_snapshots: {} }), null);
  assertEquals(parseAvailability(null), null);
});

Deno.test("現在存的回應：Location、Content-Location、跟隨後的網址三處都認", () => {
  const snap = "https://web.archive.org/web/20261005010203/https://bulletin.cec.gov.tw/a.pdf";
  assertEquals(parseSaveResponse({ status: 302, location: snap }), snap);
  assertEquals(parseSaveResponse({ status: 200, contentLocation: "/web/20261005010203/https://bulletin.cec.gov.tw/a.pdf" }), snap);
  assertEquals(parseSaveResponse({ status: 200, finalUrl: snap }), snap);
  assertEquals(parseSaveResponse({ status: 200, finalUrl: "https://web.archive.org/save/https://bulletin.cec.gov.tw/a.pdf" }), null);
});

Deno.test("既有存檔：檔案任何時間都算；網頁要在擷取時間前後 30 天內", () => {
  const now = new Date("2026-10-05T00:00:00Z");
  const old = "https://web.archive.org/web/20221101000000/x";
  assert(acceptExistingSnapshot(BUL, old, null, now), "PDF 內容不會變");
  assert(acceptExistingSnapshot(NOTICE_PDF, old, null, now), "/api/file/ 也是檔案");
  assert(!acceptExistingSnapshot(NOTICE_PAGE, old, null, now), "網頁會改，四年前的存檔不算");
  assert(acceptExistingSnapshot(NOTICE_PAGE, "https://web.archive.org/web/20261001000000/x", null, now));
  assert(acceptExistingSnapshot(NOTICE_PAGE, "https://web.archive.org/web/20220915000000/x", new Date("2022-10-01T00:00:00Z"), now), "對擷取時間算");
  assert(!acceptExistingSnapshot(BUL, "https://example.com/not-archive", null, now));
});

Deno.test("失敗退避：30 分起倍增，最長每天一次，永不放棄", () => {
  assertEquals([1, 2, 3, 4, 5, 6, 7].map(retryDelayMinutes), [30, 60, 120, 240, 480, 960, 1440]);
  assertEquals(retryDelayMinutes(50), 1440, "試再多次也還是每天一次，不會變成不再試");
  assertEquals(retryDelayMinutes(0), 30);
});

// ── archiveOne：假的 Wayback ───────────────────────────────

type Hit = { status: number; body?: string; headers?: Record<string, string> };
function fakeFetch(route: (url: string) => Hit, calls: string[] = []): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const h = route(url);
    return Promise.resolve(new Response(h.body ?? "", { status: h.status, headers: h.headers ?? {} }));
  }) as unknown as typeof fetch;
}
const avail = (snapUrl: string | null) =>
  JSON.stringify({ archived_snapshots: snapUrl ? { closest: { available: true, status: "200", url: snapUrl } } : {} });

Deno.test("archiveOne：已有可用的存檔就不再送「現在存」", async () => {
  const calls: string[] = [];
  const f = fakeFetch((u) => u.startsWith("https://archive.org/wayback/available") ? { status: 200, body: avail(`http://web.archive.org/web/20221101000000/${BUL}`) } : { status: 500 }, calls);
  const r = await archiveOne(BUL, null, { fetchImpl: f });
  assertEquals(r, { ok: true, archiveUrl: `https://web.archive.org/web/20221101000000/${BUL}`, method: "existing" });
  assertEquals(calls.length, 1);
});

Deno.test("archiveOne：網頁只有舊存檔 → 送現在存，Location 帶回新存檔", async () => {
  const calls: string[] = [];
  const fresh = `https://web.archive.org/web/20261005010203/${NOTICE_PAGE}`;
  const f = fakeFetch((u) => {
    if (u.startsWith("https://archive.org/wayback/available")) return { status: 200, body: avail(`http://web.archive.org/web/20200101000000/${NOTICE_PAGE}`) };
    if (u.startsWith("https://web.archive.org/save/")) return { status: 302, headers: { location: fresh } };
    return { status: 404 };
  }, calls);
  const r = await archiveOne(NOTICE_PAGE, null, { fetchImpl: f, now: new Date("2026-10-05T02:00:00Z") });
  assertEquals(r, { ok: true, archiveUrl: fresh, method: "saved" });
  assertEquals(calls[1], `https://web.archive.org/save/${NOTICE_PAGE}`);
});

Deno.test("archiveOne：429 標成限流；沒有存檔網址的 200 是失敗；查可用性出錯不擋現在存", async () => {
  const r429 = await archiveOne(BUL, null, { fetchImpl: fakeFetch((u) => u.includes("/save/") ? { status: 429 } : { status: 200, body: avail(null) }) });
  assertEquals(r429.ok, false);
  assert(!r429.ok && r429.rateLimited);
  const r200 = await archiveOne(BUL, null, { fetchImpl: fakeFetch((u) => u.includes("/save/") ? { status: 200, body: "<html>稍後再試</html>" } : { status: 503 }) });
  assert(!r200.ok && !r200.rateLimited && /HTTP 200/.test(r200.error));
  const throwing = ((input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://archive.org/")) return Promise.reject(new Error("dns"));
    return Promise.resolve(new Response("", { status: 302, headers: { location: `https://web.archive.org/web/20261005000000/${BUL}` } }));
  }) as unknown as typeof fetch;
  const r = await archiveOne(BUL, null, { fetchImpl: throwing });
  assertEquals(r.ok, true);
});

// ── 一輪存檔 ──────────────────────────────────────────

function fakeRound(queue: ClaimedSource[], outcomes: Record<string, ArchiveOutcome>, opts: { maxItems?: number; clockStepMs?: number; budgetMs?: number } = {}) {
  const updates: Array<[number, ArchivePatch]> = [];
  const archived: string[] = [];
  let t = Date.parse("2026-10-05T00:00:00Z");
  return {
    updates, archived,
    run: () => runArchiveRound({
      claim: () => Promise.resolve(queue.shift() ?? null),
      update: (id, patch) => { updates.push([id, patch]); return Promise.resolve(); },
      archive: (url) => { archived.push(url); return Promise.resolve(outcomes[url]); },
      now: () => { const d = new Date(t); t += opts.clockStepMs ?? 0; return d; },
      maxItems: opts.maxItems ?? 10,
      timeBudgetMs: opts.budgetMs ?? 60_000,
    }),
  };
}
const row = (id: number, url: string, attempts = 1): ClaimedSource => ({ id, url, doc_kind: docKindOf(url), fetched_at: null, archive_attempts: attempts });

Deno.test("一輪存檔：成功寫 archive_url、清錯誤；失敗寫錯誤與下次時間（依次數退避）", async () => {
  const snap = `https://web.archive.org/web/20261005000000/${BUL}`;
  const r = fakeRound([row(1, BUL), row(2, EBUL, 3)], {
    [BUL]: { ok: true, archiveUrl: snap, method: "saved" },
    [EBUL]: { ok: false, error: "HTTP 520", rateLimited: false },
  });
  const out = await r.run();
  assertEquals(out.stoppedBy, "done");
  assertEquals(r.updates[0], [1, { archive_url: snap, archived_at: "2026-10-05T00:00:00.000Z", archive_error: null, archive_next_at: null }]);
  assertEquals(r.updates[1], [2, { archive_error: "HTTP 520", archive_next_at: "2026-10-05T02:00:00.000Z" }], "第 3 次失敗 → 2 小時後");
});

Deno.test("一輪存檔：遇到 429 整輪停下，不再領下一筆", async () => {
  const r = fakeRound([row(1, BUL), row(2, EBUL)], { [BUL]: { ok: false, error: "429", rateLimited: true } });
  const out = await r.run();
  assertEquals(out.stoppedBy, "rate_limited");
  assertEquals(r.archived, [BUL]);
  assertEquals(r.updates.length, 1);
});

Deno.test("一輪存檔：件數上限與時間預算", async () => {
  const ok: ArchiveOutcome = { ok: true, archiveUrl: `https://web.archive.org/web/20261005000000/${BUL}`, method: "saved" };
  const r1 = fakeRound([row(1, BUL), row(2, BUL), row(3, BUL)], { [BUL]: ok }, { maxItems: 2 });
  assertEquals((await r1.run()).stoppedBy, "max_items");
  assertEquals(r1.archived.length, 2);
  const r2 = fakeRound([row(1, BUL), row(2, BUL), row(3, BUL)], { [BUL]: ok }, { clockStepMs: 20_000, budgetMs: 45_000 });
  const out2 = await r2.run();
  assertEquals(out2.stoppedBy, "time");
  assert(r2.archived.length < 3);
});

Deno.test("一輪存檔：領到不屬於存檔類別的網址（SQL 與程式分歧）不送 Wayback，記錯誤", async () => {
  const r = fakeRound([row(9, "https://news.ltn.com.tw/news/1")], {});
  await r.run();
  assertEquals(r.archived, []);
  assert(/不一致/.test(String(r.updates[0][1].archive_error)));
  assert(!("archive_url" in r.updates[0][1]));
});
