import { assertEquals } from "jsr:@std/assert";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { politicianIdFromTask, withTaskPolitician } from "./task-politician.ts";
import { applyContribution } from "./apply-contribution.ts";

// 2026-09-23 W-Policy d5059957（呂承祐）：profile_gap 交的 politician 只帶 name，落庫用姓名猜成 new、走 INSERT 建空人物
const PID = "d9258d9f-20bd-4c50-91e4-84ff9c5bb563";

Deno.test("任務編號拿得出 profile_gap 指的那位；別的任務不碰", () => {
  assertEquals(politicianIdFromTask(`auto:profile_gap:${PID}`), PID);
  assertEquals(politicianIdFromTask(`auto:policy_missing:${PID}`), null);
  assertEquals(politicianIdFromTask(null), null);
  assertEquals(withTaskPolitician("politician", { name: "呂承祐" }, `auto:profile_gap:${PID}`), { name: "呂承祐", politician_id: PID });
  assertEquals(withTaskPolitician("politician", { name: "呂承祐", politician_id: "x" }, `auto:profile_gap:${PID}`), { name: "呂承祐", politician_id: "x" }, "自己帶了就不蓋掉");
  assertEquals(withTaskPolitician("policy", { name: "呂承祐" }, `auto:profile_gap:${PID}`), { name: "呂承祐" });
});

Deno.test("落庫：沒帶 id 的 profile_gap 補欄位，更新任務指的那位，不建新人物（即使有同名者）", async () => {
  const other = "11111111-1111-4111-8111-111111111111";
  const fake = createFakeSupabase({
    politicians: [
      { id: PID, name: "呂承祐", party: "台灣民眾黨", region: "基隆市", position: "縣市議員候選人", education: null, experience: null },
      { id: other, name: "呂承祐", party: "無黨籍", region: "台南市", position: "村里長" },
    ],
    politician_keys: [],
  });
  const row = {
    id: "22222222-2222-4222-8222-222222222222", contribution_type: "politician", status: "verified", agent_name: "a", contributor_ip_hash: "ip",
    contributor_url: null, note: null, retry_count: 0, source_urls: ["https://www.tpp.org.tw/x"],
    task_id: `auto:profile_gap:${PID}`,
    payload: { name: "呂承祐", education: ["國防醫學院 碩士"], experience: ["宏安國際有限公司技術長"] },
  };
  // deno-lint-ignore no-explicit-any
  const out = await applyContribution(fake.client, row as any);
  assertEquals(out.status, "applied", JSON.stringify(out));
  assertEquals(fake.db.politicians.length, 2, "不能多建一筆");
});
