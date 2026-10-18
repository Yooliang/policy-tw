import { assert, assertEquals } from "jsr:@std/assert@1";
import { collectSummaryIds } from "./summary-lookup.ts";
import { buildFeedSummary, type SummaryLookup, EXCLUDED_AGENTS, LEADERBOARD_SIZE, leaderboardScore, safePayload, summarizeContribution, CONTRIBUTORS_WINDOW_DAYS } from "./contribution-summary.ts";
import { CONTRIBUTION_TYPES } from "./contribution-schema.ts";

Deno.test("貢獻摘要：五種型別各一句人話＋目標連結", () => {
  const policy = summarizeContribution({ contribution_type: "policy", payload: { name: "陳素月", title: "長者健保全免" }, applied_policy_id: "p-1", applied_politician_id: "bcdfd014" });
  assertEquals(policy.summary, "為「陳素月」新增政見：長者健保全免");
  assertEquals(policy.policy_url, "https://xn--2lw665d.tw/policy/p-1");
  assertEquals(policy.politician_url, "https://xn--2lw665d.tw/politician/bcdfd014");

  const cand = summarizeContribution({ contribution_type: "candidacy", payload: { name: "徐千晴", election_id: 2026, region: "新竹市", election_type: "縣市議員", candidate_status: "registered" } });
  assertEquals(cand.summary, "將 徐千晴 2026 新竹市縣市議員參選狀態改為「已登記」");

  const corr = summarizeContribution({ contribution_type: "correction", payload: { target_table: "policies", target_id: "abcdef12-0000", field: "proposed_date", correct_value: "2024-04-02", reason: "…" } });
  assertEquals(corr.summary, "把某條政見的提出日改為「2024-04-02」");
  assertEquals(corr.policy_url, "https://xn--2lw665d.tw/policy/abcdef12-0000");

  const prog = summarizeContribution({ contribution_type: "policy_progress", payload: { policy_id: "p-2", status: "In Progress", progress: 40, note: "已編列預算" } });
  assert(prog.summary.startsWith("更新「某條政見」進度為「進行中」（40%）"));

  const pol = summarizeContribution({ contribution_type: "politician", payload: { name: "王大明", birth_year: 1970, bio: "x".repeat(300) } });
  assertEquals(pol.summary, "為「王大明」補基本資料：出生年、簡介");
});

