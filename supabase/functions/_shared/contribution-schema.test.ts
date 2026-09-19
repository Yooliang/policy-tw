/**
 * 執行：cd supabase/functions && deno test --allow-read _shared/
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { canonicalPayload, MAX_BATCH, sha256Hex, validateContributionRequest, validateVerifyRequest } from "./contribution-schema.ts";
import { bestSourceKind, checkSourceSet, sourceKind } from "./source-priority.ts";

const CEC = "https://db.cec.gov.tw/ElecTable/Election/ElecTickets";
const CNA = "https://www.cna.com.tw/news/aipl/202609045002.aspx";

const AGENT = "xiaoliang-test";
const validCandidacy = {
  agent_name: AGENT,
  contribution_type: "candidacy",
  payload: { name: "陳素月", party: "民主進步黨", region: "彰化縣", election_id: 2026, election_type: "縣市長", candidate_status: "registered", current_position: "立法委員" },
  source_urls: [CNA],
};

Deno.test("亂碼拒收：任何字串含 U+FFFD 或控制字元 → encoding_invalid，指出路徑並教 UTF-8 送法", () => {
  const garbled = { ...validCandidacy, payload: { ...validCandidacy.payload, name: "���", region: "彰化縣" } };
  const r = validateContributionRequest(garbled);
  assertEquals(r.ok, false);
  assertEquals(r.errors.map((e) => e.path), ["payload.name"]);
  assertEquals(r.errors[0].code, "encoding_invalid");
  assert(r.errors[0].message.includes("--data-binary"));

  const control = { ...validCandidacy, note: "有控制字元\x07" };
  assert(validateContributionRequest(control).errors.some((e) => e.code === "encoding_invalid" && e.path === "note"));

  const verify = validateVerifyRequest({ contribution_id: "5f0f2a2e-1c1e-4b3a-9d2c-0a1b2c3d4e5f", verdict: "unsure", agent_name: AGENT, note: "�" });
  assert(verify.errors.some((e) => e.code === "encoding_invalid"));

  // 正常中文（含換行）不會被誤擋
  assertEquals(validateContributionRequest({ ...validCandidacy, note: "第一行\n第二行\t縮排" }).ok, true);
});

Deno.test("agent_name 必填；task_id 可帶", () => {
  const { agent_name: _drop, ...noAgent } = validCandidacy;
  const r = validateContributionRequest(noAgent);
  assertEquals(r.ok, false);
  assert(r.errors.some((e) => e.path === "agent_name"));
  const withTask = validateContributionRequest({ ...validCandidacy, task_id: "auto:candidacy_source_missing:bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9" });
  assertEquals(withTask.ok, true);
  assertEquals(withTask.items[0].task_id, "auto:candidacy_source_missing:bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9");
  assertEquals(withTask.contributor.agent_name, AGENT);
});

Deno.test("來源優先等級只做分類，不擋提交：任意 host 可通過，缺來源／非 URL 退件", () => {
  assertEquals(sourceKind("https://db.cec.gov.tw/x"), "official");
  // 2026-09-17 起首頁一律降到最低等級：官方網域的首頁看不到那筆事實，
  // 卻跟公報的實際那一頁一樣只要 2 票——實查有 46 筆這樣的來源，6 筆吵成爭議。
  assertEquals(sourceKind("https://www.chcg.gov.tw/news/123"), "official");   // 縣政府 *.gov.tw 的內頁
  assertEquals(sourceKind("https://www.gov.taipei/News_Content.aspx?n=1"), "official");
  assertEquals(sourceKind("https://www.chcg.gov.tw/"), "other", "首頁撐不起具體宣稱");
  assertEquals(sourceKind("https://www.gov.taipei/"), "other", "首頁撐不起具體宣稱");
  assertEquals(sourceKind(CNA), "media");
  assertEquals(sourceKind("https://www.facebook.com/someone/posts/1"), "social");
  assertEquals(sourceKind("https://zh.wikipedia.org/wiki/x"), "other");
  assertEquals(sourceKind("https://evil-cec.gov.tw.example.com/"), "other"); // 後綴偽裝不算官方
  assertEquals(bestSourceKind(["https://blog.example.com/", CEC]), "official");

  assertEquals(checkSourceSet([]).ok, false, "缺 source_urls 退件");
  assertEquals(checkSourceSet(["not a url"]).ok, false, "非 URL 退件");
  assertEquals(checkSourceSet(["ftp://cec.gov.tw/x"]).ok, false, "非 http(s) 退件");
  assertEquals(checkSourceSet(["https://zh.wikipedia.org/wiki/x"]).ok, true, "任意 host 可通過（壞來源靠驗證投 disagree 過濾）");
  assertEquals(checkSourceSet(["https://www.facebook.com/someone/posts/1"]).ok, true, "只有社群也可以提交");
});

Deno.test("單筆 candidacy 合法", () => {
  const r = validateContributionRequest(validCandidacy);
  assertEquals(r.errors, []);
  assertEquals(r.ok, true);
  assertEquals(r.items.length, 1);
});

Deno.test("沒有來源、非 URL → 拒收並指出哪個；任意 host 可通過", () => {
  const none = validateContributionRequest({ ...validCandidacy, source_urls: [] });
  assertEquals(none.ok, false);
  assert(none.errors.some((e) => e.path === "source_urls"));

  const bad = validateContributionRequest({ ...validCandidacy, source_urls: ["陳素月 登記參選"] });
  assertEquals(bad.ok, false);
  assert(bad.errors.some((e) => e.path === "source_urls" && e.message.includes("陳素月 登記參選")));

  const anyHost = validateContributionRequest({ ...validCandidacy, source_urls: ["https://candidate-site.example.com/about"] });
  assertEquals(anyHost.ok, true);
});

Deno.test("policy：描述太短、分類不在清單、缺人物 → 三個錯", () => {
  const r = validateContributionRequest({
    agent_name: AGENT,
    contribution_type: "policy",
    payload: { title: "增設托育中心", description: "太短", category: "育兒" },
    source_urls: [CNA],
  });
  assertEquals(r.ok, false);
  assertEquals(r.errors.map((e) => e.path).sort(), ["payload.category", "payload.description", "payload.name"]);
});

Deno.test("correction：只接受白名單欄位", () => {
  const good = validateContributionRequest({
    agent_name: AGENT,
    contribution_type: "correction",
    payload: { target_table: "politicians", target_id: "bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9", field: "birth_year", correct_value: 1966, reason: "中選會 2024 立委選舉候選人資料出生年為 1966" },
    source_urls: [CEC],
  });
  assertEquals(good.ok, true);
  const bad = validateContributionRequest({
    agent_name: AGENT,
    contribution_type: "correction",
    payload: { target_table: "politicians", target_id: "x", field: "id", correct_value: "y", reason: "想把主鍵改掉看看會怎樣" },
    source_urls: [CEC],
  });
  assertEquals(bad.ok, false);
  assert(bad.errors.some((e) => e.path === "payload.field"));
});

Deno.test("批次：超過上限拒收；agent_name／contributor_url 會帶出", () => {
  const many = { agent_name: AGENT, contributor_url: "https://example.com", contributions: Array.from({ length: MAX_BATCH + 1 }, () => validCandidacy) };
  const r = validateContributionRequest(many);
  assertEquals(r.ok, false);
  assert(r.errors.some((e) => e.path === "contributions"));
  assertEquals(r.contributor, { agent_name: AGENT, url: "https://example.com" });

  const ok = validateContributionRequest({ agent_name: AGENT, contributions: [validCandidacy, validCandidacy] });
  assertEquals(ok.ok, true);
  assertEquals(ok.items.length, 2);
});

Deno.test("未知 contribution_type、payload 不是物件", () => {
  const r = validateContributionRequest({ agent_name: AGENT, contributions: [{ contribution_type: "rumor", payload: {}, source_urls: [CEC] }, { contribution_type: "policy", payload: "x", source_urls: [CEC] }] });
  assertEquals(r.ok, false);
  assertEquals(r.errors.map((e) => e.path), ["contribution_type", "payload"]);
});

Deno.test("去重雜湊：鍵順序不同視為同一筆，內容不同就不同", async () => {
  const a = canonicalPayload({ contribution_type: "policy", payload: { title: "A", category: "交通建設" }, source_urls: [] });
  const b = canonicalPayload({ contribution_type: "policy", payload: { category: "交通建設", title: "A" }, source_urls: [] });
  const c = canonicalPayload({ contribution_type: "policy", payload: { category: "交通建設", title: "B" }, source_urls: [] });
  assertEquals(a, b);
  assertEquals(await sha256Hex(a), await sha256Hex(b));
  assert((await sha256Hex(a)) !== (await sha256Hex(c)));
});

const validPolicy = {
  agent_name: AGENT,
  contribution_type: "policy",
  payload: {
    name: "王小明",
    title: "萬大捷運站區沿線街景商機再造",
    description: "依選舉公報所載政見，整頓站區沿線街景並導入商圈再造計畫。",
    category: "經濟發展與產業",
    election_id: 2024,
  },
  source_urls: [CEC],
};

const proposedDate = (v: unknown) => validateContributionRequest({ ...validPolicy, payload: { ...validPolicy.payload, proposed_date: v } });

Deno.test("提出日期：不填合法；未來日期與晚於該屆選舉年份都擋下", () => {
  // 查不到就別填——這是協議教 AI 的做法
  assertEquals(validateContributionRequest(validPolicy).errors.length, 0);

  // 2024 那屆的政見不可能在 2026 年提出。落庫端以前缺值就自動填當天，正是這樣把舊政見標成新承諾的
  assert(proposedDate("2026-09-11").errors.some((e) => e.path === "payload.proposed_date"));

  // 屆別對得上就放行
  assertEquals(proposedDate("2023-12-01").errors.length, 0);

  // 未來日期一律不收
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const future = validateContributionRequest({ ...validPolicy, payload: { ...validPolicy.payload, election_id: 2026, proposed_date: tomorrow } });
  assert(future.errors.some((e) => e.path === "payload.proposed_date"));

  // 格式錯的照舊擋
  assert(proposedDate("2024/01/13").errors.some((e) => e.path === "payload.proposed_date"));
});

Deno.test("提出日期：correction 允許清空，其他欄位不允許", () => {
  const correction = (changes: unknown) => validateContributionRequest({
    agent_name: AGENT,
    contribution_type: "correction",
    payload: {
      target_table: "policies",
      target_id: "00000000-0000-4000-8000-000000000001",
      changes,
      reason: "選舉公報查不到提出日期，原值是資料送進來的日子",
    },
    source_urls: [CEC],
  });

  assertEquals(correction([{ field: "proposed_date", current_value: "2026-09-11", correct_value: null }]).errors.length, 0);
  assert(correction([{ field: "title", correct_value: null }]).errors.some((e) => e.path.endsWith("correct_value")));
  assert(correction([{ field: "proposed_date", correct_value: "2099-01-01" }]).errors.some((e) => e.path.endsWith("correct_value")));
});

// 2026-09-19：election_result_missing 任務的答案帶三個結果欄位，之前 schema 直接無視
Deno.test("candidacy：election_result／votes_received／vote_percentage 選填但要對", () => {
  const ok = validateContributionRequest({ ...validCandidacy, payload: { ...validCandidacy.payload, election_result: "elected", votes_received: 29150, vote_percentage: 53.7 } });
  assertEquals(ok.errors, []);
  const bad = validateContributionRequest({ ...validCandidacy, payload: { ...validCandidacy.payload, election_result: "won", votes_received: -3, vote_percentage: 101 } });
  assertEquals(bad.errors.map((e) => e.path).sort(), ["payload.election_result", "payload.vote_percentage", "payload.votes_received"]);
});

// 2026-09-19 同名人物流程：吳品叡（嘉義縣，1986）有兩筆
Deno.test("merge_politician：keep／remove 都要 uuid 且不同、same_person 是布林、reason ≥20 字", () => {
  const base = { agent_name: "tester", contribution_type: "merge_politician", task_id: "auto:duplicate_politician:00000000-0000-4000-8000-000000000001|00000000-0000-4000-8000-000000000002", source_urls: ["https://db.cec.gov.tw/x"] };
  const ok = validateContributionRequest({ ...base, payload: { keep_id: "00000000-0000-4000-8000-000000000001", remove_id: "00000000-0000-4000-8000-000000000002", same_person: true, reason: "中選會歷屆參選同一筆：2022 朴子市長與 2026 縣長登記都是同一位，出生年相同" } });
  assertEquals(ok.errors, []);
  const bad = validateContributionRequest({ ...base, payload: { keep_id: "00000000-0000-4000-8000-000000000001", remove_id: "00000000-0000-4000-8000-000000000001", same_person: "yes", reason: "短" } });
  assertEquals(bad.errors.map((e) => e.path).sort(), ["payload.reason", "payload.remove_id", "payload.same_person"]);
});
