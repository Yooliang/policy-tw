// correction 多欄位：schema、門檻取最高、逐欄 edit_history、舊格式相容
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { normalizeCorrection } from "./correction.ts";
import { validateContributionRequest } from "./contribution-schema.ts";
import { requiredAgree, riskLevel } from "./consensus.ts";
import { applyContribution } from "./apply-contribution.ts";
import { summarizeContribution } from "./contribution-summary.ts";
import { shapeVerifyCurrent } from "./task-context.ts";

const POLICY = "0c9c1a5e-1111-4222-8333-444444444444";
const PE = "901";
const CEC = "https://db.cec.gov.tw/ElecTable/Election/ElecTickets";
const MEDIA = "https://www.cna.com.tw/news/aipl/1.aspx";

Deno.test("多欄位 schema：changes 陣列可過、欄位要在白名單且不重複、correct_value 必填；舊單欄位格式仍可過並正規化成 changes", () => {
  const multi = validateContributionRequest({
    agent_name: "tester", contribution_type: "correction",
    payload: { target_table: "policies", target_id: POLICY, changes: [
      { field: "source_url", current_value: "https://old.example", correct_value: "https://www.cec.gov.tw/bulletin.pdf" },
      { field: "description", correct_value: "第一期候車亭 12 座已於 2026-03-15 驗收，第二期 8 座預計 2026-12 完工。" },
    ], reason: "選舉公報與市府新聞稿都寫明分期座數與驗收日期" },
    source_urls: [CEC],
  });
  assertEquals(multi.errors, []);
  assertEquals(normalizeCorrection(multi.items[0].payload).changes.map((c) => c.field), ["source_url", "description"]);

  const legacy = validateContributionRequest({
    agent_name: "tester", contribution_type: "correction",
    payload: { target_table: "policies", target_id: POLICY, field: "proposed_date", current_value: "2026-05-26", correct_value: "2024-04-02", reason: "選舉公報上的提出日期是 2024-04-02" },
    source_urls: [CEC],
  });
  assertEquals(legacy.errors, []);
  assertEquals(normalizeCorrection(legacy.items[0].payload).changes, [{ field: "proposed_date", current_value: "2026-05-26", correct_value: "2024-04-02" }]);

  const bad = validateContributionRequest({
    agent_name: "tester", contribution_type: "correction",
    payload: { target_table: "policies", target_id: POLICY, changes: [
      { field: "source_url", correct_value: "https://a" }, { field: "source_url", correct_value: "https://b" }, { field: "progress", correct_value: 50 }, { field: "title" },
    ], reason: "重複欄位、白名單外欄位、缺值都要被擋" },
    source_urls: [CEC],
  });
  assertEquals(bad.errors.map((e) => e.path).sort(), ["payload.changes[1].field", "payload.changes[2].field", "payload.changes[3].correct_value"]);
  const empty = validateContributionRequest({ agent_name: "tester", contribution_type: "correction", payload: { target_table: "policies", target_id: POLICY, changes: [], reason: "什麼都沒改的更正不成立" }, source_urls: [CEC] });
  assertEquals(empty.errors.map((e) => e.path), ["payload.changes"]);
});

Deno.test("門檻取最高風險：含 candidate_status 就走加減參選人級距（媒體 6／官方 4）；一般欄位照一般級距", () => {
  const mixed = { target_table: "politician_elections", target_id: PE, changes: [{ field: "position", correct_value: "縣市長候選人" }, { field: "candidate_status", correct_value: "withdrawn" }], reason: "中選會公告退選，職位也一併更正" };
  assertEquals(riskLevel("correction", mixed), "high");
  assertEquals(requiredAgree("correction", mixed, [MEDIA]), 6);
  assertEquals(requiredAgree("correction", mixed, [CEC]), 4);
  const plain = { target_table: "policies", target_id: POLICY, changes: [{ field: "source_url", correct_value: "https://x" }, { field: "description", correct_value: "y" }], reason: "兩個一般欄位" };
  assertEquals(riskLevel("correction", plain), "normal");
  assertEquals(requiredAgree("correction", plain, [MEDIA]), 2);
  assertEquals(riskLevel("correction", { target_table: "politician_elections", target_id: PE, field: "candidate_status", correct_value: "withdrawn" }), "high", "舊格式");
});

Deno.test("落庫：逐欄套用並各寫一筆 edit_history（舊值→新值）；摘要與派工現況列出每個欄位", async () => {
  const fake = createFakeSupabase({
    policies: [{ id: POLICY, title: "候車亭改建", source_url: "https://old.example", description: "舊描述", category: "交通建設" }],
    edit_history: [],
  });
  const row = {
    id: "c-1", contribution_type: "correction" as const, source_urls: [CEC], note: null, agent_name: "tester", contributor_url: null,
    payload: { target_table: "policies", target_id: POLICY, changes: [
      { field: "source_url", current_value: "https://old.example", correct_value: "https://www.cec.gov.tw/bulletin.pdf" },
      { field: "description", correct_value: "第一期候車亭 12 座已於 2026-03-15 驗收。" },
    ], reason: "公報與新聞稿" },
  };
  const outcome = await applyContribution(fake.client, row);
  assertEquals(outcome.status, "applied");
  assertEquals(outcome.policy_id, POLICY);
  const policy = fake.db.policies[0];
  assertEquals(policy.source_url, "https://www.cec.gov.tw/bulletin.pdf");
  assertEquals(policy.description, "第一期候車亭 12 座已於 2026-03-15 驗收。");
  assertEquals(policy.title, "候車亭改建", "沒動到的欄位不變");
  const edits = fake.db.edit_history.filter((e) => e.contribution_id === "c-1");
  assertEquals(edits.map((e) => [e.field, e.old_value, e.new_value]), [
    ["source_url", "https://old.example", "https://www.cec.gov.tw/bulletin.pdf"],
    ["description", "舊描述", "第一期候車亭 12 座已於 2026-03-15 驗收。"],
  ]);
  assert(String(outcome.message).includes("更正 2 個欄位"));

  const s = summarizeContribution({ contribution_type: "correction", payload: row.payload });
  assert(s.summary.startsWith("更正政見") && s.summary.includes("來源網址") && s.summary.includes("內容"), s.summary);
  const current = shapeVerifyCurrent("correction", row.payload, { target: { id: POLICY, source_url: "https://old.example", description: "舊描述" } });
  assertEquals((current.changes as Array<Record<string, unknown>>).map((c) => [c.field, c.db_current]), [["source_url", "https://old.example"], ["description", "舊描述"]]);
  assertEquals(current.field, "source_url", "第一欄仍放在 field／current_value 維持相容");

  // 舊格式落庫
  const legacy = createFakeSupabase({ policies: [{ id: POLICY, proposed_date: "2026-05-26" }], edit_history: [] });
  const o2 = await applyContribution(legacy.client, { ...row, id: "c-2", payload: { target_table: "policies", target_id: POLICY, field: "proposed_date", correct_value: "2024-04-02", reason: "選舉公報上的提出日期是 2024-04-02" } });
  assertEquals(o2.status, "applied");
  assertEquals(legacy.db.policies[0].proposed_date, "2024-04-02");
  assertEquals(legacy.db.edit_history.length, 1);
});