// 2026-10-08：補學經歷出處的貢獻帶 politician_id 與 education／experience，
// 舊摘要看不到這兩欄，落到「新增政治人物『蔣萬安』」——但蔣萬安早就在庫裡
Deno.test("politician 摘要：有 politician_id 永遠不寫成新增", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const onlyCareer = summarizeContribution({
    contribution_type: "politician",
    payload: { name: "蔣萬安", politician_id: id, education: ["美國加州大學"], experience: ["台北市長"] },
  });
  assertEquals(onlyCareer.summary, "為「蔣萬安」補資料：學歷、經歷");

  const noFields = summarizeContribution({ contribution_type: "politician", payload: { name: "蔣萬安", politician_id: id } });
  assertEquals(noFields.summary, "更新「蔣萬安」的資料");

  // 已落到既有人物（applied_politician_id）也算更新；空陣列不算有值
  const applied = summarizeContribution({ contribution_type: "politician", payload: { name: "蔣萬安", education: [] }, applied_politician_id: id });
  assertEquals(applied.summary, "更新「蔣萬安」的資料");

  // education_level 與 education 同叫「學歷」，不重複列
  const dedup = summarizeContribution({ contribution_type: "politician", payload: { name: "蔣萬安", politician_id: id, education_level: "博士", education: ["x"], slogan: "s" } });
  assertEquals(dedup.summary, "為「蔣萬安」補資料：學歷、口號");

  const created = summarizeContribution({ contribution_type: "politician", payload: { name: "王新人" } });
  assertEquals(created.summary, "新增政治人物「王新人」");
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
  assertEquals(s.contributors_total, 5, "總數不限時間，carol 也算；erin 只投票沒提交，不算");
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
  assertEquals(s.contributors_total, 40, "總數也不算測試代號");
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
    district_seats: { election_id: 2026, election_type: "縣市議員", region: "彰化縣", districts: [{ district: "第01選舉區", seats: 6 }, { district: "第09選舉區", seats: 1, kind: "indigenous_plain" }] },
    reassign_candidacy: { politician_election_id: 36379, from_politician_id: "00000000-0000-4000-8000-000000000001", to_politician_id: "00000000-0000-4000-8000-000000000002", evidence: { birth_year: 1987 }, reason: "名冊上台中市第09選舉區的這一位 1987 年生，不是桃園的里長" },
    election_results: { election_id: 2022, election_type: "村里長", region: "台北市", sub_region: "中山區", items: [{ politician_election_id: 101, election_result: "elected" }] },
    merge_politician: { keep_id: "00000000-0000-4000-8000-000000000001", remove_id: "00000000-0000-4000-8000-000000000002", same_person: true, reason: "中選會歷屆參選同一筆：2022 朴子市長與 2026 縣長登記是同一位，出生年相同。" },
    policy_elements: { policy_id: "00000000-0000-4000-8000-000000000001", elements: [
      { element: "target", stated: true, text: "新建社會住宅 3,000 戶", source_locator: "公報第 2 頁〈居住〉第 1 點" },
      { element: "funding", stated: false, source_locator: "公報第 2 頁〈居住〉全段" },
    ] },
    lineage: { new_lineage: { title: "台中捷運藍線", category: "交通建設", level: "county", region: "台中市" },
      policy_ids: ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
      note: "兩條政見都是台中捷運藍線，計畫名稱與路線相同。" },
    lineage_participants: { lineage_id: "00000000-0000-4000-8000-000000000009", participants: [
      { politician_id: "00000000-0000-4000-8000-000000000001", role: "co_proposer", basis: "official_record", source_locator: "議案 1234" },
    ] },
    lineage_handover: { lineage_id: "00000000-0000-4000-8000-000000000009", from_politician_id: "00000000-0000-4000-8000-000000000001",
      to_politician_id: "00000000-0000-4000-8000-000000000002", handover_type: "pivot", note: "後任把藍線改成先做第一階段，見 2027 年施政報告。", source_locator: "施政報告第 3 頁" },
    lineage_link: { upper_lineage_id: "00000000-0000-4000-8000-000000000008", lower_lineage_id: "00000000-0000-4000-8000-000000000009",
      link_type: "top_down", note: "中央前瞻軌道補助核定藍線第一階段，市府執行。", source_locator: "核定公文" },
    party_info: { parties: [{ party_id: 95, valid_from: "2019-05-01", predecessor_id: 10001 }, { party_id: 10001, valid_to: "2019-04-30" }],
      note: "內政部政黨資訊網記載台灣團結聯盟更名為台聯黨" },
    regional_stat: { admin_code: "65000", stat_key: "population", year: 2024, value: 2800000, unit: "人" },
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

// 2026-09-17：「把政見 1b808b02 的所屬選舉改為『2024』」——畫面上不該出現 uuid
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
  assertEquals(withoutTitle, "把某條政見的所屬選舉改為「2024」", "查不到標題也不能把 id 印出來");
});

// 統計從 2026-09-17 起改在資料庫算（contribution_feed_summary），TS 這份變成規格。
// 兩份規則一漂開，畫面上的數字就會跟協議講的不一樣，而且不會有人發現——所以守住。
// contribution_leaderboard 有多個定義（天數版、2026-10-07 起還有區間版）：每一個都要守同一套規則
async function leaderboardDefinitions(): Promise<{ name: string; sql: string }[]> {
  const dir = new URL("../../migrations/", import.meta.url);
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  const defs: { name: string; sql: string }[] = [];
  for (const name of names.sort()) {
    const sql = (await Deno.readTextFile(new URL(name, dir))).replace(/\r\n/g, "\n");
    const re = /CREATE OR REPLACE FUNCTION contribution_leaderboard\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql))) {
      const end = sql.indexOf("\n$$;", m.index);
      defs.push({ name: `${name} @${m.index}`, sql: sql.slice(m.index, end + 4) });
    }
  }
  assert(defs.length >= 2, "找不到定義 contribution_leaderboard 的 migration（天數版與區間版都該在）");
  return defs;
}

