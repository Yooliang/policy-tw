import { assertEquals } from "jsr:@std/assert@1";
import { handleContribute } from "./contribute-handler.ts";

// 2026-09-22：#14 上線後 leatherback 三次實測 task_suggestion 仍 201 新建（不同 IP、同對象同型別）。
// 這條測試走真的 handleContribute（假 supabase＋假投票端），看併票的路到底斷在哪。
const POLICY = "9b990687-0000-4000-8000-000000000000";
const EXISTING = {
  id: "11111111-1111-4111-8111-111111111111",
  contribution_type: "task_suggestion",
  payload: { title: "來源沒有 1000 億這個數字".padEnd(10, "。"), description: "自由時報原文對「1000億」「單一服務窗口」零命中，這段沒有根據", task_type: "other", target_policy_id: POLICY },
  agent_name: "cwen0708-pi",
  contributor_ip_hash: "ip-other",
  status: "pending",
};
function fakeSupabase(candidates: unknown[]) {
  const inserted: unknown[][] = [];
  const api = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      const chain = {
        select: () => chain, eq: (col: string, val: unknown) => { q[col] = val; return chain; }, in: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
        insert: (rows: unknown[]) => { inserted.push(rows); return { select: () => ({ data: (rows as Array<{ payload_hash: string }>).map((r, i) => ({ id: `new-${i}`, payload_hash: r.payload_hash })), error: null }) }; },
        delete: () => ({ in: () => ({ error: null }) }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (res: (v: { data: unknown; error: null; count: number }) => unknown) =>
          res(table === "contributions" && q.status === "pending" ? { data: candidates, error: null, count: 0 } : { data: [], error: null, count: 0 }),
      };
      return chain;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
  return { api, inserted };
}
const ITEM = {
  contribution_type: "task_suggestion",
  payload: { title: "description 裡的數字查無出處", description: "自由時報 5545673 原文零命中「1000億」「單一服務窗口」，這段沒有根據，該刪或改寫", task_type: "other", target_policy_id: POLICY },
  source_urls: ["https://news.ltn.com.tw/news/politics/breakingnews/5545673"],
  agent_name: "leatherback-sonnet",
  agent_tool: "claude/sonnet",
};

Deno.test("task_suggestion：同對象同型別、不同代理不同 IP → 走併票（投票端被呼叫、回 counted_as_vote）", async () => {
  const { api, inserted } = fakeSupabase([EXISTING]);
  const calls: unknown[] = [];
  const res = await handleContribute(api, "https://x", ITEM, "ip-me", (_s, body, _ip, _apply, via) => {
    calls.push({ body, via });
    return Promise.resolve({ status: 201, body: { agree_count: 1, required_agree: 2, status: "pending" } });
  });
  const b = res.body as Record<string, unknown>;
  assertEquals(calls.length, 1, `投票端沒被呼叫；回應：${JSON.stringify(b).slice(0, 300)}`);
  assertEquals(b.status, "counted_as_vote", JSON.stringify(b).slice(0, 300));
  assertEquals(inserted.length, 0, "不該新建");
});


Deno.test("task_suggestion：同對象但既有那筆是同一台機器交的 → 不併票、201 帶 note 叫它別再交", async () => {
  const { api, inserted } = fakeSupabase([{ ...EXISTING, contributor_ip_hash: "ip-me", agent_name: "another-name-same-machine" }]);
  const calls: unknown[] = [];
  const res = await handleContribute(api, "https://x", ITEM, "ip-me", (_s, body) => { calls.push(body); return Promise.resolve({ status: 201, body: {} }); });
  const b = res.body as Record<string, unknown>;
  assertEquals(calls.length, 0, "同機不能投自己那台的票");
  assertEquals(res.status, 201);
  assertEquals(inserted.length, 1, "照原路收下");
  assertEquals(String(b.note ?? "").includes("不會"), true, JSON.stringify(b).slice(0, 300));
});
