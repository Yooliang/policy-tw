// 額度用完就只派另一種（2026-10-22）。
//
// 10-21 晚上三個網段各交滿 200 筆後整個停擺：驗證票一票沒投，而系統有 1,263 筆等驗證的交件。
// /next 只在回應的 quota 欄報 remaining，派工時沒看提交額度，額度用完照樣派任務，代理交件吃 429。
// 真的載入 next 入口、用真的 Request 打進去（entry-harness），底下是假 PostgREST；
// 提交／驗證今日用量由 HEAD count 決定。
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { loadEntry, type RestCall } from "./entry-harness.ts";

const env = { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789", CONTRIBUTION_IP_SALT: "salt" };
const CID = "11111111-2222-3333-4444-555555555555";
const TASK = "auto:profile_gap:abc123";
const FULL = 100000; // 遠大於任何上限
const taskRow = { task_id: TASK, task_type: "profile_gap", target: {}, what_we_need: "補基本資料", hint_sources: [], reward: 1, queue_at: "2026-09-01T00:00:00Z" };
const candidate = {
  id: CID, contribution_type: "policy", payload: { title: "測試政見" }, source_urls: ["https://example.test/a"], note: null, task_id: null,
  agent_name: "someone", contributor_ip_hash: "someone-else", status: "pending", agree_count: 0, disagree_count: 0, unsure_count: 0,
  created_at: "2026-10-01T00:00:00Z", queue_at: "2026-10-01T00:00:00Z", score: 0, target_score: 3, effective_required: 3,
};

interface Scenario { submitUsed: number; verifyUsed: number; pool: boolean; queue: boolean }

async function run(s: Scenario): Promise<{ body: Record<string, unknown>; calls: RestCall[] }> {
  const router = (c: RestCall): unknown => {
    if (c.method === "HEAD" && c.target === "contributions") return { __count: s.submitUsed };
    if (c.method === "HEAD" && c.target === "contribution_votes") return { __count: s.verifyUsed };
    if (c.target === "rpc/contribution_verify_pool") return s.pool ? [candidate] : [];
    if (c.target === "rpc/contribution_queue_tasks") return s.queue ? [taskRow] : [];
    if (c.target === "rpc/contribution_effective_agree") return 3;
    if (c.target === "contributions" && c.url.searchParams.get("id") === `eq.${CID}`) return [candidate];
    return undefined;
  };
  const entry = await loadEntry("../next/index.ts", env, router);
  try {
    const res = await entry.call(new Request("https://x/next?agent_name=dave&agent_tool=claude-code/claude-sonnet-5", { headers: { "x-forwarded-for": "10.1.1.5" } }));
    assertEquals(res.status, 200);
    return { body: await res.json(), calls: entry.calls };
  } finally {
    entry.restore();
  }
}

const base: Scenario = { submitUsed: 0, verifyUsed: 0, pool: true, queue: true };
const tasksLeased = (calls: RestCall[]) => calls.filter((c) => c.target === "contribution_task_leases" && c.method !== "GET");

Deno.test("額度都還有：照舊——隊頭（較早的）是任務就派任務；沒有任務就派驗證票；quota 欄照報", async () => {
  const a = await run(base);
  assertEquals(a.body.kind, "task");
  const b = await run({ ...base, queue: false });
  assertEquals(b.body.kind, "verify");
  assert((b.body.quota as { submit: { remaining: number } }).submit.remaining > 0);
});

Deno.test("1 提交額度用完、驗證額度還有、有合格驗證票 → 派驗證票，即使任務排在更前面", async () => {
  // 任務的排序鍵比驗證票早：額度還有時隊頭是任務（上一個測試）；提交額度用完要改派驗證票
  const r = await run({ ...base, submitUsed: FULL });
  assertEquals(r.body.kind, "verify");
  assertEquals((r.body.item as { contribution_id: string }).contribution_id, CID);
  assertEquals(tasksLeased(r.calls).length, 0, "不該認領任何任務");
  assertEquals((r.body.quota as { submit: { remaining: number } }).submit.remaining, 0);
});

Deno.test("2 提交額度用完、沒有合格驗證票 → none，說明這個時段提交額度用完與重置時間，不派任務", async () => {
  const r = await run({ ...base, submitUsed: FULL, pool: false });
  assertEquals(r.body.kind, "none");
  assertStringIncludes(String(r.body.reason), "這個時段");
  assertStringIncludes(String(r.body.reason), "台北重置");
  assertEquals(typeof r.body.retry_after_min, "number");
  assertEquals(r.body.item, undefined);
  assertEquals(tasksLeased(r.calls).length, 0, "不該認領任務");
});

Deno.test("2 提交與驗證額度都用完 → none，等到時段重置（retry_after_min 不小於一般等待）", async () => {
  const r = await run({ ...base, submitUsed: FULL, verifyUsed: FULL });
  assertEquals(r.body.kind, "none");
  assertStringIncludes(String(r.body.reason), "這個時段額度已用完");
  assertStringIncludes(String(r.body.reason), String((r.body.quota as { window_resets_at: string }).window_resets_at));
  assert((r.body.retry_after_min as number) >= 5 && (r.body.retry_after_min as number) <= 240);
  assertEquals(tasksLeased(r.calls).length, 0);
  assert(!r.calls.some((c) => c.target === "verify_dispatches" && c.method === "POST"), "不該派驗證票");
});

Deno.test("3 驗證額度用完、提交額度還有 → 只派任務，不派驗證票", async () => {
  const r = await run({ ...base, verifyUsed: FULL });
  assertEquals(r.body.kind, "task");
  assertEquals((r.body.item as { task_id: string }).task_id, TASK);
  assert(!r.calls.some((c) => c.target === "verify_dispatches" && c.method === "POST"), "不該派驗證票");
});

Deno.test("3 驗證額度用完、沒有任務可派 → none（不退回驗證票）", async () => {
  const r = await run({ ...base, verifyUsed: FULL, queue: false });
  assertEquals(r.body.kind, "none");
});
