import { assert, assertEquals } from "jsr:@std/assert@1";
import { applyContribution } from "./apply-contribution.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";

/**
 * 軟移除之後，代理那一側看到的東西要一致：
 * 不能把進度寫進一筆讀者看不到的政見，也不能因為「同標題已存在」就以為新增成功。
 * 2026-09-16 小良哥：「這個軟移除，其他的 AI 能不能打得到啊？」
 */
const POL = "11111111-1111-4111-8111-111111111111";
const GONE = "22222222-2222-4222-8222-222222222222";
const LIVE = "33333333-3333-4333-8333-333333333333";
const SRC = "https://www.cna.com.tw/news/aipl/202609160001.aspx";

function seed() {
  return createFakeSupabase({
    politicians: [{ id: POL, name: "蘇巧慧" }],
    policies: [
      { id: GONE, politician_id: POL, title: "母雞帶小雞 - 最強新北隊", status: "Campaign Pledge", progress: 0, last_updated: "2025-11-05", removed_at: "2026-09-16T00:00:00Z", removed_reason: "這是選戰口號，不是政見" },
      { id: LIVE, politician_id: POL, title: "學童營養午餐全面免費", status: "Campaign Pledge", progress: 0, last_updated: "2025-11-05", removed_at: null },
    ],
    contributions: [], edit_history: [], contribution_tasks: [], tracking_logs: [],
  }).client;
}

Deno.test("已移除的政見不接受進度更新（用 policy_id 指名也不行）", async () => {
  const fake = seed();
  const out = await applyContribution(fake, {
    id: "c-1", contribution_type: "policy_progress", source_urls: [SRC], note: null, agent_name: "tester", contributor_url: null,
    payload: { policy_id: GONE, status: "In Progress", progress: 30, note: "已開始執行" },
  });
  assertEquals(out.status, "failed", `不該寫進已移除的政見：${out.message}`);
  assert((out.message ?? "").includes("移除"), out.message);
});

Deno.test("重交同標題不會讓已移除的政見復活，而且要講實話", async () => {
  const fake = seed();
  const out = await applyContribution(fake, {
    id: "c-2", contribution_type: "policy", source_urls: [SRC], note: null, agent_name: "tester", contributor_url: null,
    payload: { politician_id: POL, title: "母雞帶小雞 - 最強新北隊", description: "組建最強團隊打贏 2026 選戰。", category: "政治議題" },
  });
  assertEquals(out.status, "failed", "不可以回 applied 讓代理以為新增成功");
  assert((out.message ?? "").includes("先前已被移除"), out.message);
});

Deno.test("沒被移除的政見照常更新進度", async () => {
  const fake = seed();
  const out = await applyContribution(fake, {
    id: "c-3", contribution_type: "policy_progress", source_urls: [SRC], note: null, agent_name: "tester", contributor_url: null,
    payload: { policy_id: LIVE, status: "In Progress", progress: 30, note: "已編列預算" },
  });
  assertEquals(out.status, "applied", out.message);
});
