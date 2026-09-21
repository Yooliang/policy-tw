import { assert, assertEquals } from "jsr:@std/assert@1";
import { autoApplyContribution, shouldAutoApply } from "./auto-apply.ts";
import { planRevert } from "./edit-history.ts";
import { contributionStatusFor, titlesContainEachOther } from "./apply-contribution.ts";
import { buildLookup, shapeTaskCurrent, shapeVerifyCurrent, truncateFields } from "./task-context.ts";

/** 最小可用的假 supabase：只支援這裡用到的 from().select().eq().maybeSingle() 與 from().update().eq().eq() */
function fakeSupabase(row: Record<string, unknown> | null) {
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const chain = (table: string) => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
    update: (patch: Record<string, unknown>) => ({ eq: () => ({ eq: async () => { updates.push({ table, patch }); return { error: null }; } }) }),
  });
  return { client: { from: chain }, updates };
}

Deno.test("verified 才自動落庫；轉 verified 時呼叫 applyFn 並把狀態改成 applied", async () => {
  assert(shouldAutoApply("verified"));
  assert(!shouldAutoApply("pending"));
  assert(!shouldAutoApply("disputed"));

  const row = { id: "c1", contribution_type: "policy", payload: { title: "x" }, source_urls: ["https://a"], note: null, agent_name: "u", contributor_url: null, status: "verified" };
  const fake = fakeSupabase(row);
  let called = 0;
  const applyFn = async () => { called++; return { status: "applied" as const, message: "政見已建立", policy_id: "p1" }; };
  const res = await autoApplyContribution(fake.client, "c1", applyFn);
  assertEquals(called, 1);
  assertEquals(res.triggered, true);
  assertEquals(res.status, "applied");
  assertEquals(fake.updates[0].patch.status, "applied");
  assertEquals(fake.updates[0].patch.applied_policy_id, "p1");
  assert(typeof fake.updates[0].patch.applied_at === "string");

  // 不是 verified 就不動
  const notVerified = fakeSupabase({ ...row, status: "pending" });
  const res2 = await autoApplyContribution(notVerified.client, "c1", applyFn);
  assertEquals(res2.triggered, false);
  assertEquals(called, 1);

  // applyFn 丟錯 → apply_failed，不丟出
  const failing = fakeSupabase(row);
  const res3 = await autoApplyContribution(failing.client, "c1", async () => { throw new Error("boom"); });
  assertEquals(res3.status, "apply_failed");
  assertEquals(failing.updates[0].patch.status, "apply_failed");
});

Deno.test("apply 結果 → contributions.status 對應", () => {
  assertEquals(contributionStatusFor("applied"), "applied");
  assertEquals(contributionStatusFor("disputed"), "rejected", "2026-09-21：判不出／衝突退件，不留 disputed");
  assertEquals(contributionStatusFor("failed"), "apply_failed");
});

Deno.test("revert 計畫：由新到舊倒回、同欄位多次改取最原始值、INSERT 的列刪除、已還原的跳過", () => {
  const edits = [
    { id: 1, table_name: "policies", record_id: "p1", field: "status", old_value: "Proposed", new_value: "In Progress", contribution_id: "c", agent_name: "u" },
    { id: 2, table_name: "policies", record_id: "p1", field: "status", old_value: "In Progress", new_value: "Achieved", contribution_id: "c", agent_name: "u" },
    { id: 3, table_name: "tracking_logs", record_id: "t9", field: "*", old_value: null, new_value: { id: "t9" }, contribution_id: "c", agent_name: "u" },
    { id: 4, table_name: "policies", record_id: "p1", field: "progress", old_value: 10, new_value: 80, contribution_id: "c", agent_name: "u", reverted_at: "2026-09-11T00:00:00Z" },
  ];
  const steps = planRevert(edits);
  assertEquals(steps, [
    { op: "restore", table: "policies", record_id: "p1", field: "status", value: "Proposed", edit_id: 1 },
    { op: "delete", table: "tracking_logs", record_id: "t9", edit_id: 3 },
  ]);
});

Deno.test("相似標題守門（包含規則；trigram 在 SQL）", () => {
  assert(titlesContainEachOther("增設公共托育中心", "四年內增設公共托育中心 10 處"));
  assert(!titlesContainEachOther("增設公共托育中心", "捷運延伸線"));
});

Deno.test("/next 任務現況：policy_missing 帶 existing_policies 與 total；長描述截 500 字", () => {
  const cur = shapeTaskCurrent("policy_missing", {
    politician: { id: "p", name: "陳素月", party: "民主進步黨", region: "彰化縣", election_type: "縣市長", current_position: "立法委員", birth_year: 1966, avatar_url: null },
    elections: [{ election_id: 2026, election_type: "縣市長", candidate_status: "registered", source_note: "中央社" }],
    policies: [{ id: "a", title: "托育", category: "社會福利", status: "Campaign Pledge" }],
    policies_total: 1,
  });
  assertEquals((cur.existing_policies as unknown[]).length, 1);
  assertEquals(cur.existing_policies_total, 1);
  assertEquals((cur.politician as Record<string, unknown>).has_avatar, false);

  const long = "很".repeat(600);
  const stale = shapeTaskCurrent("progress_stale", { policy: { id: "x", title: "t", description: long, category: "交通建設", status: "In Progress", progress: 40, source_url: null, proposed_date: "2024-01-01", last_updated: "2025-01-01" }, politician: null, tracking_logs: [] });
  const policy = stale.policy as Record<string, unknown>;
  assertEquals((policy.description as string).length, 500);
  assertEquals(policy.truncated, true);
  assertEquals(truncateFields({ a: "short" }, ["a"]).truncated, undefined);

  const lookup = buildLookup({ politician_id: "p", policy_id: "x" });
  assert(lookup.politician.includes("id=eq.p"));
  assert(lookup.tracking_logs.includes("policy_id=eq.x"));
});

Deno.test("/next 驗證現況：policy 附該人既有政見標題；correction 附 target 現值", () => {
  const cur = shapeVerifyCurrent("policy", { name: "陳素月", title: "托育" }, {
    politicians: [{ id: "p", name: "陳素月", party: "民主進步黨", region: "彰化縣", election_type: "縣市長", current_position: "立法委員", birth_year: 1966 }],
    policies: [{ id: "a", title: "增設托育中心", category: "社會福利", status: "Campaign Pledge" }],
  });
  assertEquals((cur.existing_policy_titles as Array<Record<string, unknown>>)[0].title, "增設托育中心");
  const corr = shapeVerifyCurrent("correction", { target_table: "politicians", target_id: "p", field: "birth_year", correct_value: 1966 }, { target: { id: "p", birth_year: 1967 } });
  assertEquals(corr.current_value, 1967);
});