Deno.test("SQL 的貢獻榜規則要跟 TS 這份一致：排除名單、榜長、分數、同分排序", async () => {
  for (const { name, sql } of await leaderboardDefinitions()) {
    // 排除名單：2026-10-07 起讀 excluded_agents 表（之前寫死在函式裡）；兩種寫法擇一，名單內容由 excluded-agents.test.ts 對照種子
    const fromTable = sql.includes("FROM excluded_agents");
    for (const agent of EXCLUDED_AGENTS) {
      assert(fromTable || sql.includes(`'${agent}'`), `${name}：SQL 的排除名單少了 ${agent}`);
    }
    assert(sql.includes(`LIMIT ${LEADERBOARD_SIZE}`), `${name}：SQL 的榜長要是 ${LEADERBOARD_SIZE}`);
    assert(sql.includes("submitted + applied + verified_votes"), `${name}：SQL 的分數要是三項相加`);
    assert(
      sql.includes("ORDER BY submitted + applied + verified_votes DESC, applied DESC, submitted DESC"),
      `${name}：SQL 同分時要先看上線、再看提交`,
    );
  }
  // 每日統計與近 30 天貢獻者的窗在 contribution_feed_summary 裡
  const feed = await latestFeedSummarySql();
  assert(feed.includes("Asia/Taipei"), "每日統計要用台灣時間分日");
  assert(feed.includes("INTERVAL '30 days'"), `近 30 天貢獻者的窗要是 ${CONTRIBUTORS_WINDOW_DAYS} 天`);
});

// 統計函式會被新 migration 整支重寫（CREATE OR REPLACE），每重寫一次就有兩件事可能悄悄掉：
// 排除名單跟 TS 漂開，以及 SECURITY DEFINER——少了它匿名呼叫只拿到 0（migration 000013 修過一次）。
async function latestFeedSummarySql(): Promise<string> {
  const dir = new URL("../../migrations/", import.meta.url);
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  for (const name of names.sort().reverse()) {
    const sql = await Deno.readTextFile(new URL(name, dir));
    const i = sql.indexOf("CREATE OR REPLACE FUNCTION contribution_feed_summary");
    if (i >= 0) return sql.slice(i);
  }
  throw new Error("找不到定義 contribution_feed_summary 的 migration");
}

Deno.test("最新的統計函式：排除名單跟 TS 一致、有貢獻者總數、以定義者身分執行", async () => {
  const sql = await latestFeedSummarySql();
  const fromTable = sql.includes("FROM excluded_agents");
  for (const name of EXCLUDED_AGENTS) {
    assert(fromTable || sql.includes(`'${name}'`), `統計函式的排除名單少了 ${name}`);
  }
  assert(sql.includes("'contributors_total'"), "統計函式要回 contributors_total");
  assert(sql.includes("INTERVAL '30 days'"), `近 30 天貢獻者的窗要是 ${CONTRIBUTORS_WINDOW_DAYS} 天`);
  // 函式本體後面緊接的屬性，或同檔之後的 ALTER，都算數
  assert(/SECURITY DEFINER/.test(sql), "統計函式要 SECURITY DEFINER，不然匿名呼叫拿到的都是 0");
  assert(/search_path\s*=\s*public/.test(sql), "SECURITY DEFINER 要固定 search_path");
});

// 2026-09-19：張嘉哲 2022 南投市長的選舉結果答案在動態牆上顯示成「參選狀態改為確認參選」，看不出補了什麼
// 2026-10-06（#345）：得票數、得票率不收，摘要也不帶票數
Deno.test("candidacy 帶選舉結果：摘要講結果不講狀態、不帶票數", () => {
  const r = summarizeContribution({ contribution_type: "candidacy", payload: { name: "張嘉哲", election_id: 2022, region: "南投縣", election_type: "鄉鎮市長", candidate_status: "confirmed", election_result: "elected", votes_received: 29150, vote_percentage: 53.7 } });
  assertEquals(r.summary, "補 張嘉哲 2022 南投縣鄉鎮市長選舉結果：當選");
});

