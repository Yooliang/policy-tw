// 查核履歷：政見／人物／單筆貢獻三種對象，與完全沒有紀錄時的來源說明
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { buildHistory, collectHistory, describeOrigin, pageEntries } from "./history.ts";

const POL = "bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9";
const POLICY = "0c9c1a5e-1111-4222-8333-444444444444";
const C_POLICY = "11111111-1111-4111-8111-111111111111";
const C_PROGRESS = "22222222-2222-4222-8222-222222222222";
const C_CORR = "33333333-3333-4333-8333-333333333333";
const C_ADJ = "44444444-4444-4444-8444-444444444444";
const C_PERSON = "55555555-5555-4555-8555-555555555555";
const C_CAND = "66666666-6666-4666-8666-666666666666";

const seed = {
  policies: [{ id: POLICY, title: "長者健保全免", politician_id: POL, source_url: "https://www.cna.com.tw/a", ai_extracted: false }],
  politicians: [{ id: POL, name: "王小明" }],
  politician_elections: [{ id: 901, politician_id: POL, election_id: 2026, candidate_status: "registered", source_note: "中央社 2026-09-04 登記參選名單" }],
  tracking_logs: [{ id: "t1", policy_id: POLICY, event: "預算通過" }],
  contributions: [
    { id: C_POLICY, contribution_type: "policy", payload: { politician_id: POL, title: "長者健保全免", description: "x".repeat(30), category: "社會福利" }, source_urls: ["https://www.cna.com.tw/a"], note: null, agent_name: "alice", agent_tool: "claude-code/opus", status: "applied", review_notes: "[auto] 政見已建立", applied_at: "2026-09-10T01:00:00Z", applied_politician_id: POL, applied_policy_id: POLICY, created_at: "2026-09-09T23:00:00Z", agree_count: 2, disagree_count: 0, unsure_count: 0 },
    { id: C_PROGRESS, contribution_type: "policy_progress", payload: { policy_id: POLICY, status: "In Progress", progress: 40, date: "2026-09-11", note: "預算三讀通過" }, source_urls: ["https://www.ly.gov.tw/b"], note: null, agent_name: "bob", agent_tool: null, status: "applied", review_notes: null, applied_at: "2026-09-11T02:00:00Z", applied_politician_id: null, applied_policy_id: POLICY, created_at: "2026-09-11T01:00:00Z", agree_count: 1, disagree_count: 0, unsure_count: 0 },
    { id: C_CORR, contribution_type: "correction", payload: { target_table: "policies", target_id: POLICY, field: "proposed_date", correct_value: "2024-04-02", reason: "選舉公報上的日期" }, source_urls: ["https://db.cec.gov.tw/c"], note: null, agent_name: "carol", agent_tool: null, status: "disputed", review_notes: null, applied_at: null, applied_politician_id: null, applied_policy_id: null, created_at: "2026-09-12T03:00:00Z", agree_count: 0, disagree_count: 2, unsure_count: 0 },
    { id: C_ADJ, contribution_type: "adjudication", payload: { contribution_id: C_CORR, verdict: "uphold", reason: "公報第 3 頁確實寫 2024-04-02，原更正正確。", checked_urls: ["https://db.cec.gov.tw/c"] }, source_urls: ["https://db.cec.gov.tw/c"], note: null, agent_name: "dave", agent_tool: null, status: "pending", review_notes: null, applied_at: null, applied_politician_id: null, applied_policy_id: null, created_at: "2026-09-12T05:00:00Z", agree_count: 1, disagree_count: 0, unsure_count: 0 },
    { id: C_PERSON, contribution_type: "politician", payload: { name: "王小明", birth_year: 1966, current_position: "立法委員" }, source_urls: ["https://www.ly.gov.tw/p"], note: null, agent_name: "erin", agent_tool: null, status: "applied", review_notes: null, applied_at: "2026-09-08T00:00:00Z", applied_politician_id: POL, applied_policy_id: null, created_at: "2026-09-07T00:00:00Z", agree_count: 1, disagree_count: 0, unsure_count: 0 },
    { id: C_CAND, contribution_type: "candidacy", payload: { name: "王小明", election_id: 2026, election_type: "縣市長", region: "彰化縣", candidate_status: "registered" }, source_urls: ["https://www.cna.com.tw/d"], note: null, agent_name: "frank", agent_tool: null, status: "reverted", review_notes: "[revert by xiaoliang] 還原 1 個變更", applied_at: "2026-09-06T00:00:00Z", applied_politician_id: POL, applied_policy_id: null, created_at: "2026-09-05T00:00:00Z", agree_count: 6, disagree_count: 0, unsure_count: 0 },
  ],
  contribution_votes: [
    { contribution_id: C_POLICY, verdict: "agree", note: null, evidence_url: null, agent_name: "bob", agent_tool: "gemini-cli/2.5", resolved_politician_id: null, created_at: "2026-09-10T00:30:00Z", verifier_ip_hash: "secret" },
    { contribution_id: C_POLICY, verdict: "agree", note: "中央社報導第二段", evidence_url: null, agent_name: "carol", agent_tool: null, resolved_politician_id: null, created_at: "2026-09-10T00:50:00Z", verifier_ip_hash: "secret" },
    { contribution_id: C_CORR, verdict: "disagree", note: "公報寫的是 2026-05-26", evidence_url: "https://db.cec.gov.tw/x", agent_name: "bob", agent_tool: null, resolved_politician_id: null, created_at: "2026-09-12T03:10:00Z", verifier_ip_hash: "secret" },
    { contribution_id: C_CORR, verdict: "disagree", note: "同上", evidence_url: "https://db.cec.gov.tw/y", agent_name: "erin", agent_tool: null, resolved_politician_id: null, created_at: "2026-09-12T03:20:00Z", verifier_ip_hash: "secret" },
  ],
  edit_history: [
    { id: 1, contribution_id: C_POLICY, table_name: "policies", record_id: POLICY, field: "*", old_value: null, new_value: { id: POLICY, title: "長者健保全免" }, applied_at: "2026-09-10T01:00:00Z", reverted_at: null, reverted_by: null },
    { id: 2, contribution_id: C_PROGRESS, table_name: "policies", record_id: POLICY, field: "progress", old_value: 10, new_value: 40, applied_at: "2026-09-11T02:00:00Z", reverted_at: null, reverted_by: null },
    { id: 3, contribution_id: C_PROGRESS, table_name: "tracking_logs", record_id: "t1", field: "*", old_value: null, new_value: { id: "t1", policy_id: POLICY }, applied_at: "2026-09-11T02:00:00Z", reverted_at: null, reverted_by: null },
    { id: 4, contribution_id: C_PERSON, table_name: "politicians", record_id: POL, field: "birth_year", old_value: null, new_value: 1966, applied_at: "2026-09-08T00:00:00Z", reverted_at: null, reverted_by: null },
    { id: 5, contribution_id: C_CAND, table_name: "politician_elections", record_id: "901", field: "candidate_status", old_value: "confirmed", new_value: "registered", applied_at: "2026-09-06T00:00:00Z", reverted_at: "2026-09-07T12:00:00Z", reverted_by: "xiaoliang" },
  ],
  contribution_tasks: [
    { id: "task-adj", task_type: "adjudicate", status: "open", target: { contribution_id: C_CORR }, created_at: "2026-09-12T03:21:00Z", closed_at: null },
  ],
};

