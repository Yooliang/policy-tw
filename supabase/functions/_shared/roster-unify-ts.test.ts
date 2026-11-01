/**
 * 名單清查收斂（2026-11-01，協議 1.109.0）的 TS 端守門：交件接線（TASK_BRANCHES）、現況帶 items 與提示、2026 登記名冊轉 items、
 * 落庫端對「單位清查已列出」的縣市差異不再另開 region_mismatch 任務（SQL 端見 roster-unify.test.ts）。
 * 還原驗證：落庫端不看 rpc 結果就開任務、現況不帶 items，對應測試會紅（test C 兩條）。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { applyContribution } from "./apply-contribution.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { REGION_MISMATCH_TASK_TYPE } from "./region-mismatch.ts";
import { TASK_BRANCHES } from "./task-guidance.ts";
import { registrationItems, ROSTER_ITEMS_HINT, shapeTaskCurrent, type TaskContextData } from "./task-context.ts";

Deno.test("接線：roster_check 底下可以交 candidacy／correction／election_results／reassign_candidacy／no_change", () => {
  for (const t of ["roster_check", "candidacy", "correction", "election_results", "reassign_candidacy", "no_change"]) assert(TASK_BRANCHES.roster_check.includes(t), t);
});

Deno.test("現況：target.items 原樣附上並帶提示；findings_only 的提示不叫人去找名單", () => {
  const items = [{ kind: "政黨", name: "王一", source_url: "u" }, { kind: "縣市", name: "李二" }];
  const cur = shapeTaskCurrent("roster_check", { roster: { rows: [], history: [], region: "台北市" } } as unknown as TaskContextData,
    { task_id: "auto:roster_check:2026:台北市:縣市議員", target: { election_id: 2026, region: "台北市", election_type: "縣市議員", items, findings_only: true } });
  assertEquals(cur.items, items);
  assertEquals(cur.items_count, 2);
  assertEquals(cur.hint, ROSTER_ITEMS_HINT);
  const plain = shapeTaskCurrent("roster_check", { roster: { rows: [], history: [], region: "台北市" } } as unknown as TaskContextData,
    { task_id: "auto:roster_check:2026:台北市:縣市議員", target: { election_id: 2026, region: "台北市", election_type: "縣市議員" } });
  assert(!("items" in plain));
});

Deno.test("2026 登記名冊的缺人與要改狀態轉成同形狀的 items，掛在現況上", () => {
  const reg = { source_urls: ["https://web.cec.gov.tw/api/file/a.pdf"], missing: [{ name: "甲", party: "無", sub_region: "中山區", village: null, row_no: 3 }],
    needs_status: [{ name: "乙", politician_id: "p", politician_election_id: 9, candidacy_status: "considering" }] };
  const items = registrationItems(reg);
  assertEquals(items.map((i) => i.kind), ["缺人", "狀態"]);
  assertEquals(items[1].politician_election_id, 9);
  assertEquals(items[0].source_url, "https://web.cec.gov.tw/api/file/a.pdf");
  assertEquals(registrationItems(null), []);
  const cur = shapeTaskCurrent("roster_check", { roster: { rows: [], history: [], region: "台北市", registration: reg } } as unknown as TaskContextData,
    { task_id: "auto:roster_check:2026:台北市:縣市議員", target: { election_id: 2026, region: "台北市", election_type: "縣市議員" } });
  assertEquals((cur.items as unknown[]).length, 2);
});

// ── 落庫端 ──
const PID = "4f5ef190-21bb-4bf6-8c1c-234239982ed3";
const seed = () => ({
  politicians: [{ id: PID, name: "吳炳輝", party: null, region: "台南市", position: "縣市長候選人", merged_into: null }],
  politician_keys: [],
  regions: [{ id: 4175, region: "台南市", sub_region: null, village: null }, { id: 3197, region: "雲林縣", sub_region: null, village: null }],
  contribution_tasks: [] as Record<string, unknown>[],
  politician_elections: [{ id: 35070, politician_id: PID, election_id: 2026, election_type: "縣市長", candidacy_status: "filed", cand_no: null, region_id: 4175, source_note: null }],
});
const row = {
  id: "fab9e0c5-cb67-4ead-85e3-bd8c1803b02a", contribution_type: "candidacy", status: "verified", agent_name: "michelle.perry", contributor_ip_hash: "ip",
  contributor_url: null, note: null, retry_count: 0, source_urls: ["https://web.cec.gov.tw/api/file/5fb0eb40-da2f-4477-8529-853cbb60e76a.pdf"],
  task_id: "auto:candidacy_source_missing:cand_no:2026:縣市長:台南市",
  payload: { politician_id: PID, name: "吳炳輝", election_id: 2026, election_type: "縣市長", region: "雲林縣", candidate_status: "registered", cand_no: 1 },
};

Deno.test("落庫：單位清查已列出這個縣市差異 → 不另開 region_mismatch 任務，回覆說明；沒列出 → 照舊開", async () => {
  const listed = createFakeSupabase(seed(), { roster_unify_lists_region_mismatch: () => true });
  // deno-lint-ignore no-explicit-any
  const out = await applyContribution(listed.client, row as any);
  assertEquals(out.status, "applied", JSON.stringify(out));
  assertEquals(listed.db.contribution_tasks.filter((t) => t.task_type === REGION_MISMATCH_TASK_TYPE).length, 0);
  assertStringIncludes(out.message ?? "", "名單清查");
  assertEquals(listed.db.politician_elections[0].region_id, 4175, "地區照舊不動");
  const unlisted = createFakeSupabase(seed(), { roster_unify_lists_region_mismatch: () => false });
  // deno-lint-ignore no-explicit-any
  await applyContribution(unlisted.client, row as any);
  assertEquals(unlisted.db.contribution_tasks.filter((t) => t.task_type === REGION_MISMATCH_TASK_TYPE).length, 1);
});