Deno.test("merge_politician 摘要：合併或不同人", () => {
  const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
  assertEquals(summarizeContribution({ contribution_type: "merge_politician", payload: { keep_id: A, remove_id: B, same_person: true, reason: "中選會歷屆參選同一筆，出生年相同" } }).summary, "合併同名人物：「另一位同名人物」併入「某位政治人物」：中選會歷屆參選同一筆，出生年相同");
  assertEquals(summarizeContribution({ contribution_type: "merge_politician", payload: { keep_id: A, remove_id: B, same_person: false, reason: "一位是金門縣議員一位是連江縣議員，出生年不同" } }).summary.startsWith("判定人物"), true);
});

// ---- 2026-10-18「把 id 都換成名稱」：摘要裡不准出現 id ----
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LOOKUP: SummaryLookup = {
  politicians: { [U(1)]: "邱威霖", [U(2)]: "王小明" },
  policies: { [U(10)]: "規劃里民休閒空間" },
  lineages: { [U(20)]: "市立游泳池興建", [U(21)]: "水域安全" },
  parties: { "95": "台灣團結聯盟", "10001": "台聯黨" },
  elections: { "9827": "邱威霖 2026 縣市議員", "36379": "王小明 2022 村里長" },
  regions: { "65000": "新北市" },
  contributions: { [U(30)]: "為「邱威霖」新增政見：規劃里民休閒空間" },
};
const sum = (contribution_type: string, payload: Record<string, unknown>, extra: { applied_politician_id?: string; lookup?: SummaryLookup } = {}) =>
  summarizeContribution({ contribution_type, payload, lookup: LOOKUP, ...extra });

Deno.test("id 換名稱：policy／policy_progress／policy_elements 用查到的人名與標題", () => {
  assertEquals(sum("policy", { politician_id: U(1), title: "規劃里民休閒空間" }).summary, "為「邱威霖」新增政見：規劃里民休閒空間");
  assertEquals(sum("policy", { title: "x" }, { applied_politician_id: U(2) }).summary, "為「王小明」新增政見：x");
  assertEquals(sum("policy_progress", { policy_id: U(10), status: "In Progress", note: "動工" }).summary, "更新「規劃里民休閒空間」進度為「進行中」：動工");
  assertEquals(sum("policy_elements", { policy_id: U(10), elements: [] }).summary, "為「規劃里民休閒空間」拆政見三要素：（沒有要素）");
});

Deno.test("id 換名稱：correction／removal 依目標表換成人名、標題、參選紀錄標籤", () => {
  assertEquals(sum("correction", { target_table: "politicians", target_id: U(1), field: "party", correct_value: "無黨籍" }).summary, "把政治人物「邱威霖」的政黨改為「無黨籍」");
  assertEquals(sum("correction", { target_table: "politician_elections", target_id: 9827, field: "candidate_status", correct_value: "registered" }).summary, "把參選紀錄「邱威霖 2026 縣市議員」的參選狀態改為「已登記」");
  assertEquals(sum("removal", { target_table: "policies", target_id: U(10), reason: "重複" }).summary, "建議移除政見「規劃里民休閒空間」：重複");
  assertEquals(sum("removal", { target_table: "politicians", target_id: U(99), reason: "測試資料" }).summary, "建議移除某位政治人物：測試資料");
  assertEquals(sum("removal", { target_table: "tracking_logs", target_id: U(99), reason: "r" }).summary, "建議移除某筆資料：r");
});

Deno.test("id 換名稱：裁決用原貢獻自己的摘要，查不到說某筆貢獻", () => {
  assertEquals(sum("adjudication", { contribution_id: U(30), verdict: "uphold", reason: "來源確實寫了" }).summary, "裁決「為「邱威霖」新增政見：規劃里民休閒空間」：認為原貢獻正確——來源確實寫了");
  assertEquals(sum("adjudication", { contribution_id: U(31), verdict: "reject" }).summary, "裁決某筆貢獻：認為原貢獻有誤");
});

