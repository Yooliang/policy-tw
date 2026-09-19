import { assertEquals } from "jsr:@std/assert@1";
import { askJev, buildPolicyAsk, JEV_MODEL, toRecords, validateRecord } from "./system-one.ts";

const target = { id: "aaaaaaaa-0000-0000-0000-000000000001", title: "新生兒補助10萬元", description: "承諾當選新北市長後，每位新生兒提供10萬元補助。", election_id: null };
const sibDated = { id: "bbbbbbbb-0000-0000-0000-000000000002", title: "學童營養午餐全面免費", description: "x", election_id: 2024 };
const sibUndated = { id: "cccccccc-0000-0000-0000-000000000003", title: "六大福利政見", description: null, election_id: null };
const elections = [
  { election_id: 2024, election_type: "立法委員", candidate_status: "confirmed", election_result: "elected" },
  { election_id: 2026, election_type: "縣市長", candidate_status: "registered", election_result: null },
];

// 藍圖 §2-1：事實放 state、選項放 criteria；§2-3：已知答案要放進 state 當參考
Deno.test("三題齊全時：兄弟政見進 others、已標屆別的進 already_labelled、criteria 各有兜底選項", () => {
  const { state, questions } = buildPolicyAsk(target, [sibDated, sibUndated], elections);
  assertEquals(Object.keys(questions).sort(), ["duplicate_of", "election", "is_policy"]);
  assertEquals(Object.keys(state.others as object), ["bbbbbbbb", "cccccccc"]);
  // 只有標了屆別的才算參考；沒標的放進去等於拿空白當答案
  assertEquals(state.already_labelled, [{ title: "學童營養午餐全面免費", election_id: 2024 }]);
  assertEquals(questions.duplicate_of.criteria.none !== undefined, true);
  assertEquals(questions.election.criteria.unknown !== undefined, true);
  assertEquals(Object.keys(questions.election.criteria).sort(), ["2024", "2026", "unknown"]);
});

Deno.test("沒有兄弟政見就不問排重、沒有參選紀錄就不問屆別：只剩一個選項的題目沒有意義", () => {
  const alone = buildPolicyAsk(target, [], []);
  assertEquals(Object.keys(alone.questions), ["is_policy"]);
  assertEquals("others" in alone.state, false);
  assertEquals("elections" in alone.state, false);
  // 自己不會出現在 others 裡
  const self = buildPolicyAsk(target, [target], elections);
  assertEquals("duplicate_of" in self.questions, false);
});

Deno.test("兄弟政見全沒標屆別時不放 already_labelled（放空陣列會讓模型以為參考資料是空的）", () => {
  const { state } = buildPolicyAsk(target, [sibUndated], elections);
  assertEquals("already_labelled" in state, false);
});

Deno.test("toRecords：每題一列、機率取被選中那個選項、成本平均分攤、model 用回應裡的帶日期版本", () => {
  const res = {
    model: "typesafe/jev-1.13-20260917",
    answers: {
      is_policy: { type: "choice", choice: "policy", probabilities: { policy: 0.97, not_policy: 0.03 }, confidence: 0.9 },
      election: { type: "choice", choice: "2026", probabilities: { "2026": 0.91, "2024": 0.05, unknown: 0.04 }, confidence: 0.8 },
    },
    usage: { input_tokens: 10, output_tokens: 2, cost: 0.00003 },
  };
  const rows = toRecords("policy", target.id, { target: {} }, res);
  assertEquals(rows.length, 2);
  assertEquals(rows[0].probability, 0.97);
  assertEquals(rows[1].choice, "2026");
  assertEquals(rows[1].probability, 0.91);
  assertEquals(rows[0].cost_usd, 0.000015);
  assertEquals(rows.every((r) => r.model === "typesafe/jev-1.13-20260917"), true);
  assertEquals(rows.every((r) => validateRecord(r) === null), true);
});

Deno.test("validateRecord：alias 版本、空 state、機率超界都要擋", () => {
  const ok = { subject_type: "policy", subject_id: "x", question: "is_policy", choice: "policy", probability: 0.9, confidence: null, probabilities: null, model: "typesafe/jev-1.13-20260917", state: { a: 1 }, cost_usd: null } as const;
  assertEquals(validateRecord(ok), null);
  assertEquals(validateRecord({ ...ok, model: JEV_MODEL })?.includes("alias"), true);
  assertEquals(validateRecord({ ...ok, state: {} })?.includes("state"), true);
  assertEquals(validateRecord({ ...ok, probability: 1.2 })?.includes("probability"), true);
  assertEquals(validateRecord({ ...ok, question: "vibes" as never })?.includes("question"), true);
});

Deno.test("askJev：釘住 typesafe/jev-1.13、打 decisions 端點；非 2xx 要丟錯", async () => {
  let sent: { url: string; body: Record<string, unknown> } | null = null;
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent = { url: String(url), body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ model: "typesafe/jev-1.13-20260917", answers: {}, usage: { input_tokens: 1, output_tokens: 1, cost: 0 } }), { status: 200 });
  }) as typeof fetch;
  await askJev("k", { a: 1 }, {}, fakeFetch);
  assertEquals(sent!.url.endsWith("/api/alpha/decisions"), true);
  assertEquals(sent!.body.model, "typesafe/jev-1.13");
  let threw = false;
  try {
    await askJev("k", { a: 1 }, {}, (async () => new Response("nope", { status: 500 })) as typeof fetch);
  } catch (e) {
    threw = String(e).includes("500");
  }
  assertEquals(threw, true);
});
