import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleContribute } from "./contribute-handler.ts";

/**
 * 落庫前置檢查（2026-09-27 裁決，見 apply-precheck.ts）：連續 5 次「驗證通過→落庫才失敗→重試三次退件」
 * （#261／#262／#275／#276／#263）之後，交件時先唯讀查一遍 apply-contribution.ts 會用到的對象，
 * 查到「一定落不了庫」就整批 400，不算被拒。
 *
 * 這裡走真的 handleContribute（假 supabase＋假投票端），每種型別各驗：目標不存在→400、存在→照常收、
 * 查詢本身出錯→照常收（不能讓系統自己的錯擋掉代理）。
 */

type TableConfig = { data?: unknown[]; error?: { message: string } | null };

/** 泛用假 supabase：依表名回覆設定好的資料／錯誤；insert／delete 一律成功。 */
function fakeSupabase(tables: Record<string, TableConfig>) {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const client = {
    from(table: string) {
      const cfg = tables[table];
      const result = { data: cfg?.data ?? [], error: cfg?.error ?? null, count: 0 };
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        is: () => chain,
        gte: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: (result.data as Array<Record<string, unknown>>)[0] ?? null, error: result.error }),
        insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
          const arr = Array.isArray(rows) ? rows : [rows];
          for (const r of arr) inserted.push({ table, row: r });
          return {
            select: () => ({ data: arr.map((r, i) => ({ id: `new-${i}`, payload_hash: (r as { payload_hash?: string }).payload_hash })), error: null }),
          };
        },
        delete: () => ({ in: () => ({ error: null }) }),
        then: (res: (v: typeof result) => unknown) => res(result),
      };
      return chain;
    },
  };
  return { client, inserted };
}

const POLITICIAN_ID = "8aa6ee40-231a-447a-a967-99bcf8b35d3f";
const OTHER_POLITICIAN_ID = "9bb7ff51-342b-558b-b078-aacdf9c46e40";
const POLICY_ID = "22222222-2222-4222-8222-222222222222";
const noVote = () => Promise.resolve({ status: 403, body: { error: "self_vote" } });

// ---- correction ---------------------------------------------------------

function correctionBody(targetTable: string, targetId: string) {
  return {
    agent_name: "tester",
    contribution_type: "correction",
    payload: { target_table: targetTable, target_id: targetId, changes: [{ field: targetTable === "politician_elections" ? "candidate_status" : targetTable === "policies" ? "title" : "party", correct_value: targetTable === "politicians" ? "測試黨" : targetTable === "policies" ? "換一個標題" : "qualified" }], reason: "測試用理由，至少十個字才會過驗證" },
    source_urls: ["https://www.cna.com.tw/news/aipl/test.aspx"],
  };
}

Deno.test("correction：目標人物不存在 → 400 target_not_found", async () => {
  const { client, inserted } = fakeSupabase({ politicians: { data: [] } });
  const res = await handleContribute(client, "https://x", correctionBody("politicians", POLITICIAN_ID), "ip-1", noVote);
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).error, "target_not_found");
  assertEquals(inserted.filter((r) => r.table === "contributions").length, 0, "查到問題不該落庫任何東西");
});

Deno.test("correction：目標人物已合併 → 400 apply_would_fail", async () => {
  const { client } = fakeSupabase({ politicians: { data: [{ id: POLITICIAN_ID, merged_into: OTHER_POLITICIAN_ID }] } });
  const res = await handleContribute(client, "https://x", correctionBody("politicians", POLITICIAN_ID), "ip-1", noVote);
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).error, "apply_would_fail");
  assert(String((res.body as { errors?: Array<{ message: string }> }).errors?.[0]?.message).includes(OTHER_POLITICIAN_ID));
});

Deno.test("correction：目標人物存在、未合併 → 照常收", async () => {
  const { client, inserted } = fakeSupabase({ politicians: { data: [{ id: POLITICIAN_ID, merged_into: null }] } });
  const res = await handleContribute(client, "https://x", correctionBody("politicians", POLITICIAN_ID), "ip-1", noVote);
  assertEquals(res.status, 201);
  assertEquals((res.body as Record<string, unknown>).status, "pending");
  assertEquals(inserted.filter((r) => r.table === "contributions").length, 1);
});

