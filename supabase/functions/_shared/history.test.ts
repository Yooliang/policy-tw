// 查核履歷：政見／人物／單筆貢獻三種對象，與完全沒有紀錄時的來源說明
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { buildHistory, buildWebRequests, collectHistory, collectWebRequests, describeOrigin, HISTORY_ENTRY_COLUMNS, pageEntries } from "./history.ts";

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
    { id: C_POLICY, contribution_type: "policy", payload: { politician_id: POL, title: "長者健保全免", description: "x".repeat(30), category: "社會福利" }, source_urls: ["https://www.cna.com.tw/a"], note: null, agent_name: "alice", agent_tool: "claude-code/opus", status: "applied", review_notes: "[auto] 政見已建立", applied_at: "2026-09-10T01:00:00Z", applied_politician_id: POL, applied_policy_id: POLICY, created_at: "2026-09-09T23:00:00Z", agree_count: 2, disagree_count: 0, unsure_count: 0, score: 3, effective_agree: 3 },
    { id: C_PROGRESS, contribution_type: "policy_progress", payload: { policy_id: POLICY, status: "In Progress", progress: 40, date: "2026-09-11", note: "預算三讀通過" }, source_urls: ["https://www.ly.gov.tw/b"], note: null, agent_name: "bob", agent_tool: null, status: "applied", review_notes: null, applied_at: "2026-09-11T02:00:00Z", applied_politician_id: null, applied_policy_id: POLICY, created_at: "2026-09-11T01:00:00Z", agree_count: 1, disagree_count: 0, unsure_count: 0 },
    { id: C_CORR, contribution_type: "correction", payload: { target_table: "policies", target_id: POLICY, field: "proposed_date", correct_value: "2024-04-02", reason: "選舉公報上的日期" }, source_urls: ["https://db.cec.gov.tw/c"], note: null, agent_name: "carol", agent_tool: null, status: "disputed", review_notes: null, applied_at: null, applied_politician_id: null, applied_policy_id: null, created_at: "2026-09-12T03:00:00Z", agree_count: 0, disagree_count: 2, unsure_count: 0, score: -2, effective_agree: 4 },
    { id: C_ADJ, contribution_type: "adjudication", payload: { contribution_id: C_CORR, verdict: "uphold", reason: "公報第 3 頁確實寫 2024-04-02，原更正正確。", checked_urls: ["https://db.cec.gov.tw/c"] }, source_urls: ["https://db.cec.gov.tw/c"], note: null, agent_name: "dave", agent_tool: null, status: "pending", review_notes: null, applied_at: null, applied_politician_id: null, applied_policy_id: null, created_at: "2026-09-12T05:00:00Z", agree_count: 1, disagree_count: 0, unsure_count: 0 },
    { id: C_PERSON, contribution_type: "politician", payload: { name: "王小明", birth_year: 1966, current_position: "立法委員" }, source_urls: ["https://www.ly.gov.tw/p"], note: null, agent_name: "erin", agent_tool: null, status: "applied", review_notes: null, applied_at: "2026-09-08T00:00:00Z", applied_politician_id: POL, applied_policy_id: null, created_at: "2026-09-07T00:00:00Z", agree_count: 1, disagree_count: 0, unsure_count: 0, score: 1, effective_agree: 1 },
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

// 查核履歷每筆帶分數與目標分數（2026-10-05，畫成跟貢獻看板一樣的拉鋸條）。
// 目標分數取 effective_agree（系統票已折進去）——C_CORR 的 4 就是 Jev 判不支持後的 3+1，不是型別矩陣的 3；
// 沒帶 effective_agree 的（C_PROGRESS）退回 requiredAgree，沒帶 score 當 0。跟 contributions-feed 同一支 contributionScore。
Deno.test("履歷每筆帶 score 與 target_score：分數可為負、目標取 effective_agree、拿不到就退回門檻矩陣", async () => {
  const fake = createFakeSupabase(seed);
  const entries = buildHistory(await collectHistory(fake.client, "policy", POLICY));
  const by = Object.fromEntries(entries.map((e) => [e.id, [e.score, e.target_score]]));
  assertEquals(by[C_POLICY], [3, 3]);
  assertEquals(by[C_CORR], [-2, 4], "負分照實回；目標是 effective_agree 的 4，不是矩陣的 3");
  assertEquals(by[C_PROGRESS], [0, 3], "沒有 score 當 0、沒有 effective_agree 退回 requiredAgree（官方來源一般型別 3）");
});

