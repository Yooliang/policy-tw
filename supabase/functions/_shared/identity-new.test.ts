// 身份指認 "new"：兩票都說 new → 建新人物；new 與某人混 → conflict（disputed）
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { resolveIdentityFromVotes } from "./consensus.ts";
import { validateVerifyRequest } from "./contribution-schema.ts";
import { autoApplyContribution } from "./auto-apply.ts";
import { applyContribution } from "./apply-contribution.ts";

const C1 = "11111111-1111-4111-8111-111111111111";
const P1 = "bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9";

Deno.test("指認 new：純函式與 verify schema", () => {
  assertEquals(resolveIdentityFromVotes([{ verdict: "agree", resolved_politician_id: "new" }, { verdict: "agree", resolved_politician_id: "new" }]), { kind: "new" });
  assertEquals(resolveIdentityFromVotes([{ verdict: "agree", resolved_politician_id: "new" }, { verdict: "agree", resolved_politician_id: P1 }]), { kind: "conflict", politician_ids: ["new", P1] });
  assertEquals(resolveIdentityFromVotes([{ verdict: "agree", resolved_politician_id: "new" }, { verdict: "agree", resolved_politician_id: null }]), { kind: "new" });
  const ok = validateVerifyRequest({ contribution_id: C1, verdict: "agree", agent_name: "tester", resolved_politician_id: "new" });
  assertEquals(ok.ok, true);
  assertEquals(ok.input?.resolved_politician_id, "new");
  const bad = validateVerifyRequest({ contribution_id: C1, verdict: "agree", agent_name: "tester", resolved_politician_id: "someone" });
  assertEquals(bad.errors.map((e) => e.path), ["resolved_politician_id"]);
});

Deno.test("兩票 new → 就算有同名人物也建新的（不對到既有）；new 與某人混 → 退件不硬建、不開裁決", async () => {
  const seed = {
    contributions: [{
      id: C1, contribution_type: "politician", status: "verified", agent_name: "alice", contributor_ip_hash: "ip-a", contributor_url: null, note: null, retry_count: 0,
      payload: { name: "陳素月", party: "無黨籍", region: "宜蘭縣", election_type: "村里長", birth_year: 1980 },
      source_urls: ["https://www.cec.gov.tw/x"],
    }],
    politicians: [{ id: P1, name: "陳素月", party: "民主進步黨", region: "彰化縣" }],
    politician_keys: [{ politician_id: P1, key_type: "name_region", key_value: "陳素月|彰化縣", strength: 2 }],
  };
  const both = createFakeSupabase({ ...seed, contribution_votes: [
    { contribution_id: C1, verdict: "agree", resolved_politician_id: "new" }, { contribution_id: C1, verdict: "agree", resolved_politician_id: "new" },
  ] });
  const r = await autoApplyContribution(both.client, C1);
  assertEquals(r.status, "applied");
  assertEquals(both.db.politicians.length, 2, "建了第二個陳素月");
  const created = both.db.politicians.find((p) => p.id !== P1)!;
  assertEquals(created.region, "宜蘭縣");
  assertEquals(both.db.contributions[0].applied_politician_id, created.id);
  assertEquals(both.db.contributions[0].status, "applied");
  assert(both.db.politician_keys.every((k) => k.politician_id !== P1 || k.key_value === "陳素月|彰化縣"), "沒有把新 key 掛到既有的人身上");

  const mixed = createFakeSupabase({ ...seed, contribution_votes: [
    { contribution_id: C1, verdict: "agree", resolved_politician_id: "new" }, { contribution_id: C1, verdict: "agree", resolved_politician_id: P1 },
  ] });
  const r2 = await autoApplyContribution(mixed.client, C1);
  assertEquals(r2.status, "rejected");
  assertEquals(mixed.db.politicians.length, 1, "沒有硬建人物");
  assertEquals(mixed.db.contribution_tasks.length, 0, "不開裁決任務（2026-09-21 裁示：缺口回佇列重做）");

  // 裁決者也能指認 new：applyContribution 直接帶 "new"
  const direct = createFakeSupabase(seed);
  const outcome = await applyContribution(direct.client, { ...seed.contributions[0], contribution_type: "politician", resolved_politician_id: "new" } as never);
  assertEquals(outcome.status, "applied");
  assertEquals(outcome.created_politician, true);
});
