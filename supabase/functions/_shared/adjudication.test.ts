// 零常態人工點：爭議自動變裁決任務，4 票同向定案；來源等級門檻
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { buildAdjudicationTask, ensureAdjudicationTask, findOpenAdjudicationTask } from "./adjudication.ts";
import { applyContribution } from "./apply-contribution.ts";
import { autoApplyContribution } from "./auto-apply.ts";
import { validateContributionRequest } from "./contribution-schema.ts";
import { requiredAgree } from "./consensus.ts";
import { excludeOwnAdjudications, filterAdjudicateTasks } from "./dispatch.ts";

const CNA = "https://www.cna.com.tw/news/aipl/202609045002.aspx";
const CEC = "https://db.cec.gov.tw/ElecTable/Election/ElecTickets?x=1";
const PID = "bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9";
const C1 = "11111111-1111-4111-8111-111111111111";
const A1 = "22222222-2222-4222-8222-222222222222";
const A2 = "33333333-3333-4333-8333-333333333333";

const disputedPolicy = {
  id: C1, contribution_type: "policy", status: "disputed", agent_name: "alice", contributor_ip_hash: "ip-a",
  payload: { politician_id: PID, title: "長者健保全免", description: "65 歲以上長者健保費由市府全額補助，四年內逐步實施。", category: "社會福利" },
  source_urls: [CNA], note: null, contributor_url: null, review_notes: null, last_error: null,
};
const votes = [
  { contribution_id: C1, verdict: "disagree", evidence_url: CEC, note: "選舉公報沒有這條", agent_name: "bob", resolved_politician_id: null },
  { contribution_id: C1, verdict: "disagree", evidence_url: "https://www.pts.org.tw/x", note: "報導寫的是補助一半", agent_name: "carol", resolved_politician_id: null },
];

Deno.test("disputed 自動建裁決任務：hint_sources 併正反來源、target 帶 contribution_id 與提交者；冪等；adjudication 本身不建", async () => {
  const task = buildAdjudicationTask(disputedPolicy, votes, "兩票反對");
  assertEquals(task.task_type, "adjudicate");
  assertEquals(task.hint_sources, [CNA, CEC, "https://www.pts.org.tw/x"]);
  assertEquals(task.target_contribution_id, C1);
  assertEquals(task.target_extra?.contributor, "alice");
  assert(String(task.description).includes("選舉公報沒有這條") && String(task.description).includes("uphold"));

  const fake = createFakeSupabase({ contributions: [disputedPolicy], contribution_votes: votes });
  const first = await ensureAdjudicationTask(fake.client, C1, "兩票反對");
  assertEquals(first.created, true);
  const open = await findOpenAdjudicationTask(fake.client, C1);
  assert(open, "任務在 contribution_tasks");
  const row = fake.db.contribution_tasks[0];
  assertEquals(row.source, "auto_dispute");
  assertEquals(row.priority, 2);
  assertEquals((row.target as Record<string, unknown>).contribution_id, C1);

  const second = await ensureAdjudicationTask(fake.client, C1, "兩票反對");
  assertEquals(second.created, false, "已有 open 任務就不再建");
  assertEquals(fake.db.contribution_tasks.length, 1);

  fake.db.contributions.push({ id: A1, contribution_type: "adjudication", status: "disputed", payload: { contribution_id: C1 }, source_urls: [CEC], agent_name: "dave" });
  assertEquals((await ensureAdjudicationTask(fake.client, A1, "兩票反對")).skipped, "adjudication_itself");
  assertEquals(fake.db.contribution_tasks.length, 1, "裁決被爭議不會再建任務（原任務保持 open）");
});

Deno.test("adjudication schema：contribution_id／verdict／reason≥20／checked_urls 必填，source_urls 可省略；門檻不看來源一律 4", () => {
  const ok = validateContributionRequest({
    agent_name: "dave", contribution_type: "adjudication",
    payload: { contribution_id: C1, verdict: "uphold", reason: "打開中央社與選舉公報，公報第 3 頁確實列了長者健保全免，原貢獻正確。", checked_urls: [CNA, CEC] },
  });
  assertEquals(ok.errors, []);
  assertEquals(ok.items[0].source_urls, [CNA, CEC]);
  const bad = validateContributionRequest({ agent_name: "dave", contribution_type: "adjudication", payload: { verdict: "maybe", reason: "太短" }, source_urls: [CNA] });
  assertEquals(bad.errors.map((e) => e.path).sort(), ["payload.checked_urls", "payload.contribution_id", "payload.reason", "payload.verdict"]);
  assertEquals(requiredAgree("adjudication", {}, [CEC]), 4);
  assertEquals(requiredAgree("adjudication", {}, ["https://example.org/x"]), 4);
});

function adjudicationRow(id: string, verdict: string, agent: string, status = "verified") {
  return {
    id, contribution_type: "adjudication", status, agent_name: agent, contributor_ip_hash: `ip-${agent}`, contributor_url: null, note: null,
    payload: { contribution_id: C1, verdict, reason: "打開中央社與選舉公報，公報第 3 頁確實列了長者健保全免，原貢獻正確。", checked_urls: [CNA, CEC] },
    source_urls: [CNA, CEC], retry_count: 0,
  };
}

