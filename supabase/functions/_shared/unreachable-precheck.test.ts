/**
 * 無異動的「打不開」不進投票（2026-09-26 小良哥核准）。
 *
 * unreachable 沒有資訊量：常常其實抓得到（原文 404 但 archive.org 有存檔、403 加 UA 就開），
 * 卻要別人花一票去「認可我什麼都沒看到」。交件時讓伺服器自己先試一次：
 *   - 抓得到可用正文 → 400 unreachable_but_fetchable，附系統抓到的網址，代理照內容改判（不算退件）
 *   - 全部抓不到 → 直接落庫為 applied，不進投票，只記錄這次嘗試
 *   - 試抓本身出錯（程式例外）→ 不能讓系統的錯擋掉代理，照舊收成 pending
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleContribute, precheckUnreachable } from "./contribute-handler.ts";

const AUTO_TASK = "auto:profile_gap:98b8b1ff-d085-4597-8384-a02461f773f6";
const MANUAL_TASK = "88888888-8888-4888-8888-888888888888";
const URL_A = "https://udn.com/news/story/6656/000001";

function noChangeBody(taskId: string, outcome: string, checkedUrls: string[] = [URL_A]) {
  return {
    agent_name: "tester",
    contribution_type: "no_change",
    payload: { task_id: taskId, outcome, checked_urls: checkedUrls, finding: "原文回應非 2xx，站內搜尋與另一家媒體都找不到同一篇報導，也查了 web.archive.org。" },
    source_urls: checkedUrls,
  };
}

/** 假 supabase：泛用鏈（select/eq/in/gte/order/limit/neq 都回自己，最後靠 then／maybeSingle 給結果），
 * insert 記錄下來並配一個新 id；update 記錄 patch；只有 contribution_tasks 的 maybeSingle 認得測試指定的手動任務。 */
function fakeSupabase(opts: { manualTask?: { id: string; task_type: string; status?: string } | null } = {}) {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const updated: Array<{ table: string; id: string | null; patch: Record<string, unknown> }> = [];
  let nextId = 1;

  const client = {
    // deno-lint-ignore no-explicit-any
    from(table: string): any {
      const q: Record<string, unknown> = {};
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: unknown) => { q[col] = val; return chain; },
        in: (col: string, val: unknown) => { q[col] = val; return chain; },
        gte: () => chain,
        order: () => chain,
        limit: () => chain,
        neq: () => chain,
        maybeSingle: async () => {
          if (table === "contribution_tasks" && opts.manualTask && q["id"] === opts.manualTask.id) {
            return { data: { id: opts.manualTask.id, task_type: opts.manualTask.task_type, status: opts.manualTask.status ?? "open" }, error: null };
          }
          return { data: null, error: null };
        },
        insert: (row: Record<string, unknown> | Record<string, unknown>[]) => {
          const rows = (Array.isArray(row) ? row : [row]).map((r) => ({ id: `row-${nextId++}`, ...r }));
          for (const r of rows) inserted.push({ table, row: r });
          const selectResult = {
            then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res),
            maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
          };
          return { error: null, select: () => selectResult };
        },
        update: (patch: Record<string, unknown>) => ({
          eq: (_col: string, id: string) => {
            updated.push({ table, id, patch });
            return Promise.resolve({ error: null });
          },
        }),
        delete: () => ({ in: () => Promise.resolve({ error: null }) }),
        then: (res: (v: { data: unknown; error: null; count: number }) => unknown) =>
          Promise.resolve({ data: [], error: null, count: 0 }).then(res),
      };
      return chain;
    },
  };
  return { client, inserted, updated };
}

const fetchableImpl = (async () =>
  new Response("<p>" + "報導內容確認屬實".repeat(40) + "</p>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
const unreachableImpl = (async () => new Response("not found", { status: 404 })) as typeof fetch;

Deno.test("unreachable：伺服器試抓打得開 → 400 unreachable_but_fetchable，記 gate_rejections，不建任何 contributions", async () => {
  const { client, inserted } = fakeSupabase();
  const res = await handleContribute(client, "https://x", noChangeBody(AUTO_TASK, "unreachable"), "ip-1", undefined, "contribute", fetchableImpl);
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).error, "unreachable_but_fetchable");
  assertEquals((res.body as Record<string, unknown>).fetched_url, URL_A);
  assert(String((res.body as Record<string, unknown>).message).includes("confirmed") || String((res.body as Record<string, unknown>).message).includes("not_found"), "要教代理改判 confirmed／not_found");
  const gate = inserted.find((r) => r.table === "gate_rejections");
  assertEquals(gate?.row.gate, "unreachable_but_fetchable");
  assertEquals(inserted.filter((r) => r.table === "contributions").length, 0, "抓得到不算收件，不該建任何 contributions 列");
});

