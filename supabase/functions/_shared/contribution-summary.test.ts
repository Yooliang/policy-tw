import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildFeedSummary, EXCLUDED_AGENTS, LEADERBOARD_SIZE, leaderboardScore, safePayload, summarizeContribution } from "./contribution-summary.ts";
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

Deno.test("近 7 日：驗證票也按天統計，且用台灣日期分日", () => {
  // 台灣 09-12 早上 07:30 ＝ UTC 09-11 23:30：切 UTC 會被算到 09-11
  const now = Date.parse("2026-09-12T10:00:00Z"); // 台灣 09-12 18:00
  const rows = [
    { status: "pending", agent_name: "alice", created_at: "2026-09-11T23:30:00Z" }, // 台灣 09-12 07:30
    { status: "pending", agent_name: "alice", created_at: "2026-09-11T15:59:00Z" }, // 台灣 09-11 23:59
  ];
  const votes = [
    { agent_name: "bob", created_at: "2026-09-12T01:00:00Z" },  // 台灣 09-12
    { agent_name: "bob", created_at: "2026-09-11T16:00:00Z" },  // 台灣 09-12 00:00
    { agent_name: "erin", created_at: "2026-09-10T12:00:00Z" }, // 台灣 09-10 20:00
    { agent_name: "erin", created_at: "2026-08-01T00:00:00Z" }, // 超出 7 日
  ];
  const s = buildFeedSummary(rows, votes, now);
  assertEquals(s.daily_last_7.map((d) => d.date), ["2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12"]);
  assertEquals(s.daily_last_7[6], { date: "2026-09-12", count: 1, verifications: 2 });
  assertEquals(s.daily_last_7[5], { date: "2026-09-11", count: 1, verifications: 0 });
  assertEquals(s.daily_last_7[4].verifications, 1);
  assertEquals(s.daily_last_7.reduce((a, d) => a + d.verifications, 0), 3, "超出 7 日的票不算進圖，但照樣算進貢獻榜");
  assertEquals(s.leaderboard.find((r) => r.agent_name === "erin")?.verified_votes, 2);
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
  assertEquals(s.daily_last_7[6], { date: "2026-09-12", count: 1, verifications: 0 }, "votes 沒帶時間就不進每日圖");
  assertEquals(s.daily_last_7[5].count, 2);
  const alice = s.leaderboard.find((r) => r.agent_name === "alice")!;
  assertEquals([alice.submitted, alice.applied, alice.verified_votes], [2, 2, 0]);
  const bob = s.leaderboard.find((r) => r.agent_name === "bob")!;
  assertEquals([bob.submitted, bob.applied, bob.verified_votes], [2, 0, 2]);
  assertEquals(s.leaderboard[0].agent_name, "alice", "上線數優先");
  assert(s.leaderboard.some((r) => r.agent_name === "erin" && r.submitted === 0 && r.verified_votes === 1), "只驗證沒提交的人也上榜");
});

