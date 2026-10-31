import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { buildRequestTaskText } from "./request-task.ts";

// 人物頁各屆段落尾的 AI 卡片：請求帶 election_id，任務標題與說明要寫清楚「查某人某屆（當選與否）的政見／承諾」，
// 不是籠統的「補最新」。當選看 politician_elections.candidacy_status = 'elected'（後端自己查，不信前端）。

const base = { kind: "policy" as const, politician_id: null, policy_id: null, politician_name: "某人", election_id: 7, election_name: "2022 九合一" };

Deno.test("當選的那一屆：查政見（任內），標題寫明屆別與當選", () => {
  const t = buildRequestTaskText({ ...base, elected: true, scope: "tenure" });
  assert(t.title.includes("2022 九合一（當選）的政見"), t.title);
  assert(t.description.includes("任內"));
  assert(t.description.includes("election_id 填 7"));
});

Deno.test("沒當選或還沒選的那一屆：查選前承諾，不拿現任施政交", () => {
  const t = buildRequestTaskText({ ...base, elected: false });
  assert(t.title.includes("2022 九合一（未當選或尚未投票）的承諾"), t.title);
  assert(t.description.includes("選前提出"));
  assert(t.description.includes("election_id 填 7"));
});

Deno.test("沒帶 election_id：維持舊的籠統文字（2026 這一屆的承諾）", () => {
  const t = buildRequestTaskText({ kind: "policy", politician_id: null, policy_id: null, politician_name: "某人" });
  assert(t.description.includes("2026 這一屆的承諾"));
  assertNotEquals(t.title, buildRequestTaskText({ ...base, elected: true }).title);
  assertEquals(t.title, "補「某人」的政見（網站訪客請求）");
});

Deno.test("卡片所在的分頁決定查什麼：政見分頁查政見、承諾分頁查承諾，不看當選與否", () => {
  const tenureNotElected = buildRequestTaskText({ ...base, elected: false, scope: "tenure" });
  assert(tenureNotElected.title.includes("的政見"), tenureNotElected.title);
  const pledgeElected = buildRequestTaskText({ ...base, elected: true, scope: "pledge" });
  assert(pledgeElected.title.includes("2022 九合一（當選）的承諾"), pledgeElected.title);
  assert(pledgeElected.description.includes("選前提出"));
});