Deno.test("id 換名稱：政策脈絡四型別、政黨、改掛、合併、地區統計", () => {
  assertEquals(sum("lineage", { lineage_id: U(20), policy_ids: [U(10)] }).summary, "政策脈絡「市立游泳池興建」：歸入 1 條政見");
  assertEquals(sum("lineage_handover", { lineage_id: U(20), handover_type: "continued", note: "接續" }).summary.startsWith("記政策脈絡「市立游泳池興建」的交接"), true);
  assertEquals(sum("lineage_participants", { lineage_id: U(99), participants: [] }).summary.startsWith("為政策脈絡「某條政策脈絡」標參與角色"), true);
  assertEquals(sum("lineage_link", { upper_lineage_id: U(20), lower_lineage_id: U(21), link_type: "implements", note: "n" }).summary.includes("「市立游泳池興建」→「水域安全」"), true);
  assertEquals(
    sum("party_info", { parties: [{ party_id: 95, valid_from: "2019-05-01", predecessor_id: 10001 }, { party_id: 777, valid_to: "2019-04-30" }] }).summary,
    "補政黨資訊：政黨「台灣團結聯盟」（名稱起始日 2019-05-01、前身是政黨「台聯黨」）；政黨「某個政黨」（名稱停用日 2019-04-30）",
  );
  assertEquals(sum("reassign_candidacy", { politician_election_id: 36379, to_politician_id: U(1), reason: "r" }).summary, "參選紀錄「王小明 2022 村里長」改掛到既有的「邱威霖」：r");
  assertEquals(sum("reassign_candidacy", { politician_election_id: 1, to_politician_id: U(99), reason: "r" }).summary, "參選紀錄（某筆）改掛到既有的「某位政治人物」：r");
  assertEquals(sum("merge_politician", { keep_id: U(1), remove_id: U(2), same_person: true, reason: "r" }).summary, "合併同名人物：「王小明」併入「邱威霖」：r");
  assertEquals(sum("regional_stat", { admin_code: "65000", stat_key: "population", year: 2024, value: 1, unit: "人" }).summary, "補 新北市2024 年的人口：1 人");
  assertEquals(sum("regional_stat", { admin_code: "99999", stat_key: "population", year: 2024, value: 1, unit: "人" }).summary.includes("某個地區"), true);
});

Deno.test("id 換名稱：不管查不查得到，摘要裡都不能出現 uuid 或數字 id", () => {
  const payloads: Array<[string, Record<string, unknown>]> = [
    ["policy", { politician_id: U(77), title: "t" }],
    ["policy_progress", { policy_id: U(77), status: "Achieved", note: "n" }],
    ["policy_elements", { policy_id: U(77), elements: [] }],
    ["correction", { target_table: "policies", target_id: U(77), field: "title", correct_value: "x" }],
    ["adjudication", { contribution_id: U(77), verdict: "uphold" }],
    ["lineage", { lineage_id: U(77) }],
    ["lineage_participants", { lineage_id: U(77), participants: [] }],
    ["lineage_handover", { lineage_id: U(77), handover_type: "continued", note: "n" }],
    ["lineage_link", { upper_lineage_id: U(77), lower_lineage_id: U(78), link_type: "implements", note: "n" }],
    ["party_info", { parties: [{ party_id: 12345, predecessor_id: 54321 }] }],
    ["reassign_candidacy", { politician_election_id: 98765, to_politician_id: U(77), reason: "r" }],
    ["merge_politician", { keep_id: U(77), remove_id: U(78), same_person: false, reason: "r" }],
    ["removal", { target_table: "politicians", target_id: U(77), reason: "r" }],
    ["regional_stat", { admin_code: "12345", stat_key: "population", year: 2024, value: 1, unit: "人" }],
  ];
  for (const [type, payload] of payloads) {
    for (const lookup of [undefined, {} as SummaryLookup]) {
      const r = summarizeContribution({ contribution_type: type, payload, lookup });
      for (const text of [r.summary, r.detail]) {
        assert(!/[0-9a-f]{8}-[0-9a-f]{4}/i.test(text) && !text.includes("00000000"), `${type} 摘要印出了 uuid：${text}`);
        assert(!/12345|54321|98765/.test(text), `${type} 摘要印出了數字 id：${text}`);
      }
    }
  }
});