Deno.test("履歷查貢獻時要撈 score 與 effective_agree 兩欄（計算欄位不撈就永遠退回矩陣，畫面上的目標會悄悄不一樣）", () => {
  for (const col of ["score", "effective_agree"]) assert(HISTORY_ENTRY_COLUMNS.split(", ").includes(col), `HISTORY_ENTRY_COLUMNS 要含 ${col}`);
});

Deno.test("沒有任何貢獻紀錄：entries 空、origin 用匯入的 source_url／source_note 說明；完全沒來源也講清楚", async () => {
  const fake = createFakeSupabase({
    // 出處在出處表（#347 第二階段 B）：來源說明讀 source_brief_list，不讀 policies.source_url
    policies: [{ id: POLICY, title: "x", ai_extracted: true }],
    politicians: [{ id: POL, name: "王小明" }],
    politician_elections: [{ id: 1, politician_id: POL, source_note: "中央社 2026-09-04 登記參選名單" }, { id: 2, politician_id: POL, source_note: "中央社 2026-09-04 登記參選名單" }],
    contributions: [], contribution_votes: [], edit_history: [], contribution_tasks: [], tracking_logs: [],
  }, { source_brief_list: () => [{ url: "https://www.cec.gov.tw/bulletin.pdf", role: "primary", kind: "official", self_evidence: null, archive_url: null }] });
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

Deno.test("履歷每筆帶 detail：去掉「為誰新增政見」「把政見的」這種頁面已經講過的前綴，summary 保持完整", async () => {
  const fake = createFakeSupabase(seed);
  const entries = buildHistory(await collectHistory(fake.client, "politician", POL));
  const byType = (t: string) => entries.find((e) => e.contribution_type === t)!;
  const policy = byType("policy");
  assertEquals(policy.summary, "為「王小明」新增政見：長者健保全免");
  assertEquals(policy.detail, "長者健保全免");
  const pol = buildHistory(await collectHistory(fake.client, "policy", POLICY));
  const progress = pol.find((e) => e.contribution_type === "policy_progress")!;
  assert(progress.summary.startsWith("更新「長者健保全免」進度"));
  assertEquals(progress.detail.startsWith("進度為"), true);
  for (const e of entries) assert(typeof e.detail === "string" && e.detail.length > 0, `${e.contribution_type} 沒有 detail`);
});

// ── 蘇清吉（高雄市路竹區鴨寮里，politician_elections.id 36770）：10-07 名冊清查新增整列、10-18 補政黨 ──
const SU = "aaaaaaaa-0000-4000-8000-000000000036";
const mkCand = (id: string, over: Record<string, unknown>) => ({
  id, contribution_type: "candidacy", source_urls: ["https://example.test/s"], note: null, agent_tool: null, status: "applied", review_notes: null,
  applied_politician_id: SU, applied_policy_id: null, agree_count: 3, disagree_count: 0, unsure_count: 0, ...over,
});
const suData = (partyName: string | null, lookupParties: Record<string, string> = {}) => ({
  contributions: [
    mkCand("c-1007", { payload: { name: "蘇清吉", election_id: 2026, region: "高雄市", election_type: "村里長", candidate_status: "registered" }, agent_name: "roster-a", created_at: "2026-10-07T01:00:00Z", applied_at: "2026-10-07T02:00:00Z", task_id: "auto:roster_check:2026:高雄市路竹區:村里長" }),
    mkCand("c-1018", { payload: { name: "蘇清吉", election_id: 2026, region: "高雄市", election_type: "村里長", candidate_status: "registered", ...(partyName ? { party: partyName } : {}) }, agent_name: "party-b", created_at: "2026-10-18T01:00:00Z", applied_at: "2026-10-18T02:00:00Z", task_id: "auto:candidacy_source_missing:party:36770" }),
  ],
  votes: [], adjudications: [], tasks: [],
  edits: [
    { id: 1, contribution_id: "c-1007", table_name: "politician_elections", record_id: "36770", field: "*", old_value: null, new_value: { id: 36770, candidacy_status: "filed" }, applied_at: "2026-10-07T02:00:00Z", reverted_at: null, reverted_by: null },
    { id: 2, contribution_id: "c-1018", table_name: "politician_elections", record_id: "36770", field: "source_note", old_value: "舊", new_value: "新", applied_at: "2026-10-18T02:00:00Z", reverted_at: null, reverted_by: null },
    { id: 3, contribution_id: "c-1018", table_name: "politician_elections", record_id: "36770", field: "party_id", old_value: null, new_value: null, applied_at: "2026-10-18T02:00:00Z", reverted_at: null, reverted_by: null },
    { id: 4, contribution_id: "c-1018", table_name: "politician_elections", record_id: "36770", field: "party_basis", old_value: null, new_value: "contribution", applied_at: "2026-10-18T02:00:00Z", reverted_at: null, reverted_by: null },
  ],
  summary_lookup: { politicians: { [SU]: "蘇清吉" }, parties: lookupParties },
});

Deno.test("履歷：補政黨的 candidacy（edits 沒有整列新增、沒有狀態變動）標題講推薦政黨，不寫「參選狀態改為」；10-07 整列新增那筆照舊", () => {
  const entries = buildHistory(suData("無") as never);
  const [party, created] = entries;
  assertEquals(created.id, "c-1007");
  assertEquals(created.summary, "將 蘇清吉 2026 高雄市村里長參選狀態改為「已登記」");
  assertEquals(party.id, "c-1018");
  assert(!party.summary.includes("參選狀態改為"), party.summary);
  assert(party.summary.includes("推薦政黨"), party.summary);
  assertEquals(party.summary, "補上這一屆的推薦政黨：無黨籍");
  assertEquals(party.detail, "推薦政黨：無黨籍");
  // 欄位名與值：不印 id，party_id 空而依據有值＝無黨籍
  const [, pid, basis] = party.edits.slice(0, 3).map((e) => e);
  assertEquals([pid.field_label, pid.new_value], ["推薦政黨", "無黨籍"]);
  assertEquals([basis.field_label, basis.new_value], ["政黨依據", "交件"]);
});

Deno.test("履歷：補的是有 id 的政黨 → 值換成政黨名稱；對照表沒有就「（已記錄）」、標題退回交件的政黨文字", () => {
  const withName = suData("中國國民黨", { "1": "中國國民黨" });
  withName.edits[2] = { ...withName.edits[2], new_value: 1 as never };
  const a = buildHistory(withName as never)[0];
  assertEquals(a.summary, "補上這一屆的推薦政黨：中國國民黨");
  assertEquals(a.edits.find((e) => e.field === "party_id")?.new_value, "中國國民黨");

  const noLookup = suData("中國國民黨");
  noLookup.edits[2] = { ...noLookup.edits[2], new_value: 1 as never };
  const b = buildHistory(noLookup as never)[0];
  assertEquals(b.edits.find((e) => e.field === "party_id")?.new_value, "（已記錄）");
  assert(!JSON.stringify(b.edits).includes('"new_value":1'), "不印 id");
  assertEquals(b.summary, "補上這一屆的推薦政黨：中國國民黨");
});

Deno.test("履歷：candidacy 有 candidacy_status 變動或整列新增時，仍用交件的參選狀態句子", () => {
  const d = suData("無");
  d.edits = [{ ...d.edits[1], field: "candidacy_status", old_value: "declared", new_value: "filed" }];
  assertEquals(buildHistory(d as never)[0].summary, "將 蘇清吉 2026 高雄市村里長參選狀態改為「已登記」，推薦政黨「無黨籍」");
});

Deno.test("履歷的網站請求：新到舊、標清楚查什麼與狀態；停放中標等公報；已結束標已處理；不帶任何來源識別", () => {
  const rows = [
    { id: "r1", task_type: "policy_missing", status: "open", created_at: "2026-10-20T01:00:00Z", closed_at: null },
    { id: "r2", task_type: "profile_gap", status: "closed", created_at: "2026-10-25T01:00:00Z", closed_at: "2026-10-26T01:00:00Z" },
    { id: "r3", task_type: "policy_missing", status: "open", created_at: "2026-10-27T01:00:00Z", closed_at: null },
    { id: "r4", task_type: "mystery", status: "open", created_at: "2026-10-01T01:00:00Z", closed_at: null },
  ];
  const out = buildWebRequests(rows, new Set(["r3"]));
  assertEquals(out.map((r) => r.id), ["r3", "r2", "r1", "r4"], "新到舊");
  assertEquals(out[0], { id: "r3", task_type: "policy_missing", kind_label: "查承諾與政見", status: "parked", status_label: "等官方選舉公報上架後處理", created_at: "2026-10-27T01:00:00Z", closed_at: null, reports: [] });
  assertEquals([out[1]!.status, out[1]!.status_label, out[1]!.kind_label], ["closed", "已處理完", "查簡介與學經歷"]);
  assertEquals([out[2]!.status, out[2]!.status_label], ["open", "排隊處理中"]);
  assertEquals(out[3]!.kind_label, "查資料", "不認得的任務型別有預設說法");
  // 已結束的就算在停放名單裡也不標停放
  assertEquals(buildWebRequests([rows[1]!], new Set(["r2"]))[0]!.status, "closed");
  for (const r of out) assertEquals(Object.keys(r).sort(), ["closed_at", "created_at", "id", "kind_label", "reports", "status", "status_label", "task_type"]);
});

Deno.test("履歷的網站請求：只有人物與政見對象會撈；貢獻、提問對象直接回空，不碰資料庫", async () => {
  const boom = { from: () => { throw new Error("不該查"); }, rpc: () => { throw new Error("不該查"); } };
  assertEquals(await collectWebRequests(boom, "contribution", C_POLICY), []);
  assertEquals(await collectWebRequests(boom, "question", C_POLICY), []);
});

Deno.test("履歷的網站請求：掛在任務上的貢獻（task_id 欄或 no_change 的 payload.task_id）列在展開用的 reports，新到舊", () => {
  const rows = [{ id: "r1", task_type: "policy_missing", status: "open", created_at: "2026-10-20T01:00:00Z", closed_at: null }, { id: "r2", task_type: "profile_gap", status: "open", created_at: "2026-10-21T01:00:00Z", closed_at: null }];
  const out = buildWebRequests(rows, new Set(), [
    { id: "c1", task_id: "r1", contribution_type: "policy", status: "applied", created_at: "2026-10-21T00:00:00Z", agent_name: "a1" },
    { id: "c2", task_id: null, payload: { task_id: "r1" }, contribution_type: "no_change", status: "pending", created_at: "2026-10-22T00:00:00Z", agent_name: "a2" },
    { id: "c3", task_id: "other", contribution_type: "policy", status: "applied", created_at: "2026-10-22T00:00:00Z", agent_name: "a3" },
  ]);
  const r1 = out.find((r) => r.id === "r1")!;
  assertEquals(r1.reports.map((x) => x.id), ["c2", "c1"], "新到舊、只收掛在這個任務上的");
  assertEquals(r1.reports[0]!.agent_name, "a2");
  assertEquals(out.find((r) => r.id === "r2")!.reports, []);
  assert(!JSON.stringify(out).includes("ip_hash"));
});

Deno.test("履歷：號次交件（payload.cand_no 正整數）標題與摘要把號次寫在地區／選舉別之後；沒有或不是正整數的文字與原本一模一樣", () => {
  const mk = (candNo: unknown) => buildHistory({
    contributions: [mkCand("c-no", { payload: { name: "董宜忠", region: "宜蘭縣", sub_region: "大同鄉", village: "茂安村", election_id: 2026, election_type: "村里長", candidate_status: "registered", ...(candNo === undefined ? {} : { cand_no: candNo }) }, agent_name: "n", created_at: "2026-10-29T01:00:00Z", applied_at: "2026-10-29T02:00:00Z" })],
    votes: [], adjudications: [], tasks: [], edits: [],
    summary_lookup: { politicians: { [SU]: "董宜忠" } },
  } as never)[0];
  const base = "將 董宜忠 2026 宜蘭縣村里長參選狀態改為「已登記」";
  const withNo = mk(1);
  assertEquals(withNo.summary, "將 董宜忠 2026 宜蘭縣村里長 號次 1・參選狀態改為「已登記」");
  assertEquals(withNo.detail, "2026 宜蘭縣村里長 號次 1・參選狀態改為「已登記」");
  assertEquals(mk(undefined).summary, base);
  for (const bad of ["1", 0, -3, 1.5, null]) assertEquals(mk(bad).summary, base, `cand_no=${JSON.stringify(bad)}`);
});