Deno.test("4 票 uphold → 原貢獻落庫成 applied、裁決任務關閉、同一筆其他未定案裁決退掉", async () => {
  const fake = createFakeSupabase({
    contributions: [disputedPolicy, adjudicationRow(A1, "uphold", "dave"), adjudicationRow(A2, "reject", "erin", "pending")],
    contribution_votes: votes,
    politicians: [{ id: PID, name: "陳素月" }],
    policies: [],
    contribution_tasks: [{ id: "t1", task_type: "adjudicate", status: "open", target: { contribution_id: C1, contributor: "alice" }, source: "auto_dispute" }],
  });
  const res = await autoApplyContribution(fake.client, A1);
  assertEquals(res.status, "applied");
  const original = fake.db.contributions.find((c) => c.id === C1)!;
  assertEquals(original.status, "applied");
  assert(String(original.review_notes).includes("[adjudication uphold]"));
  assertEquals(fake.db.policies.length, 1, "政見真的落進 policies");
  assertEquals(fake.db.policies[0].title, "長者健保全免");
  assertEquals(original.applied_policy_id, fake.db.policies[0].id);
  assertEquals(fake.db.contribution_tasks[0].status, "closed");
  const other = fake.db.contributions.find((c) => c.id === A2)!;
  assertEquals(other.status, "rejected", "另一筆未定案的裁決退掉");
  assert(fake.db.edit_history.some((e) => e.table_name === "policies" && e.contribution_id === C1), "edit_history 掛在原貢獻上（可 revert）");
});

Deno.test("4 票 reject → 原貢獻 rejected、review_notes 記裁決理由、任務關閉、不動正式表", async () => {
  const fake = createFakeSupabase({
    contributions: [disputedPolicy, adjudicationRow(A1, "reject", "dave")],
    contribution_votes: votes,
    politicians: [{ id: PID, name: "陳素月" }],
    policies: [],
    contribution_tasks: [{ id: "t1", task_type: "adjudicate", status: "open", target: { contribution_id: C1 }, source: "auto_dispute" }],
  });
  const res = await autoApplyContribution(fake.client, A1);
  assertEquals(res.status, "applied");
  const original = fake.db.contributions.find((c) => c.id === C1)!;
  assertEquals(original.status, "rejected");
  assert(String(original.review_notes).includes("[adjudication reject]") && String(original.review_notes).includes("dave"));
  assertEquals(fake.db.policies.length, 0);
  assertEquals(fake.db.contribution_tasks[0].status, "closed");
});

Deno.test("分歧：裁決本身被兩票反對 → 不建新任務、原裁決任務保持 open；有未定案裁決時不再派同一筆；原提交者不派", async () => {
  const fake = createFakeSupabase({
    contributions: [disputedPolicy, adjudicationRow(A1, "uphold", "dave", "disputed")],
    contribution_votes: votes,
    contribution_tasks: [{ id: "t1", task_type: "adjudicate", status: "open", target: { contribution_id: C1, contributor: "alice" }, source: "auto_dispute" }],
  });
  assertEquals((await ensureAdjudicationTask(fake.client, A1, "兩票反對")).skipped, "adjudication_itself");
  assertEquals(fake.db.contribution_tasks.length, 1);
  assertEquals(fake.db.contribution_tasks[0].status, "open", "任務保持 open，下一位代理再裁一次");

  const tasks = [{ task_id: "t1", task_type: "adjudicate", target: { contribution_id: C1, contributor: "alice" } }, { task_id: "t2", task_type: "policy_missing", target: { politician_id: PID } }];
  assertEquals(filterAdjudicateTasks(tasks, "Alice", new Set()).map((t) => t.task_id), ["t2"], "原提交者不派（不分大小寫）");
  assertEquals(filterAdjudicateTasks(tasks, "frank", new Set([C1])).map((t) => t.task_id), ["t2"], "已有 pending 裁決就先不派");
  assertEquals(filterAdjudicateTasks(tasks, "frank", new Set()).map((t) => t.task_id), ["t1", "t2"]);

  const cands = [{ id: A1, contribution_type: "adjudication", payload: { contribution_id: C1 }, agent_name: "dave", contributor_ip_hash: "ip-d", agree_count: 0, status: "pending" }];
  const originals = [{ id: C1, agent_name: "alice", contributor_ip_hash: "ip-a" }];
  assertEquals(excludeOwnAdjudications(cands, originals, { agent_name: "alice", ip_hash: "ip-z", voted_ids: new Set() }).length, 0, "原提交者不能驗自己那筆的裁決");
  assertEquals(excludeOwnAdjudications(cands, originals, { agent_name: "frank", ip_hash: "ip-z", voted_ids: new Set() }).length, 1);
});

Deno.test("落庫連續 3 次失敗 → disputed 並自動建裁決任務，描述帶錯誤訊息（不留給人）", async () => {
  const fake = createFakeSupabase({
    contributions: [{ ...disputedPolicy, status: "apply_failed", retry_count: 2, next_retry_at: "2020-01-01T00:00:00Z", last_error: "db down" }],
    contribution_votes: [],
  });
  const res = await autoApplyContribution(fake.client, C1, async () => { throw new Error("policies insert: null value in column category"); }, { retry: true });
  assertEquals(res.status, "disputed");
  assertEquals(fake.db.contributions[0].status, "disputed");
  assertEquals(fake.db.contribution_tasks.length, 1);
  const task = fake.db.contribution_tasks[0];
  assertEquals(task.task_type, "adjudicate");
  assert(String(task.description).includes("null value in column category"), "錯誤訊息進任務描述，代理可提 correction");
  assert(String(task.description).includes("落庫連續 3 次失敗"));
});
