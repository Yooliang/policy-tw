// 強模型 uphold_with_correction 落庫（applyAdjudication）：更正來源要剔除正見自家網址、頂層來源是否改、review_notes 帶原來源
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { autoApplyContribution } from "./auto-apply.ts";

const SELF = "https://xn--2lw665d.tw/skill.md";
const OLD = "https://www.cna.com.tw/news/aipl/202609045002.aspx";
const NEW = "https://www.example.gov.tw/plan.pdf";
const PID = "bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9";
const C1 = "11111111-1111-4111-8111-111111111111";
const A1 = "22222222-2222-4222-8222-222222222222";

function setup(correctedSources: unknown) {
  const original = {
    id: C1, contribution_type: "policy", status: "disputed", agent_name: "alice", contributor_ip_hash: "ip-a",
    payload: { politician_id: PID, title: "長者健保全免", description: "65 歲以上長者健保費由市府全額補助，四年內逐步實施。", category: "社會福利", source_urls: [OLD] },
    source_urls: [OLD], note: null, contributor_url: null, review_notes: null, last_error: null,
  };
  const adjudication = {
    id: A1, contribution_type: "adjudication", status: "verified", agent_name: "console-strong-adjudicate", contributor_ip_hash: "ip-s", contributor_url: null, note: null,
    reviewed_by: "strong-adjudication", retry_count: 0,
    payload: { contribution_id: C1, verdict: "uphold_with_correction", reason: "打開官方 PDF 核對後，舊連結已失效，改用官方計畫書。 [strong-job:job-1]", checked_urls: [NEW],
      corrected_fields: { description: "65 歲以上長者健保費由市府全額補助，三年內逐步實施。", ...(correctedSources === undefined ? {} : { source_urls: correctedSources }) } },
    source_urls: [NEW],
  };
  return createFakeSupabase({
    contributions: [original, adjudication],
    politicians: [{ id: PID, name: "陳素月" }],
    policies: [],
    contribution_tasks: [{ id: "t1", task_type: "adjudicate", status: "open", target: { contribution_id: C1, requires_tier: "strong" }, source: "auto_dispute" }],
  });
}

Deno.test("更正來源：剔除自家網址後換掉頂層 source_urls 與 payload.source_urls，review_notes 記原來源", async () => {
  const fake = setup([SELF, NEW]);
  assertEquals((await autoApplyContribution(fake.client, A1)).status, "applied");
  const o = fake.db.contributions.find((c) => c.id === C1)!;
  assertEquals(o.status, "applied");
  assertEquals(o.source_urls, [NEW]);
  assertEquals((o.payload as Record<string, unknown>).source_urls, [NEW]);
  assertEquals((o.payload as Record<string, unknown>).description, "65 歲以上長者健保費由市府全額補助，三年內逐步實施。");
  assert(String(o.review_notes).includes("來源已更正") && String(o.review_notes).includes(`原來源：${OLD}`));
  assert(!JSON.stringify(o).includes("xn--2lw665d.tw"), "自家網址不會進原貢獻");
  assertEquals(fake.db.policies.length, 1);
});

Deno.test("更正來源：全是自家網址 → 頂層與 payload 來源都不改，review_notes 說明", async () => {
  const fake = setup([SELF]);
  assertEquals((await autoApplyContribution(fake.client, A1)).status, "applied");
  const o = fake.db.contributions.find((c) => c.id === C1)!;
  assertEquals(o.source_urls, [OLD]);
  assertEquals((o.payload as Record<string, unknown>).source_urls, [OLD]);
  assert(String(o.review_notes).includes("頂層來源未改") && String(o.review_notes).includes(`原來源：${OLD}`));
  assert(!JSON.stringify(o).includes("xn--2lw665d.tw"));
});

Deno.test("沒更正來源：頂層來源不動，review_notes 不帶來源說明", async () => {
  const fake = setup(undefined);
  assertEquals((await autoApplyContribution(fake.client, A1)).status, "applied");
  const o = fake.db.contributions.find((c) => c.id === C1)!;
  assertEquals(o.source_urls, [OLD]);
  assert(!String(o.review_notes).includes("原來源"));
});
