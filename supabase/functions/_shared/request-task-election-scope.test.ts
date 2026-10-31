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

// ---- 去重：scope 要進查詢條件（同人同屆的承諾請求與政見請求互不擋） ----
import { findOpenTaskForTarget, findRecentlyHandled } from "./task-admin.ts";

// deno-lint-ignore no-explicit-any
function recorder(): { supabase: any; eqs: Array<[string, unknown]> } {
  const eqs: Array<[string, unknown]> = [];
  // deno-lint-ignore no-explicit-any
  const q: any = {
    select: () => q, limit: () => q, in: () => q, gte: () => q, like: () => q, is: () => q,
    eq: (col: string, v: unknown) => { eqs.push([col, v]); return q; },
    then: (res: (v: unknown) => unknown) => res({ data: [], error: null }),
  };
  return { supabase: { from: () => q }, eqs };
}
const has = (eqs: Array<[string, unknown]>, col: string, v: unknown) => eqs.some(([c, x]) => c === col && x === v);

Deno.test("已有 open 任務的判斷：帶 scope 就只比同範圍，承諾與政見互不擋", async () => {
  for (const scope of ["pledge", "tenure"]) {
    const r = recorder();
    await findOpenTaskForTarget(r.supabase, { politician_id: "p1", task_type: "policy_missing", election_id: 7, scope });
    assert(has(r.eqs, "target->>election_id", "7"));
    assert(has(r.eqs, "target->>scope", scope), `要比 scope=${scope}`);
  }
  const none = recorder();
  await findOpenTaskForTarget(none.supabase, { politician_id: "p1", task_type: "policy_missing" });
  assert(!none.eqs.some(([c]) => c === "target->>scope"), "沒帶 scope 不加條件（舊行為）");
});

Deno.test("近期處理過的判斷：帶 scope 一樣只比同範圍", async () => {
  const r = recorder();
  await findRecentlyHandled(r.supabase, { politician_id: "p1", task_type: "policy_missing", election_id: 7, scope: "tenure" }, 5);
  assert(has(r.eqs, "target->>scope", "tenure"));
});