Deno.test("detail：去掉「誰＋做了什麼」前綴，其餘型別等於 summary", () => {
  assertEquals(sum("policy", { politician_id: U(1), title: "規劃里民休閒空間" }).detail, "規劃里民休閒空間");
  assertEquals(sum("policy_progress", { policy_id: U(10), status: "In Progress", progress: 40, note: "動工" }).detail, "進度為「進行中」（40%）：動工");
  assertEquals(sum("politician", { politician_id: U(1), party: "無黨籍", education: ["a"] }).detail, "政黨、學歷");
  assertEquals(sum("correction", { target_table: "politicians", target_id: U(1), field: "party", correct_value: "無黨籍" }).detail, "政黨改為「無黨籍」");
  assertEquals(sum("correction", { target_table: "politician_elections", target_id: 9827, field: "candidate_status", correct_value: "registered" }).detail, "參選紀錄「邱威霖 2026 縣市議員」的參選狀態改為「已登記」");
  assertEquals(sum("candidacy", { name: "王小明", election_id: 2026, region: "彰化縣", election_type: "縣市長", candidate_status: "registered" }).detail, "2026 彰化縣縣市長參選狀態改為「已登記」");
  const other = sum("no_change", { note: "核對過" });
  assertEquals(other.detail, other.summary);
});

Deno.test("collectSummaryIds：掃出各表要查的 id，濾掉格式不對的", () => {
  const ids = collectSummaryIds([
    { contribution_type: "policy", payload: { politician_id: U(1) }, applied_policy_id: U(10) },
    { contribution_type: "correction", payload: { target_table: "politician_elections", target_id: 9827 } },
    { contribution_type: "adjudication", payload: { contribution_id: U(30) } },
    { contribution_type: "party_info", payload: { parties: [{ party_id: 95, predecessor_id: "10001" }] } },
    { contribution_type: "regional_stat", payload: { admin_code: "65000" } },
    { contribution_type: "lineage", payload: { lineage_id: "not-a-uuid" } },
  ]);
  assertEquals(ids.politicians, [U(1)]);
  assertEquals(ids.policies, [U(10)]);
  assertEquals(ids.elections, ["9827"]);
  assertEquals(ids.contributions, [U(30)]);
  assertEquals(ids.parties.sort(), ["10001", "95"]);
  assertEquals(ids.regions, ["65000"]);
  assertEquals(ids.lineages, []);
});

// ── candidacy 帶 party（補政黨的交件，party_roster 臂）：標題要講出推薦政黨，不能只剩「參選狀態改為」 ──
const candParty = (party?: string) => summarizeContribution({
  contribution_type: "candidacy",
  payload: { name: "蘇清吉", election_id: 2026, region: "高雄市", election_type: "村里長", candidate_status: "registered", ...(party === undefined ? {} : { party }) },
});

Deno.test("candidacy 帶 party＝「無」：各種無黨籍寫法都顯示「無黨籍」", () => {
  for (const w of ["無", "無黨", "無黨籍", "無黨籍及未經政黨推薦"]) {
    const r = candParty(w);
    assertEquals(r.summary, "將 蘇清吉 2026 高雄市村里長參選狀態改為「已登記」，推薦政黨「無黨籍」");
    assertEquals(r.detail, "2026 高雄市村里長：已登記，推薦政黨「無黨籍」");
  }
});

Deno.test("candidacy 帶 party＝中國國民黨：句子帶政黨原字", () => {
  const r = candParty("中國國民黨");
  assertEquals(r.summary, "將 蘇清吉 2026 高雄市村里長參選狀態改為「已登記」，推薦政黨「中國國民黨」");
  assert(r.detail.includes("中國國民黨"));
});

Deno.test("candidacy 沒有 party：句子跟以前一字不差", () => {
  const r = candParty();
  assertEquals(r.summary, "將 蘇清吉 2026 高雄市村里長參選狀態改為「已登記」");
  assertEquals(r.detail, "2026 高雄市村里長參選狀態改為「已登記」");
  assertEquals(candParty("").summary, r.summary);
});

Deno.test("candidacy 帶選舉結果又帶 party：結果那條照舊（不講政黨）", () => {
  const r = summarizeContribution({ contribution_type: "candidacy", payload: { name: "張嘉哲", election_id: 2022, region: "南投縣", election_type: "鄉鎮市長", candidate_status: "confirmed", election_result: "elected", party: "無" } });
  assertEquals(r.summary, "補 張嘉哲 2022 南投縣鄉鎮市長選舉結果：當選");
});