Deno.test("unreachable：全部抓不到（自動缺口）→ 直接落庫 applied，記 task_checks，不進投票", async () => {
  const { client, inserted, updated } = fakeSupabase();
  const res = await handleContribute(client, "https://x", noChangeBody(AUTO_TASK, "unreachable"), "ip-1", undefined, "contribute", unreachableImpl);
  assertEquals(res.status, 201);
  const body = res.body as Record<string, unknown>;
  assertEquals(body.status, "applied");
  assert(String(body.message).includes("已記錄"), `訊息要講清楚已經記錄這次嘗試，實際是：${body.message}`);
  assert(String(body.message).includes("不需要別人驗證") || String(body.message).includes("不進投票"));

  const check = inserted.find((r) => r.table === "task_checks");
  assertEquals(check?.row.outcome, "unreachable", "自動缺口要記一筆 task_checks，冷卻期內不再派");

  const patch = updated.find((u) => u.table === "contributions");
  assertEquals(patch?.patch.status, "applied");
  assert(String(patch?.patch.review_notes).includes("[系統] 打不開"), "review_notes 要講清楚是系統抓不到，不是代理偷懶");
  assert(String(patch?.patch.review_notes).includes("不進投票"));
});

Deno.test("unreachable：全部抓不到（手動任務）→ 落庫 applied，但任務留著給別人接手、不關閉", async () => {
  const { client, inserted, updated } = fakeSupabase({ manualTask: { id: MANUAL_TASK, task_type: "policy_source_missing" } });
  const res = await handleContribute(client, "https://x", noChangeBody(MANUAL_TASK, "unreachable"), "ip-1", undefined, "contribute", unreachableImpl);
  assertEquals(res.status, 201);
  const body = res.body as Record<string, unknown>;
  assertEquals(body.status, "applied");

  assertEquals(updated.filter((u) => u.table === "contribution_tasks").length, 0, "手動任務不能因為打不開被關掉——要留著換人再試");
  assertEquals(inserted.filter((r) => r.table === "task_checks").length, 0, "task_checks 是給自動缺口冷卻用的，手動任務不寫這張表");
  const patch = updated.find((u) => u.table === "contributions");
  assertEquals(patch?.patch.status, "applied");
});

Deno.test("unreachable：試抓本身出錯（程式例外）→ 照舊收成 pending，不擋代理", async () => {
  const throwingPrecheck: typeof precheckUnreachable = () => { throw new Error("boom：試抓邏輯自己壞了"); };
  const { client, inserted, updated } = fakeSupabase();
  const res = await handleContribute(client, "https://x", noChangeBody(AUTO_TASK, "unreachable"), "ip-1", undefined, "contribute", unreachableImpl, throwingPrecheck);
  assertEquals(res.status, 201);
  const body = res.body as Record<string, unknown>;
  assertEquals(body.status, "pending", "試抓自己出錯不該把這筆變成 applied 或擋下來，照舊收成 pending 等投票");
  assertEquals(inserted.filter((r) => r.table === "gate_rejections").length, 0);
  assertEquals(inserted.filter((r) => r.table === "task_checks").length, 0);
  assertEquals(updated.filter((u) => u.table === "contributions").length, 0, "沒有走 bypass，不該有事後改狀態的 update");
  assertEquals(inserted.filter((r) => r.table === "contributions").length, 1, "還是要正常收下這筆等投票");
});

Deno.test("confirmed／not_found 不會觸發伺服器試抓", async () => {
  let calls = 0;
  const spyPrecheck: typeof precheckUnreachable = () => { calls++; return Promise.resolve({ fetchedUrl: null, attempts: [] }); };
  for (const outcome of ["confirmed", "not_found"]) {
    const { client } = fakeSupabase();
    const res = await handleContribute(client, "https://x", noChangeBody(AUTO_TASK, outcome), "ip-1", undefined, "contribute", unreachableImpl, spyPrecheck);
    assertEquals(res.status, 201);
    assertEquals((res.body as Record<string, unknown>).status, "pending", `outcome=${outcome} 應該照常走投票流程`);
  }
  assertEquals(calls, 0, "只有 outcome=unreachable 才需要伺服器試抓");
});

Deno.test("precheckUnreachable：只試前 3 個網址；抓到可用正文的那個回傳，其餘網址不動", async () => {
  const urls = ["https://a.test/1", "https://b.test/2", "https://c.test/3", "https://d.test/4"];
  const calls: string[] = [];
  const impl = (async (u: string | URL | Request) => {
    const url = String(u);
    calls.push(url);
    if (url.includes("b.test")) {
      return new Response("<p>" + "確認內容屬實".repeat(40) + "</p>", { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const result = await precheckUnreachable(urls, impl);
  assertEquals(result.fetchedUrl, "https://b.test/2");
  assertEquals(result.attempts.length, 3, "只試前 3 個網址");
  assert(!calls.some((u) => u.includes("d.test")), "第 4 個網址（超過上限）不該被試抓");
});

Deno.test("precheckUnreachable：全部抓不到就回 null，attempts 留下每個網址的結果供代理／稽核看", async () => {
  const result = await precheckUnreachable([URL_A], unreachableImpl);
  assertEquals(result.fetchedUrl, null);
  assertEquals(result.attempts.length, 1);
  assertEquals(result.attempts[0].url, URL_A);
  assert(result.attempts[0].note.includes("404"));
});