Deno.test("政見履歷：新增政見、進度更新、更正（裁決中）依時間新到舊；驗證者與理由、欄位舊值新值、裁決任務都在；不回 ip_hash", async () => {
  const fake = createFakeSupabase(seed);
  const data = await collectHistory(fake.client, "policy", POLICY);
  const entries = buildHistory(data);
  assertEquals(entries.map((e) => e.type_label), ["更正", "進度更新", "新增政見"]);
  const corr = entries[0];
  assertEquals(corr.status_label, "裁決中");
  assertEquals(corr.verifiers.map((v) => `${v.agent_name}:${v.verdict}`), ["bob:disagree", "erin:disagree"]);
  assertEquals(corr.verifiers[0].evidence_url, "https://db.cec.gov.tw/x");
  assertEquals(corr.adjudications.length, 1);
  assertEquals(corr.adjudications[0].task_id, "task-adj");
  assertEquals(corr.adjudications[0].verdict, "uphold");
  assertEquals(corr.adjudications[0].agent_name, "dave");
  const progress = entries[1];
  assertEquals(progress.edits.map((e) => `${e.table}.${e.field}`), ["policies.progress", "tracking_logs.*"]);
  assertEquals(progress.edits[0].field_label, "進度");
  assertEquals([progress.edits[0].old_value, progress.edits[0].new_value], [10, 40]);
  const created = entries[2];
  assertEquals(created.summary, "為「王小明」新增政見：長者健保全免");
  assertEquals(created.verifiers.length, 2);
  assertEquals(created.verifiers[0].agent_tool, "gemini-cli/2.5");
  assert(!JSON.stringify(entries).includes("secret"), "不回 ip_hash");
  assert(!entries.some((e) => e.contribution_type === "adjudication"), "裁決掛在原貢獻上，不另列");
});

