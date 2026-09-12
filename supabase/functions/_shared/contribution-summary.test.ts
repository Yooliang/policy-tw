import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildFeedSummary, safePayload, summarizeContribution } from "./contribution-summary.ts";
import { CONTRIBUTION_TYPES } from "./contribution-schema.ts";

Deno.test("貢獻摘要：五種型別各一句人話＋目標連結", () => {
  const policy = summarizeContribution({ contribution_type: "policy", payload: { name: "陳素月", title: "長者健保全免" }, applied_policy_id: "p-1", applied_politician_id: "bcdfd014" });
  assertEquals(policy.summary, "為「陳素月」新增政見：長者健保全免");
  assertEquals(policy.policy_url, "https://policy-tw.web.app/policy/p-1");
  assertEquals(policy.politician_url, "https://policy-tw.web.app/politician/bcdfd014");

  const cand = summarizeContribution({ contribution_type: "candidacy", payload: { name: "徐千晴", election_id: 2026, region: "新竹市", election_type: "縣市議員", candidate_status: "registered" } });
  assertEquals(cand.summary, "將 徐千晴 2026 新竹市縣市議員參選狀態改為「已登記」");

  const corr = summarizeContribution({ contribution_type: "correction", payload: { target_table: "policies", target_id: "abcdef12-0000", field: "proposed_date", correct_value: "2024-04-02", reason: "…" } });
  assertEquals(corr.summary, "把政見 abcdef12 的提出日改為「2024-04-02」");
  assertEquals(corr.policy_url, "https://policy-tw.web.app/policy/abcdef12-0000");

  const prog = summarizeContribution({ contribution_type: "policy_progress", payload: { policy_id: "p-2", status: "In Progress", progress: 40, note: "已編列預算" } });
  assert(prog.summary.startsWith("更新「政見 p-2」進度為「進行中」（40%）"));

  const pol = summarizeContribution({ contribution_type: "politician", payload: { name: "王大明", birth_year: 1970, bio: "x".repeat(300) } });
  assertEquals(pol.summary, "為「王大明」補基本資料：出生年、簡介");
});

Deno.test("安全 payload：長文截 200 字", () => {
  const sp = safePayload({ bio: "很".repeat(500), tags: ["a"], n: 1 });
  assertEquals((sp.bio as string).length, 201);
  assertEquals(sp.n, 1);
});

Deno.test("看板 summary：needs_attention 四子項合計、contributors_30d 不重複、leaderboard 三個數字、近 7 日", () => {
  const now = Date.parse("2026-09-12T08:00:00Z");
  const day = (d: number) => new Date(now - d * 86400 * 1000).toISOString();
  const rows = [
    { status: "applied", agent_name: "alice", created_at: day(0) },
    { status: "applied", agent_name: "alice", created_at: day(1) },
    { status: "pending", agent_name: "bob", created_at: day(1) },
    { status: "disputed", agent_name: "bob", created_at: day(3) },
    { status: "disputed", agent_name: "carol", created_at: day(40) },
    { status: "rejected", agent_name: "carol", created_at: day(40) },
    { status: "apply_failed", agent_name: null, created_at: day(2) },
    { status: "verified", agent_name: "dave", created_at: day(10) },
  ];
  const votes = [{ agent_name: "bob" }, { agent_name: "bob" }, { agent_name: "erin" }];
  const s = buildFeedSummary(rows, votes, now);
  assertEquals(s.total, 8);
  assertEquals(s.needs_attention, { total: 2, disputed: 2, retrying: 1 });
  assertEquals(s.contributors_30d, 4, "alice、bob、dave、(unknown)；carol 是 40 天前");
  assertEquals(s.daily_last_7.length, 7);
  assertEquals(s.daily_last_7[6], { date: "2026-09-12", count: 1 });
  assertEquals(s.daily_last_7[5].count, 2);
  const alice = s.leaderboard.find((r) => r.agent_name === "alice")!;
  assertEquals([alice.submitted, alice.applied, alice.verified_votes], [2, 2, 0]);
  const bob = s.leaderboard.find((r) => r.agent_name === "bob")!;
  assertEquals([bob.submitted, bob.applied, bob.verified_votes], [2, 0, 2]);
  assertEquals(s.leaderboard[0].agent_name, "alice", "上線數優先");
  assert(s.leaderboard.some((r) => r.agent_name === "erin" && r.submitted === 0 && r.verified_votes === 1), "只驗證沒提交的人也上榜");
});

Deno.test("每一種貢獻型別都要有人話摘要，不能掉進「（型別名）」的預設值", () => {
  // 加了新型別卻忘了寫摘要時，貢獻看板上會出現「（removal）」這種東西給讀者看。
  // 這支測試讓那件事直接紅燈，而不是等到有人截圖問「這是什麼」。
  const PAYLOADS: Record<string, Record<string, unknown>> = {
    politician: { name: "王小明", party: "無黨籍" },
    candidacy: { name: "王小明", election_id: 2026, election_type: "縣市長", region: "彰化縣", candidate_status: "registered" },
    policy: { name: "王小明", title: "把圖書館蓋回來", description: "承諾任內完成分館重建並延長開放時間。", category: "教育文化" },
    policy_progress: { policy_title: "把圖書館蓋回來", status: "In Progress", note: "已發包，預計年底動工。", date: "2026-05-01" },
    correction: { target_table: "policies", target_id: "00000000-0000-4000-8000-000000000001", field: "category", correct_value: "教育文化", reason: "分類放錯了" },
    task_suggestion: { title: "補齊彰化縣議員的政見", description: "彰化縣議員候選人多數沒有任何政見紀錄。" },
    no_change: { note: "核對過選舉公報，與現有資料一致。" },
    adjudication: { contribution_id: "00000000-0000-4000-8000-000000000002", verdict: "uphold", reason: "原貢獻的來源打得開且內容相符。" },
    question_answer: { question_id: "00000000-0000-4000-8000-000000000003", answer: "依市府預算書，這條路線的第一期經費已編列。" },
    removal: { target_table: "policies", target_id: "00000000-0000-4000-8000-000000000001", reason: "這是參選表態不是政見，也沒有任何來源。" },
  };

  for (const type of CONTRIBUTION_TYPES) {
    const payload = PAYLOADS[type];
    assert(payload, `新增了型別 ${type} 卻沒在這支測試裡補上範例 payload`);
    const { summary } = summarizeContribution({ contribution_type: type, payload });
    assert(summary && summary.trim().length > 0, `${type} 沒有摘要`);
    assert(summary !== `（${type}）`, `${type} 掉進預設值，貢獻看板會顯示「（${type}）」給讀者看`);
  }
});
