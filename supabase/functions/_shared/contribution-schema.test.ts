/**
 * 執行：cd supabase/functions && deno test --allow-read _shared/
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { canonicalPayload, MAX_BATCH, sha256Hex, validateContributionRequest } from "./contribution-schema.ts";
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
  assertEquals(sourceKind("https://www.chcg.gov.tw/"), "official");           // 縣政府 *.gov.tw
  assertEquals(sourceKind("https://www.gov.taipei/"), "official");
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