Deno.test("correction：目標政見已移除 → 400 apply_would_fail", async () => {
  const { client } = fakeSupabase({ policies: { data: [{ id: POLICY_ID, removed_at: "2026-01-01T00:00:00Z" }] } });
  const res = await handleContribute(client, "https://x", correctionBody("policies", POLICY_ID), "ip-1", noVote);
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).error, "apply_would_fail");
});

Deno.test("correction：目標政見存在、未移除 → 照常收", async () => {
  const { client } = fakeSupabase({ policies: { data: [{ id: POLICY_ID, removed_at: null }] } });
  const res = await handleContribute(client, "https://x", correctionBody("policies", POLICY_ID), "ip-1", noVote);
  assertEquals(res.status, 201);
});

Deno.test("correction：目標參選紀錄（整數 id）不存在 → 400 target_not_found", async () => {
  const { client } = fakeSupabase({ politician_elections: { data: [] } });
  const res = await handleContribute(client, "https://x", correctionBody("politician_elections", "9827"), "ip-1", noVote);
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).error, "target_not_found");
});

Deno.test("correction：目標參選紀錄存在 → 照常收", async () => {
  const { client } = fakeSupabase({ politician_elections: { data: [{ id: 9827 }] } });
  const res = await handleContribute(client, "https://x", correctionBody("politician_elections", "9827"), "ip-1", noVote);
  assertEquals(res.status, 201);
});

Deno.test("correction：查詢本身出錯（資料庫錯誤）→ 照常收，不擋代理", async () => {
  const { client } = fakeSupabase({ politicians: { data: [], error: { message: "boom：連線逾時" } } });
  const res = await handleContribute(client, "https://x", correctionBody("politicians", POLITICIAN_ID), "ip-1", noVote);
  assertEquals(res.status, 201, "查詢出錯不能擋交件");
});

// ---- removal --------------------------------------------------------------

function removalBody(policyId: string) {
  return {
    agent_name: "tester",
    contribution_type: "removal",
    payload: { target_table: "policies", target_id: policyId, reason: "查遍官方與媒體都沒有這個宣稱，是誤植的內容" },
    source_urls: ["https://www.cna.com.tw/news/aipl/test.aspx"],
  };
}

Deno.test("removal：目標政見不存在 → 400 target_not_found", async () => {
  const { client } = fakeSupabase({ policies: { data: [] } });
  const res = await handleContribute(client, "https://x", removalBody(POLICY_ID), "ip-1", noVote);
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).error, "target_not_found");
});

Deno.test("removal：目標政見已移除過 → 400 apply_would_fail（不用再交一次）", async () => {
  const { client } = fakeSupabase({ policies: { data: [{ id: POLICY_ID, removed_at: "2026-01-01T00:00:00Z" }] } });
  const res = await handleContribute(client, "https://x", removalBody(POLICY_ID), "ip-1", noVote);
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).error, "apply_would_fail");
});

Deno.test("removal：目標政見存在、未移除 → 照常收", async () => {
  const { client } = fakeSupabase({ policies: { data: [{ id: POLICY_ID, removed_at: null }] } });
  const res = await handleContribute(client, "https://x", removalBody(POLICY_ID), "ip-1", noVote);
  assertEquals(res.status, 201);
});

// ---- merge_politician -------------------------------------------------------

function mergeBody(keep: string, remove: string) {
  return {
    agent_name: "tester",
    contribution_type: "merge_politician",
    payload: { keep_id: keep, remove_id: remove, same_person: true, reason: "中選會候選人資料庫查得到同一人的兩筆紀錄" },
    source_urls: ["https://db.cec.gov.tw/test"],
  };
}

Deno.test("merge_politician：keep_id 不存在 → 400 target_not_found", async () => {
  const { client } = fakeSupabase({ politicians: { data: [{ id: OTHER_POLITICIAN_ID, merged_into: null }] } });
  const res = await handleContribute(client, "https://x", mergeBody(POLITICIAN_ID, OTHER_POLITICIAN_ID), "ip-1", noVote);
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).error, "target_not_found");
});

Deno.test("merge_politician：remove_id 已經合併過 → 400 apply_would_fail", async () => {
  const { client } = fakeSupabase({ politicians: { data: [{ id: POLITICIAN_ID, merged_into: null }, { id: OTHER_POLITICIAN_ID, merged_into: "third-uuid" }] } });
  const res = await handleContribute(client, "https://x", mergeBody(POLITICIAN_ID, OTHER_POLITICIAN_ID), "ip-1", noVote);
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).error, "apply_would_fail");
});