Deno.test("貢獻榜：最多 30 名，測試代號不上榜也不算貢獻者", () => {
  // 這支測試的第一版是假綠，兩個斷言都沒有鑑別力，記在這裡免得再犯：
  //   1. 名額寫成 assertEquals(leaderboard.length, LEADERBOARD_SIZE)——拿產生結果的
  //      那個常數當期望值，改常數兩邊一起動，等於恆真。期望值要寫死 30。
  //   2. 測試代號只給一筆上線，跟真人同分；排序穩定所以它們本來就排在 30 名之後，
  //      把過濾整行刪掉測試照樣綠。要讓它們分數高到「沒過濾就一定在榜上」。
  const now = Date.parse("2026-09-12T08:00:00Z");
  const at = new Date(now - 3600_000).toISOString();
  const rows: Array<{ status: string; agent_name: string; created_at: string }> = [];
  // 40 個真人，各一筆已上線 → 榜上只能列 30 個
  for (let i = 0; i < 40; i++) {
    rows.push({ status: "applied", agent_name: `human-${String(i).padStart(2, "0")}`, created_at: at });
  }
  // 每個測試代號五筆已上線：分數高於所有真人，沒有過濾就會霸佔榜首
  const excluded = [...EXCLUDED_AGENTS];
  for (const name of excluded) {
    for (let i = 0; i < 5; i++) rows.push({ status: "applied", agent_name: name, created_at: at });
  }

  const s = buildFeedSummary(rows, [], now);
  assertEquals(LEADERBOARD_SIZE, 30, "貢獻榜名額是 30；要改請連同這個期望值一起改");
  assertEquals(s.leaderboard.length, 30, "貢獻榜要列滿 30 名");
  assertEquals(
    s.leaderboard.filter((r) => EXCLUDED_AGENTS.has(r.agent_name)).length,
    0,
    "測試代號分數最高卻不該出現在貢獻榜",
  );
  assertEquals(s.leaderboard[0].applied, 1, "榜首應該是真人（1 筆上線），不是五筆上線的測試代號");
  assertEquals(s.contributors_30d, 40, "貢獻者只算真人，不算那些測試代號");
  // 資料本身不動：測試代號交的東西還是算在總數與狀態統計裡
  const totalRows = 40 + excluded.length * 5;
  assertEquals(s.total, totalRows, "排除只影響榜與貢獻者數，不影響貢獻總數");
  assertEquals(s.by_status.applied, totalRows);
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
    roster_check: { election_id: 2026, region: "彰化縣", election_type: "縣市議員", cec_count: 41, ours_count: 6, submitted: 35, note: "打開中選會候選人查詢，彰化縣縣市議員共 41 人，我們只有 6 人，另外 35 位已逐筆用 candidacy 補交。" },
  };

  for (const type of CONTRIBUTION_TYPES) {
    const payload = PAYLOADS[type];
    assert(payload, `新增了型別 ${type} 卻沒在這支測試裡補上範例 payload`);
    const { summary } = summarizeContribution({ contribution_type: type, payload });
    assert(summary && summary.trim().length > 0, `${type} 沒有摘要`);
    assert(summary !== `（${type}）`, `${type} 掉進預設值，貢獻看板會顯示「（${type}）」給讀者看`);
  }
});

Deno.test("貢獻榜排名：三項合計，不是只看上線", () => {
  // 實際發生過：交 44 筆、投 22 票的人因為那 44 筆全卡在待驗證（沒人能驗），
  // applied=0，被只看 applied 的排法壓在一個「交 2 筆上線 1 筆」的代號後面。
  const now = Date.parse("2026-09-13T00:00:00Z");
  const at = new Date(now - 3600_000).toISOString();
  const rows: Array<{ status: string; agent_name: string; created_at: string }> = [];
  const submit = (name: string, n: number, applied: number) => {
    for (let i = 0; i < n; i++) {
      rows.push({ status: i < applied ? "applied" : "pending", agent_name: name, created_at: at });
    }
  };
  submit("prolific", 44, 0); // 交很多、一筆都還沒過
  submit("lucky", 2, 1); // 交很少、過了一筆
  const votes = [...Array(22)].map(() => ({ agent_name: "prolific" }));

  const s = buildFeedSummary(rows, votes, now);
  const prolific = s.leaderboard.find((r) => r.agent_name === "prolific")!;
  const lucky = s.leaderboard.find((r) => r.agent_name === "lucky")!;

  assertEquals(prolific.score, 44 + 0 + 22, "分數＝提交＋上線＋驗證票");
  assertEquals(leaderboardScore(prolific), prolific.score, "匯出的計分函式要跟榜上的分數是同一套");
  assertEquals(lucky.score, 2 + 1 + 0);
  assertEquals(s.leaderboard[0].agent_name, "prolific", "做最多的要排第一，不能被只看 applied 的排法壓下去");

  // 上線的那幾筆算兩次（applied 是 submitted 的子集），品質要比純數量值錢
  const quality = buildFeedSummary(
    [...Array(10)].map(() => ({ status: "applied", agent_name: "q", created_at: at })),
    [],
    now,
  ).leaderboard[0];
  assertEquals(quality.score, 20, "10 筆全通過 = 10 提交 + 10 上線");
});

Deno.test("貢獻榜排名：同分時的名次要穩定，不能靠插入順序", () => {
  const now = Date.parse("2026-09-13T00:00:00Z");
  const at = new Date(now - 3600_000).toISOString();
  // 兩人同分（都是 4）：a 靠上線、b 靠提交。上線優先 → a 在前。
  const rows = [
    { status: "applied", agent_name: "a", created_at: at },
    { status: "applied", agent_name: "a", created_at: at },
    { status: "pending", agent_name: "b", created_at: at },
    { status: "pending", agent_name: "b", created_at: at },
    { status: "pending", agent_name: "b", created_at: at },
    { status: "pending", agent_name: "b", created_at: at },
  ];
  const s = buildFeedSummary(rows, [], now);
  const a = s.leaderboard.find((r) => r.agent_name === "a")!;
  const b = s.leaderboard.find((r) => r.agent_name === "b")!;
  assertEquals([a.score, b.score], [4, 4], "先確認真的同分，否則這支測試沒有在測同分");
  assertEquals(s.leaderboard[0].agent_name, "a", "同分時上線多的在前");
});

