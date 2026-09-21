// 人工介入點只剩 disputed：身份指認（votes.resolved_politician_id）、落庫失敗自動重試、驗證現況附 similar_policies／identity_candidates
import { assert, assertEquals } from "jsr:@std/assert@1";
import { autoApplyContribution, shouldRetry } from "./auto-apply.ts";
import type { ContributionRow } from "./apply-contribution.ts";
import { planRetry, resolveIdentityFromVotes } from "./consensus.ts";
import { shapeVerifyCurrent } from "./task-context.ts";

/** 假 supabase：contributions 一列 + contribution_votes 清單；記錄 update patch */
function fakeWithVotes(row: Record<string, unknown> | null, votes: Array<{ verdict: string; resolved_politician_id: string | null }>) {
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const client = {
    from: (table: string) => table === "contribution_votes"
      ? { select: () => ({ eq: async () => ({ data: votes, error: null }) }) }
      : {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
        update: (patch: Record<string, unknown>) => ({ eq: () => ({ eq: async () => { updates.push({ table, patch }); return { error: null }; } }) }),
      },
  };
  return { client, updates };
}

Deno.test("身份指認純函式：兩票同一位 resolved；指不同位 conflict；都沒帶 none（unsure／disagree 的指認不算）", () => {
  assertEquals(resolveIdentityFromVotes([{ verdict: "agree", resolved_politician_id: "a" }, { verdict: "agree", resolved_politician_id: "a" }]), { kind: "resolved", politician_id: "a" });
  assertEquals(resolveIdentityFromVotes([{ verdict: "agree", resolved_politician_id: "a" }, { verdict: "agree", resolved_politician_id: "b" }]), { kind: "conflict", politician_ids: ["a", "b"] });
  assertEquals(resolveIdentityFromVotes([{ verdict: "agree", resolved_politician_id: null }, { verdict: "unsure", resolved_politician_id: "b" }]), { kind: "none" });
  assertEquals(resolveIdentityFromVotes([{ verdict: "agree", resolved_politician_id: "a" }, { verdict: "agree", resolved_politician_id: null }]), { kind: "resolved", politician_id: "a" });
});

Deno.test("candidacy 自動落庫：指認衝突 → 退件不呼叫 applyFn；兩票同一位 → applyFn 收到 resolved_politician_id；比對 ambiguous → 退件", async () => {
  const row = { id: "c2", contribution_type: "candidacy", payload: { name: "陳素月" }, source_urls: ["https://a"], note: null, agent_name: "u", contributor_url: null, status: "verified", retry_count: 0 };
  let called: ContributionRow | null = null;
  const applyFn = async (_s: unknown, r: ContributionRow) => { called = r; return { status: "applied" as const, message: "ok", politician_id: String(r.resolved_politician_id) }; };

  const conflict = fakeWithVotes(row, [{ verdict: "agree", resolved_politician_id: "p-a" }, { verdict: "agree", resolved_politician_id: "p-b" }]);
  const r1 = await autoApplyContribution(conflict.client, "c2", applyFn);
  assertEquals(r1.status, "rejected");
  assertEquals(called, null);
  assertEquals(conflict.updates[0].patch.status, "rejected");
  assert(String(conflict.updates[0].patch.review_notes).includes("不一致"));

  const agreed = fakeWithVotes(row, [{ verdict: "agree", resolved_politician_id: "p-a" }, { verdict: "agree", resolved_politician_id: "p-a" }]);
  const r2 = await autoApplyContribution(agreed.client, "c2", applyFn);
  assertEquals(r2.status, "applied");
  assertEquals((called as unknown as ContributionRow).resolved_politician_id, "p-a");
  assertEquals(agreed.updates[0].patch.applied_politician_id, "p-a");

  const none = fakeWithVotes(row, [{ verdict: "agree", resolved_politician_id: null }, { verdict: "agree", resolved_politician_id: null }]);
  const r3 = await autoApplyContribution(none.client, "c2", async () => ({ status: "disputed" as const, message: "身份判不出" }));
  assertEquals(r3.status, "rejected");
  assertEquals(none.updates[0].patch.status, "rejected");
});