Deno.test("merge_politician：兩邊都存在、都沒合併過 → 照常收", async () => {
  const { client } = fakeSupabase({ politicians: { data: [{ id: POLITICIAN_ID, merged_into: null }, { id: OTHER_POLITICIAN_ID, merged_into: null }] } });
  const res = await handleContribute(client, "https://x", mergeBody(POLITICIAN_ID, OTHER_POLITICIAN_ID), "ip-1", noVote);
  assertEquals(res.status, 201);
});

// ---- policy / policy_progress ----------------------------------------------

function policyBody(politicianId: string) {
  return {
    agent_name: "tester",
    contribution_type: "policy",
    payload: { politician_id: politicianId, title: "推動測試用市政建設方案", description: "這是一段至少二十個字的政見說明內容用來通過驗證", category: "都市發展與住宅" },
    source_urls: ["https://www.cna.com.tw/news/aipl/test.aspx", "https://udn.com/news/story/test"],
  };
}

Deno.test("policy：politician_id 不存在 → 400 target_not_found", async () => {
  const { client } = fakeSupabase({ politicians: { data: [] } });
  const res = await handleContribute(client, "https://x", policyBody(POLITICIAN_ID), "ip-1", noVote);
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).error, "target_not_found");
});

Deno.test("policy：politician_id 已被合併 → 400 apply_would_fail", async () => {
  const { client } = fakeSupabase({ politicians: { data: [{ id: POLITICIAN_ID, merged_into: OTHER_POLITICIAN_ID }] } });
  const res = await handleContribute(client, "https://x", policyBody(POLITICIAN_ID), "ip-1", noVote);
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).error, "apply_would_fail");
});

Deno.test("policy：politician_id 存在 → 照常收", async () => {
  const { client } = fakeSupabase({ politicians: { data: [{ id: POLITICIAN_ID, merged_into: null }] } });
  const res = await handleContribute(client, "https://x", policyBody(POLITICIAN_ID), "ip-1", noVote);
  assertEquals(res.status, 201);
});

function policyProgressBody(policyId: string) {
  return {
    agent_name: "tester",
    contribution_type: "policy_progress",
    payload: { policy_id: policyId, status: "In Progress", progress: 40, note: "依市府新聞稿，工程已動工，預計明年完工", date: "2026-09-01" },
    source_urls: ["https://www.cna.com.tw/news/aipl/test.aspx", "https://udn.com/news/story/test"],
  };
}

Deno.test("policy_progress：policy_id 不存在 → 400 target_not_found", async () => {
  const { client } = fakeSupabase({ policies: { data: [] } });
  const res = await handleContribute(client, "https://x", policyProgressBody(POLICY_ID), "ip-1", noVote);
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).error, "target_not_found");
});

Deno.test("policy_progress：policy_id 已被移除 → 400 apply_would_fail", async () => {
  const { client } = fakeSupabase({ policies: { data: [{ id: POLICY_ID, removed_at: "2026-01-01T00:00:00Z" }] } });
  const res = await handleContribute(client, "https://x", policyProgressBody(POLICY_ID), "ip-1", noVote);
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).error, "apply_would_fail");
});

Deno.test("policy_progress：policy_id 存在 → 照常收", async () => {
  const { client } = fakeSupabase({ policies: { data: [{ id: POLICY_ID, removed_at: null }] } });
  const res = await handleContribute(client, "https://x", policyProgressBody(POLICY_ID), "ip-1", noVote);
  assertEquals(res.status, 201);
});

// ---- candidacy --------------------------------------------------------------

function candidacyBody(politicianId: string, electionType = "縣市議員") {
  return {
    agent_name: "tester",
    contribution_type: "candidacy",
    payload: { politician_id: politicianId, election_id: 2026, election_type: electionType, region: "新北市", candidate_status: "registered" },
    source_urls: ["https://db.cec.gov.tw/test"],
  };
}

Deno.test("candidacy：politician_id 不存在 → 400 target_not_found", async () => {
  const { client } = fakeSupabase({ politicians: { data: [] } });
  const res = await handleContribute(client, "https://x", candidacyBody(POLITICIAN_ID), "ip-1", noVote);
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).error, "target_not_found");
});

