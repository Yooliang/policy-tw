// 帶了 politician_id 也帶了姓名，落庫前要確認兩者是同一人（2026-09-23 agy 審查）。
// 原本只確認 id 存在就採用：id 填錯的參選紀錄會安靜地掛到別人名下。
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { applyContribution } from "./apply-contribution.ts";

const C1 = "11111111-1111-4111-8111-111111111111";
const P1 = "bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9";

const row = (name: string) => ({
  id: C1, contribution_type: "politician", status: "verified", agent_name: "alice", contributor_ip_hash: "ip-a", contributor_url: null, note: null, retry_count: 0,
  payload: { politician_id: P1, name, region: "臺北市", bio: "測試用簡介，來源寫到的學經歷" },
  source_urls: ["https://example.test/a"],
});

Deno.test("id 與姓名不是同一人 → 不落庫", async () => {
  const f = createFakeSupabase({ contributions: [row("王小明")], politicians: [{ id: P1, name: "陳素月", region: "彰化縣" }] });
  const out = await applyContribution(f.client, row("王小明") as never);
  assertEquals(out.status === "applied", false);
  assertStringIncludes(String(out.message), "不是同一人");
});

Deno.test("姓名只差臺／台或空白 → 照常採用那位", async () => {
  const f = createFakeSupabase({ contributions: [row("陳 素月")], politicians: [{ id: P1, name: "陳素月", region: "彰化縣" }] });
  const out = await applyContribution(f.client, row("陳 素月") as never);
  assertEquals(out.status, "applied");
});

Deno.test("姓名是那位的別名（politician_keys alias_name）→ 照常採用", async () => {
  const f = createFakeSupabase({
    contributions: [row("Kolas")],
    politicians: [{ id: P1, name: "谷辣斯．尤達卡", region: "臺北市" }],
    politician_keys: [{ politician_id: P1, key_type: "alias_name", key_value: "Kolas", strength: 3 }],
  });
  const out = await applyContribution(f.client, row("Kolas") as never);
  assertEquals(out.status, "applied");
});