Deno.test("人物履歷：含只靠 edit_history（參選紀錄子列）對應到的貢獻；被還原的標 reverted；更正摘要用欄位舊值新值", async () => {
  const fake = createFakeSupabase(seed);
  const entries = buildHistory(await collectHistory(fake.client, "politician", POL));
  assertEquals(entries.map((e) => e.type_label), ["新增政見", "更新人物欄位", "參選狀態"]);
  const person = entries[1];
  assertEquals(person.summary, "補上出生年");
  const cand = entries[2];
  assertEquals(cand.reverted, true);
  assertEquals(cand.edits[0].reverted_by, "xiaoliang");
  assertEquals(cand.status_label, "已還原");

  const corrOnly = buildHistory({ contributions: [seed.contributions[2] as never], votes: [], edits: [{ id: 9, contribution_id: C_CORR, table_name: "policies", record_id: POLICY, field: "proposed_date", old_value: "2026-05-26", new_value: "2024-04-02", applied_at: "2026-09-12T06:00:00Z", reverted_at: null, reverted_by: null }], adjudications: [], tasks: [] });
  assertEquals(corrOnly[0].summary, "把政見的提出日期從「2026-05-26」改為「2024-04-02」");
});

Deno.test("單筆貢獻：target=contribution 只回那一筆（含驗證者與裁決）；分頁 cursor", async () => {
  const fake = createFakeSupabase(seed);
  const entries = buildHistory(await collectHistory(fake.client, "contribution", C_CORR));
  assertEquals(entries.length, 1);
  assertEquals(entries[0].id, C_CORR);
  assertEquals(entries[0].verifiers.length, 2);
  assertEquals(entries[0].adjudications[0].reason?.includes("2024-04-02"), true);

  const all = buildHistory(await collectHistory(fake.client, "policy", POLICY));
  const p1 = pageEntries(all, 2, null);
  assertEquals(p1.items.length, 2);
  assertEquals(p1.has_more, true);
  const p2 = pageEntries(all, 2, p1.next_cursor);
  assertEquals(p2.items.map((e) => e.id), [C_POLICY]);
  assertEquals(p2.has_more, false);
});

Deno.test("沒有任何貢獻紀錄：entries 空、origin 用匯入的 source_url／source_note 說明；完全沒來源也講清楚", async () => {
  const fake = createFakeSupabase({
    policies: [{ id: POLICY, title: "x", source_url: "https://www.cec.gov.tw/bulletin.pdf", ai_extracted: true }],
    politicians: [{ id: POL, name: "王小明" }],
    politician_elections: [{ id: 1, politician_id: POL, source_note: "中央社 2026-09-04 登記參選名單" }, { id: 2, politician_id: POL, source_note: "中央社 2026-09-04 登記參選名單" }],
    contributions: [], contribution_votes: [], edit_history: [], contribution_tasks: [], tracking_logs: [],
  });
  const policyData = await collectHistory(fake.client, "policy", POLICY);
  assertEquals(buildHistory(policyData), []);
  const policyOrigin = describeOrigin("policy", policyData.origin_row, [], false);
  assertEquals(policyOrigin.kind, "imported");
  assertEquals(policyOrigin.source_url, "https://www.cec.gov.tw/bulletin.pdf");
  assert(policyOrigin.note?.includes("AI 搜尋匯入"));

  const polData = await collectHistory(fake.client, "politician", POL);
  const polOrigin = describeOrigin("politician", polData.origin_row, polData.election_notes, false);
  assertEquals(polOrigin.kind, "imported");
  assertEquals(polOrigin.source_notes, ["中央社 2026-09-04 登記參選名單"], "同一備註去重");

  const bare = describeOrigin("policy", { id: POLICY, source_url: null, ai_extracted: false }, [], false);
  assertEquals(bare.kind, "unknown");
  assert(bare.note?.includes("也沒有記錄來源"));
});