Deno.test("candidacy：politician_id 已被合併 → 400 apply_would_fail", async () => {
  const { client } = fakeSupabase({ politicians: { data: [{ id: POLITICIAN_ID, merged_into: OTHER_POLITICIAN_ID }] } });
  const res = await handleContribute(client, "https://x", candidacyBody(POLITICIAN_ID), "ip-1", noVote);
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).error, "apply_would_fail");
});

Deno.test("candidacy：同一年已有另一種正式參選紀錄 → 400 apply_would_fail（electionTypeSwitch 同一套判準）", async () => {
  const { client } = fakeSupabase({
    politicians: { data: [{ id: POLITICIAN_ID, merged_into: null }] },
    politician_elections: { data: [{ politician_id: POLITICIAN_ID, election_id: 2026, election_type: "縣市長", candidate_status: "registered" }] },
  });
  const res = await handleContribute(client, "https://x", candidacyBody(POLITICIAN_ID, "縣市議員"), "ip-1", noVote);
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).error, "apply_would_fail");
  assert(String((res.body as { errors?: Array<{ message: string }> }).errors?.[0]?.message).includes("正式參選紀錄"));
});

Deno.test("candidacy：同一年已有紀錄但不是正式狀態（傳聞）→ 照常收", async () => {
  const { client } = fakeSupabase({
    politicians: { data: [{ id: POLITICIAN_ID, merged_into: null }] },
    politician_elections: { data: [{ politician_id: POLITICIAN_ID, election_id: 2026, election_type: "縣市長", candidate_status: "rumored" }] },
  });
  const res = await handleContribute(client, "https://x", candidacyBody(POLITICIAN_ID, "縣市議員"), "ip-1", noVote);
  assertEquals(res.status, 201);
});

Deno.test("candidacy：politician_id 存在、沒有衝突的既有紀錄 → 照常收", async () => {
  const { client } = fakeSupabase({ politicians: { data: [{ id: POLITICIAN_ID, merged_into: null }] }, politician_elections: { data: [] } });
  const res = await handleContribute(client, "https://x", candidacyBody(POLITICIAN_ID), "ip-1", noVote);
  assertEquals(res.status, 201);
});

// ---- no_change ----------------------------------------------------------------

const MANUAL_TASK = "77777777-7777-4777-8777-777777777777";

function noChangeBody(taskId: string) {
  return {
    agent_name: "tester",
    contribution_type: "no_change",
    payload: { task_id: taskId, outcome: "confirmed", checked_urls: ["https://www.cna.com.tw/news/aipl/test.aspx"], finding: "核對官網現職與資料庫一致，沒有異動" },
    source_urls: ["https://www.cna.com.tw/news/aipl/test.aspx"],
  };
}

Deno.test("no_change：手動任務不存在（已被刪）→ 400 target_not_found", async () => {
  const { client } = fakeSupabase({ contribution_tasks: { data: [] } });
  const res = await handleContribute(client, "https://x", noChangeBody(MANUAL_TASK), "ip-1", noVote);
  assertEquals(res.status, 400);
  assertEquals((res.body as Record<string, unknown>).error, "target_not_found");
});

Deno.test("no_change：手動任務存在 → 照常收", async () => {
  const { client } = fakeSupabase({ contribution_tasks: { data: [{ id: MANUAL_TASK }] } });
  const res = await handleContribute(client, "https://x", noChangeBody(MANUAL_TASK), "ip-1", noVote);
  assertEquals(res.status, 201);
});

Deno.test("no_change：auto: 開頭的自動缺口不查任務表，照常收", async () => {
  const { client } = fakeSupabase({ contribution_tasks: { data: [] } });
  const res = await handleContribute(client, "https://x", noChangeBody("auto:legacy_audit:98b8b1ff-d085-4597-8384-a02461f773f6"), "ip-1", noVote);
  assertEquals(res.status, 201, "auto: 任務不存在於 contribution_tasks 是正常的，不該被擋");
});

// ---- gate_rejections 記錄 ---------------------------------------------------

Deno.test("查到問題會記一筆 gate_rejections（endpoint 用 via），沿用 verify-handler 的做法", async () => {
  const { client, inserted } = fakeSupabase({ politicians: { data: [] } });
  const res = await handleContribute(client, "https://x", correctionBody("politicians", POLITICIAN_ID), "ip-1", noVote, "report");
  assertEquals(res.status, 400);
  const gate = inserted.find((r) => r.table === "gate_rejections");
  assertEquals(gate?.row.gate, "target_not_found");
  assertEquals(gate?.row.endpoint, "report");
});
