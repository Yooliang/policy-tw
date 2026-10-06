/**
 * 政見／基本資料缺口回「查無」：checked_urls 至少 5 個（維護者 2026-10-01 核准）。
 *
 * 起因：抽 8 筆 policy_missing 的 no_change(not_found)，多半只看中選會、議會官網、中央社、自由時報，
 * checked_urls 2～4 個，很少用搜尋引擎、沒有人查候選人臉書；另一隻代理用搜尋引擎就找到 READr 政見總覽。
 * 「查無」是在主張不存在，要證明找過該找的地方。少於 5 個就 400（不算被拒），訊息講清楚要查哪些。
 * 只擋 policy_missing／profile_gap 的 not_found；其他任務型別、其他 outcome 不受影響。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { handleContribute } from "./contribute-handler.ts";
import { NOT_FOUND_MIN_CHECKED_URLS, notFoundSearchShortfall } from "./not-found-guard.ts";

const PID = "98b8b1ff-d085-4597-8384-a02461f773f6";
const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://example${i}.tw/news/%E7%8E%8B%E5%B0%8F%E6%98%8E`);

function body(taskId: string, outcome: string, n: number) {
  return {
    agent_name: "tester",
    contribution_type: "no_change",
    payload: { task_id: taskId, outcome, checked_urls: urls(n), finding: "搜了「王小明 政見」「王小明 參選 2026」「王小明 臉書」，候選人臉書與兩家地方新聞都沒有具體政見。" },
    source_urls: urls(Math.max(1, n)),
  };
}

/** 泛用假 supabase：查詢一律回空，insert 記下來 */
function fakeSupabase() {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  let nextId = 1;
  const client = {
    // deno-lint-ignore no-explicit-any
    from(table: string): any {
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain, eq: () => chain, in: () => chain, gte: () => chain, order: () => chain, limit: () => chain, neq: () => chain, is: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
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

Deno.test("純函式：policy_missing／profile_gap 的 not_found 少於 5 個網址才擋", () => {
  assertEquals(NOT_FOUND_MIN_CHECKED_URLS, 5);
  assertEquals(notFoundSearchShortfall(`auto:policy_missing:${PID}`, { outcome: "not_found", checked_urls: urls(4) })?.task_type, "policy_missing");
  assertEquals(notFoundSearchShortfall(`auto:profile_gap:${PID}`, { outcome: "not_found", checked_urls: urls(2) })?.checked, 2);
  assertEquals(notFoundSearchShortfall(`auto:policy_missing:${PID}`, { outcome: "not_found", checked_urls: urls(5) }), null, "5 個就夠");
  assert(notFoundSearchShortfall(`auto:policy_missing:${PID}`, { outcome: "not_found", checked_urls: [...urls(4), urls(4)[0]] }) !== null, "重複的網址不算兩個");
  assertEquals(notFoundSearchShortfall(`auto:policy_missing:${PID}`, { outcome: "confirmed", checked_urls: urls(1) }), null, "只管 not_found");
  assertEquals(notFoundSearchShortfall(`auto:policy_missing:${PID}`, { outcome: "unreachable", checked_urls: urls(1) }), null, "unreachable 另有伺服器試抓");
  assertEquals(notFoundSearchShortfall(`auto:legacy_audit:${PID}`, { outcome: "not_found", checked_urls: urls(1) }), null, "其他任務型別不擋");
  assertEquals(notFoundSearchShortfall(null, { outcome: "not_found", checked_urls: urls(1) }), null);
});

Deno.test("交件：policy_missing 回 not_found 只附 3 個網址 → 400，訊息講要搜哪些、不建 contributions", async () => {
  const { client, inserted } = fakeSupabase();
  const res = await handleContribute(client, "https://x", body(`auto:policy_missing:${PID}`, "not_found", 3), "ip-1");
  assertEquals(res.status, 400);
  const b = res.body as Record<string, unknown>;
  assertEquals(b.error, "not_found_search_insufficient");
  const msg = String(b.message);
  assertStringIncludes(msg, "搜尋引擎");
  assertStringIncludes(msg, "臉書");
  assertStringIncludes(msg, "whoareyou.readr.tw");
  assertStringIncludes(msg, "不算被拒");
  assertEquals(inserted.filter((r) => r.table === "contributions").length, 0);
});

Deno.test("交件：profile_gap 回 not_found 只附 2 個 → 400，訊息提照片關鍵字", async () => {
  const { client } = fakeSupabase();
  const res = await handleContribute(client, "https://x", body(`auto:profile_gap:${PID}`, "not_found", 2), "ip-1");
  assertEquals(res.status, 400);
  assertStringIncludes(String((res.body as Record<string, unknown>).message), "照片");
});

Deno.test("交件：其他任務型別的 not_found 不受影響", async () => {
  const { client } = fakeSupabase();
  const res = await handleContribute(client, "https://x", body(`auto:legacy_audit:${PID}`, "not_found", 1), "ip-1");
  assert((res.body as Record<string, unknown>).error !== "not_found_search_insufficient", "legacy_audit 不該被這道守門擋");
});
