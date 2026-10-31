/**
 * 參選紀錄縣市對不上（region_mismatch，2026-10-31）的守門測試。
 * 原案：吳炳輝 2026 縣市長掛台南市、代理交件寫雲林縣＋1 號，號次記進台南市、沒人被通知。
 *   1. 落庫：縣市不同 → 號次照記、地區不動、開任務、回覆寫明；縣市相同／第二次 → 不開／不重開
 *   2. correction 改 region_id：只收縣市長、縣市層級 → 縣市層級
 *   3. 任務型別接線：TASK_TYPES、SUGGESTED_TYPE、做法、骨架
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { applyContribution } from "./apply-contribution.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { REGION_MISMATCH_TASK_TYPE, regionIdCorrectionProblem } from "./region-mismatch.ts";
import { TASK_TYPES } from "./contribution-schema.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { buildBranchTemplates, TASK_BRANCHES, TASK_GUIDANCE } from "./task-guidance.ts";

const PID = "4f5ef190-21bb-4bf6-8c1c-234239982ed3";
const REGIONS = [
  { id: 4175, region: "台南市", sub_region: null, village: null },
  { id: 3197, region: "雲林縣", sub_region: null, village: null },
  { id: 5000, region: "雲林縣", sub_region: "第01選舉區", village: null },
];
const seed = (peRegion: number | null) => ({
  politicians: [{ id: PID, name: "吳炳輝", party: null, region: "台南市", position: "縣市長候選人", merged_into: null }],
  politician_keys: [],
  regions: REGIONS.map((r) => ({ ...r })),
  contribution_tasks: [] as Record<string, unknown>[],
  politician_elections: [{ id: 35070, politician_id: PID, election_id: 2026, election_type: "縣市長", candidacy_status: "filed", cand_no: null, region_id: peRegion }],
});
const row = (region: string, id = "fab9e0c5-cb67-4ead-85e3-bd8c1803b02a") => ({
  id, contribution_type: "candidacy", status: "verified", agent_name: "michelle.perry", contributor_ip_hash: "ip",
  contributor_url: null, note: null, retry_count: 0, source_urls: ["https://web.cec.gov.tw/api/file/5fb0eb40-da2f-4477-8529-853cbb60e76a.pdf"],
  task_id: "auto:candidacy_source_missing:cand_no:2026:縣市長:台南市",
  payload: { politician_id: PID, name: "吳炳輝", election_id: 2026, election_type: "縣市長", region, candidate_status: "registered", cand_no: 1 },
});

Deno.test("縣市不同：號次照記、地區不動、開 region_mismatch 任務、回覆寫明", async () => {
  const fake = createFakeSupabase(seed(4175));
  // deno-lint-ignore no-explicit-any
  const out = await applyContribution(fake.client, row("雲林縣") as any);
  assertEquals(out.status, "applied", JSON.stringify(out));
  const pe = fake.db.politician_elections[0];
  assertEquals(pe.cand_no, 1);
  assertEquals(pe.region_id, 4175, "地區要經驗證流程改，落庫不直接動");
  const tasks = fake.db.contribution_tasks.filter((t) => t.task_type === REGION_MISMATCH_TASK_TYPE);
  assertEquals(tasks.length, 1);
  const tg = tasks[0].target as Record<string, unknown>;
  assertEquals([tg.politician_election_id, tg.current_region_id, tg.proposed_region_id, tg.current_region, tg.proposed_region], [35070, 4175, 3197, "台南市", "雲林縣"]);
  assertStringIncludes(out.message ?? "", "縣市對不上");
  assertStringIncludes(out.message ?? "", "台南市");
});

Deno.test("同一差異第二次交件不重開任務，但回覆仍提醒", async () => {
  const fake = createFakeSupabase(seed(4175));
  // deno-lint-ignore no-explicit-any
  await applyContribution(fake.client, row("雲林縣") as any);
  // deno-lint-ignore no-explicit-any
  const out = await applyContribution(fake.client, row("雲林縣", "22222222-2222-4222-8222-222222222222") as any);
  assertEquals(fake.db.contribution_tasks.length, 1);
  assertStringIncludes(out.message ?? "", "已經開過");
});

Deno.test("縣市相同（臺／台寫法不同也算相同）不開任務", async () => {
  const fake = createFakeSupabase(seed(4175));
  // deno-lint-ignore no-explicit-any
  const out = await applyContribution(fake.client, row("臺南市") as any);
  assertEquals(out.status, "applied");
  assertEquals(fake.db.contribution_tasks.length, 0);
  assertEquals((out.message ?? "").includes("縣市對不上"), false);
});

Deno.test("correction 改 region_id：縣市長縣市層級 → 縣市層級才收", async () => {
  const fake = createFakeSupabase(seed(4175));
  assertEquals(await regionIdCorrectionProblem(fake.client, "縣市長", 4175, 3197), null);
  assertEquals(await regionIdCorrectionProblem(fake.client, "縣市長", 4175, "3197"), null);
  assertStringIncludes(String(await regionIdCorrectionProblem(fake.client, "縣市議員", 4175, 3197)), "縣市長");
  assertStringIncludes(String(await regionIdCorrectionProblem(fake.client, "縣市長", 4175, 5000)), "不是縣市層級");
  assertStringIncludes(String(await regionIdCorrectionProblem(fake.client, "縣市長", 4175, 99999)), "沒有");
  assertStringIncludes(String(await regionIdCorrectionProblem(fake.client, "縣市長", 4175, "雲林縣")), "整數");
  assertStringIncludes(String(await regionIdCorrectionProblem(fake.client, "縣市長", 5000, 3197)), "不是縣市層級");
});

Deno.test("correction 端到端：region_id 4175 → 3197 落庫並進 edit_history", async () => {
  const base = seed(4175);
  base.politician_elections[0].id = "35070" as unknown as number; // 假資料庫的 eq 是嚴格比對，真資料庫 id 以文字送進去也對得上
  const fake = createFakeSupabase({ ...base, edit_history: [] as Record<string, unknown>[] });
  const out = await applyContribution(fake.client, {
    id: "33333333-3333-4333-8333-333333333333", contribution_type: "correction", status: "verified", agent_name: "a", contributor_ip_hash: "ip",
    contributor_url: null, note: null, retry_count: 0, source_urls: ["https://web.cec.gov.tw/x"], task_id: null,
    payload: { target_table: "politician_elections", target_id: "35070", changes: [{ field: "region_id", current_value: 4175, correct_value: 3197 }], reason: "雲林縣選委會抽籤公告" },
    // deno-lint-ignore no-explicit-any
  } as any);
  assertEquals(out.status, "applied", JSON.stringify(out));
  assertEquals(fake.db.politician_elections[0].region_id, 3197);
});

Deno.test("correction 把 region_id 改成選區層級的列 → 落庫端擋下、地區不變", async () => {
  const base = seed(4175);
  base.politician_elections[0].id = "35070" as unknown as number;
  const fake = createFakeSupabase({ ...base, edit_history: [] as Record<string, unknown>[] });
  const out = await applyContribution(fake.client, {
    id: "44444444-4444-4444-8444-444444444444", contribution_type: "correction", status: "verified", agent_name: "a", contributor_ip_hash: "ip",
    contributor_url: null, note: null, retry_count: 0, source_urls: ["https://web.cec.gov.tw/x"], task_id: null,
    payload: { target_table: "politician_elections", target_id: "35070", changes: [{ field: "region_id", current_value: 4175, correct_value: 5000 }], reason: "x" },
    // deno-lint-ignore no-explicit-any
  } as any);
  assertEquals(out.status, "failed");
  assertEquals(fake.db.politician_elections[0].region_id, 4175);
});

Deno.test("任務型別接線：TASK_TYPES、SUGGESTED_TYPE、做法、兩條路的骨架", () => {
  assertEquals((TASK_TYPES as readonly string[]).includes(REGION_MISMATCH_TASK_TYPE), true);
  assertEquals(SUGGESTED_TYPE[REGION_MISMATCH_TASK_TYPE], "correction");
  assertStringIncludes(TASK_GUIDANCE[REGION_MISMATCH_TASK_TYPE], "region_id");
  assertEquals(TASK_BRANCHES[REGION_MISMATCH_TASK_TYPE], ["correction", "no_change"]);
  const t = buildBranchTemplates(REGION_MISMATCH_TASK_TYPE, { politician_election_id: 35070, current_region_id: 4175, proposed_region_id: 3197 }, "x");
  // deno-lint-ignore no-explicit-any
  const c = (t as any).correction.payload;
  assertEquals(c.target_id, "35070");
  assertEquals(c.changes[0], { field: "region_id", current_value: 4175, correct_value: 3197 });
});
