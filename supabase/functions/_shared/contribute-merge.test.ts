import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleContribute } from "./contribute-handler.ts";

/**
 * 重複提交＝同意票的端到端：假的 supabase + 假的投票端。
 * 2026-09-18：線上 1,207 筆 pending 有 110 對「同一宣稱、不同代理」的配對，兩筆都 0 票。
 */
const EXISTING = {
  id: "11111111-1111-4111-8111-111111111111",
  contribution_type: "correction",
  payload: { target_table: "politician_elections", target_id: "9827", changes: [{ field: "candidate_status", correct_value: "registered" }] },
  agent_name: "a-zhen",
  contributor_ip_hash: "ip-other",
  status: "pending",
};

function fakeSupabase(candidates: unknown[] = [EXISTING]) {
  const inserted: unknown[][] = [];
  const api = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => { q[col] = val; return chain; },
        in: () => chain,
        gte: () => chain,
        order: () => chain,
        limit: () => chain,
        insert: (rows: unknown[]) => { inserted.push(rows); return { select: () => ({ data: (rows as Array<{ payload_hash: string }>).map((r, i) => ({ id: `new-${i}`, payload_hash: r.payload_hash })), error: null }) }; },
        delete: () => ({ in: () => ({ error: null }) }),
        // 計數查詢（每日額度）與候選查詢共用這個 thenable
        then: (res: (v: { data: unknown; error: null; count: number }) => unknown) =>
          res(table === "contributions" && q.status === "pending" ? { data: candidates, error: null, count: 0 } : { data: [], error: null, count: 0 }),
      };
      return chain;
    },
  };
  return { api, inserted };
}

const ITEM = {
  contribution_type: "correction",
  payload: { target_table: "politician_elections", target_id: "9827", changes: [{ field: "candidate_status", correct_value: "registered" }], reason: "自由時報 2026-09-04 報導已完成登記" },
  source_urls: ["https://news.ltn.com.tw/news/politics/breakingnews/1"],
  agent_name: "lampstand",
  agent_tool: "pi/deepseek-v4-flash",
};

Deno.test("同一宣稱、不同代理 → 不建新的一筆，改投同意票", async () => {
  const { api, inserted } = fakeSupabase();
  const votes: Array<Record<string, unknown>> = [];
  const vias: Array<string | undefined> = [];
  const res = await handleContribute(api, "https://x", ITEM, "ip-me", (_s, body, _ip, _apply, via) => {
    votes.push(body as Record<string, unknown>);
    vias.push(via);
    return Promise.resolve({ status: 201, body: { agree_count: 2, required_agree: 2, status: "applied" } });
  });
  assertEquals(vias, ["merge"], "併票要標 via merge，派發閘才會放行（2026-09-21 被閘關了 10 小時的教訓）");

  assertEquals(res.status, 201);
  assertEquals(inserted.length, 0, "不該再插一筆新的貢獻");
  assertEquals(votes.length, 1, "要投一票");
  assertEquals(votes[0].contribution_id, EXISTING.id);
  assertEquals(votes[0].verdict, "agree");
  assertEquals(votes[0].agent_name, "lampstand");
  assert(String(votes[0].note).includes("這票來自重複提交"), "票裡要看得出這票怎麼來的");
  assert(String(votes[0].note).includes("news.ltn.com.tw"), "要把對方的來源附上去");

  const r = (res.body as { contribution_id: string; status: string; agree_count: number }) as unknown as Record<string, unknown>;
  assertEquals(r.status, "counted_as_vote");
  assertEquals(r.contribution_id, EXISTING.id, "回的是既有那筆的 id，代理查得到後續");
  assertEquals(r.agree_count, 2);
});

Deno.test("投不成（自己那台交的／已投過／額度用完）就照原路收下，不能默默丟掉", async () => {
  const { api, inserted } = fakeSupabase();
  const res = await handleContribute(api, "https://x", ITEM, "ip-me", () =>
    Promise.resolve({ status: 403, body: { error: "self_vote" } }));
  assertEquals(res.status, 201);
  assertEquals(inserted.length, 1, "投不成就要照常建這一筆");
  assertEquals((res.body as Record<string, unknown>).status, "pending");
});

Deno.test("沒有同一宣稱的既有貢獻時，照原路收下", async () => {
  const { api, inserted } = fakeSupabase([]);
  let voted = 0;
  const res = await handleContribute(api, "https://x", ITEM, "ip-me", () => { voted++; return Promise.resolve({ status: 201, body: {} }); });
  assertEquals(voted, 0, "沒有對象就不該投票");
  assertEquals(inserted.length, 1);
  assertEquals((res.body as Record<string, unknown>).status, "pending");
});

Deno.test("自由文字型別（policy）永遠不合併", async () => {
  const { api, inserted } = fakeSupabase([{ ...EXISTING, contribution_type: "policy", payload: { politician_id: "p1", title: "居住新五箭" } }]);
  let voted = 0;
  const res = await handleContribute(api, "https://x", {
    contribution_type: "policy",
    payload: {
      politician_id: "22222222-2222-4222-8222-222222222222",
      title: "推動「居住新五箭」擴大社宅供給",
      description: "捷運開發沿線一律納入社會住宅，另推企業勞工宅、婚育宅最長可住二十年，並加碼興建高齡友善社宅，四年內達成新增戶數目標。",
      category: "都市發展與住宅",
    },
    source_urls: ["https://www.cna.com.tw/news/aipl/1.aspx"],
    agent_name: "lampstand",
  }, "ip-me", () => { voted++; return Promise.resolve({ status: 201, body: {} }); });
  assertEquals(voted, 0, "政見標題不同就是不同政見，不能合併");
  assertEquals(inserted.length, 1);
  assertEquals((res.body as Record<string, unknown>).status, "pending");
});