Deno.test("貢獻榜時間窗：總榜／30 天／7 天各自只算窗內的貢獻與票", () => {
  const now = Date.parse("2026-09-13T12:00:00Z");
  const ago = (days: number) => new Date(now - days * 86400 * 1000).toISOString();
  const rows = [
    // old：只有 40 天前的活動，應該只出現在總榜
    { status: "applied", agent_name: "old", created_at: ago(40) },
    { status: "applied", agent_name: "old", created_at: ago(41) },
    // mid：20 天前，總榜與 30 天榜看得到，7 天榜看不到
    { status: "pending", agent_name: "mid", created_at: ago(20) },
    // fresh：2 天前，三張榜都看得到
    { status: "pending", agent_name: "fresh", created_at: ago(2) },
  ];
  const votes = [
    { agent_name: "old", created_at: ago(40) },
    { agent_name: "fresh", created_at: ago(1) },
    { agent_name: "fresh", created_at: ago(1) },
  ];
  const s = buildFeedSummary(rows, votes, now);
  const names = (list: Array<{ agent_name: string }>) => list.map((r) => r.agent_name).sort();

  assertEquals(names(s.leaderboard), ["fresh", "mid", "old"], "總榜要有全部三個");
  assertEquals(names(s.leaderboard_30d), ["fresh", "mid"], "30 天榜不該有 40 天前的 old");
  assertEquals(names(s.leaderboard_7d), ["fresh"], "7 天榜只該有 2 天前的 fresh");

  // old 在總榜的分數＝2 提交 + 2 上線 + 1 票
  assertEquals(s.leaderboard.find((r) => r.agent_name === "old")!.score, 5);
  // fresh 在 7 天榜＝1 提交 + 0 上線 + 2 票
  assertEquals(s.leaderboard_7d.find((r) => r.agent_name === "fresh")!.score, 3);
});

Deno.test("貢獻榜時間窗：票沒有時間就不算進任何時間窗，但總榜要算", () => {
  const now = Date.parse("2026-09-13T12:00:00Z");
  const at = new Date(now - 86400 * 1000).toISOString();
  const rows = [{ status: "pending", agent_name: "someone", created_at: at }];
  // 舊資料或呼叫端沒撈 created_at 的票：寧可少算，不要塞進本週
  const votes = [{ agent_name: "voter" }, { agent_name: "voter" }];
  const s = buildFeedSummary(rows, votes, now);
  assertEquals(s.leaderboard.find((r) => r.agent_name === "voter")?.score, 2, "總榜要算無時間的票");
  assertEquals(s.leaderboard_7d.find((r) => r.agent_name === "voter"), undefined, "7 天榜不該憑空多出時間不明的票");
  assertEquals(s.leaderboard_7d.find((r) => r.agent_name === "someone")?.score, 1);
});

// 2026-09-17 小良哥：「把政見 1b808b02 的所屬選舉改為『2024』」——畫面上不該出現 uuid
Deno.test("correction 有標題就用標題，沒有才退回 id 前八碼", () => {
  const withTitle = summarizeContribution({
    contribution_type: "correction",
    payload: { target_table: "policies", target_id: "1b808b02-0000-4000-8000-000000000001", policy_title: "4321海線大進擊 打造第一海線", field: "election_id", correct_value: "2024" },
    applied_politician_id: null, applied_policy_id: null,
  }).summary;
  assertEquals(withTitle, "把政見「4321海線大進擊 打造第一海線」的所屬選舉改為「2024」");

  const withoutTitle = summarizeContribution({
    contribution_type: "correction",
    payload: { target_table: "policies", target_id: "1b808b02-0000-4000-8000-000000000001", field: "election_id", correct_value: "2024" },
    applied_politician_id: null, applied_policy_id: null,
  }).summary;
  assertEquals(withoutTitle, "把政見 1b808b02 的所屬選舉改為「2024」");
});