Deno.test("落庫失敗自動重試：10 分鐘後重試、最多 3 次，第 3 次仍失敗才退件；掃地機只撿到期的", async () => {
  assertEquals(planRetry(0, 0).give_up, false);
  assertEquals(planRetry(0, 0).next_retry_at, new Date(10 * 60 * 1000).toISOString());
  assertEquals(planRetry(2).give_up, true);
  assert(shouldRetry({ status: "apply_failed", retry_count: 1, next_retry_at: "2020-01-01T00:00:00Z" }));
  assert(!shouldRetry({ status: "apply_failed", retry_count: 3, next_retry_at: "2020-01-01T00:00:00Z" }), "用完額度");
  assert(!shouldRetry({ status: "apply_failed", retry_count: 0, next_retry_at: "2999-01-01T00:00:00Z" }), "還沒到");
  assert(!shouldRetry({ status: "verified", retry_count: 0, next_retry_at: "2020-01-01T00:00:00Z" }));

  const base = { id: "c3", contribution_type: "policy", payload: {}, source_urls: ["https://a"], note: null, agent_name: "u", contributor_url: null };
  const boom = async () => { throw new Error("db down"); };

  const first = fakeWithVotes({ ...base, status: "verified", retry_count: 0 }, []);
  const r1 = await autoApplyContribution(first.client, "c3", boom);
  assertEquals(r1.status, "apply_failed");
  assertEquals(first.updates[0].patch.retry_count, 1);
  assert(typeof first.updates[0].patch.next_retry_at === "string");
  assertEquals(first.updates[0].patch.last_error, "db down");

  const second = fakeWithVotes({ ...base, status: "apply_failed", retry_count: 1, next_retry_at: "2020-01-01T00:00:00Z" }, []);
  const r2 = await autoApplyContribution(second.client, "c3", boom, { retry: true });
  assertEquals(r2.status, "apply_failed");
  assertEquals(second.updates[0].patch.retry_count, 2);

  const third = fakeWithVotes({ ...base, status: "apply_failed", retry_count: 2, next_retry_at: "2020-01-01T00:00:00Z" }, []);
  const r3 = await autoApplyContribution(third.client, "c3", boom, { retry: true });
  assertEquals(r3.status, "disputed");
  assertEquals(third.updates[0].patch.retry_count, 3);
  assert(String(third.updates[0].patch.review_notes).includes("db down"));

  const ok = fakeWithVotes({ ...base, status: "apply_failed", retry_count: 1, next_retry_at: "2020-01-01T00:00:00Z" }, []);
  const r4 = await autoApplyContribution(ok.client, "c3", async () => ({ status: "applied" as const, message: "政見已建立", policy_id: "p9" }), { retry: true });
  assertEquals(r4.status, "applied");
  assertEquals(ok.updates[0].patch.last_error, null);
  assertEquals(ok.updates[0].patch.applied_policy_id, "p9");

  const notRetry = fakeWithVotes({ ...base, status: "apply_failed", retry_count: 1, next_retry_at: "2020-01-01T00:00:00Z" }, []);
  assertEquals((await autoApplyContribution(notRetry.client, "c3", boom)).triggered, false, "投票路徑不碰 apply_failed");
});

Deno.test("/next 驗證現況：policy 附 similar_policies 與重複規則；politician ambiguous 時要求指認並附 identity_candidates", () => {
  const pol = shapeVerifyCurrent("policy", { name: "陳素月", title: "長者健保全免" }, {
    politicians: [{ id: "p", name: "陳素月", party: "民主進步黨", region: "彰化縣", election_type: "縣市長", current_position: "立法委員", birth_year: 1966 }],
    policies: [{ id: "a", title: "65 歲以上長者健保費全額補助", category: "社會福利", status: "Campaign Pledge" }],
    similar_policies: [{ id: "a", title: "65 歲以上長者健保費全額補助", similarity: 0.71234 }],
  });
  assertEquals(pol.similar_policies, [{ id: "a", title: "65 歲以上長者健保費全額補助", similarity: 0.71 }]);
  assert(String(pol.hint).includes("重複於"));

  const amb = shapeVerifyCurrent("politician", { name: "陳素月" }, {
    politicians: [
      { id: "p1", name: "陳素月", party: "民主進步黨", region: "彰化縣", election_type: "縣市長", current_position: "立法委員", birth_year: 1966 },
      { id: "p2", name: "陳素月", party: "無黨籍", region: "宜蘭縣", election_type: "村里長", current_position: null, birth_year: null },
    ],
    elections: [{ politician_id: "p1", election_id: 2026, election_type: "縣市長", candidate_status: "registered", source_note: null }],
    identity: { decision: "ambiguous", politician_id: null, reason: "兩人各中一個面向", candidate_ids: ["p1", "p2"] },
  });
  assertEquals(amb.identity_pick_required, true);
  const cands = amb.identity_candidates as Array<Record<string, unknown>>;
  assertEquals(cands.length, 2);
  assertEquals(cands[0].elections, ["2026 縣市長（registered）"]);
  assert(String(amb.hint).includes("resolved_politician_id"));
  const matched = shapeVerifyCurrent("candidacy", { name: "陳素月" }, { politicians: [], identity: { decision: "matched", politician_id: "p1", reason: "", candidate_ids: ["p1"] } });
  assertEquals(matched.identity_pick_required, false);
});
