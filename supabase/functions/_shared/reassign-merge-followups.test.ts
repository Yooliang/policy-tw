/**
 * 參選紀錄改掛（reassign_candidacy）與人物合併（merge_politician）的後續（維護者 10-06；migration 20261007020000、協議 1.66.0）的守門測試：
 *   1. 改掛時，掛在那一屆參選的政見跟著搬到新的那位、記履歷、可還原；別屆的、別人的不動
 *   2. 改掛後變成空殼的原人物走既有的移除流程（派工臂派 placeholder_politician、target.kind＝orphan），不直接刪；
 *      派工臂的「什麼都沒有」判斷要涵蓋移除流程會擋的每一種東西（不然派出去的任務 apply 會被退件）
 *   3. merge_politician 一起搬 lineage_participants 與 handovers（每個寫入記履歷、撞鍵的整列記下再刪），其餘一字不改
 *
 * SQL 在 PGlite 上灌假資料實跑過（見 PR 說明）；這支守住「改壞了不會報錯」的事。每一條都做過還原驗證（見 PR 說明）。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { applyContribution } from "./apply-contribution.ts";
import { planRevert } from "./edit-history.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { REASSIGN_TYPE } from "./reassign-candidacy.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { TASK_TYPE_LABEL } from "../../../lib/task-labels.ts";
import { TASK_GUIDANCE } from "./task-guidance.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const THIS = "20261007020000_reassign_merge_followups.sql";
const lf = (s: string) => s.replace(/\r\n/g, "\n");
const mine = lf(await Deno.readTextFile(new URL(THIS, MIGRATIONS)));
const skill = lf(await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url)));

function definitionIn(text: string, fn: string): string | null {
  const start = text.lastIndexOf(`CREATE OR REPLACE FUNCTION ${fn}(`);
  if (start < 0) return null;
  const tag = /AS\s+(\$[A-Za-z_]*\$)/.exec(text.slice(start));
  assert(tag);
  const bodyStart = start + tag.index + tag[0].length;
  const end = text.indexOf(tag[1], bodyStart);
  return text.slice(start, text.indexOf(";", end) + 1);
}
async function previousDefinition(fn: string): Promise<string> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql") && e.name < THIS) names.push(e.name);
  names.sort().reverse();
  for (const n of names) {
    const d = definitionIn(lf(await Deno.readTextFile(new URL(n, MIGRATIONS))), fn);
    if (d) return d;
  }
  throw new Error(fn);
}

// ── 1. 改掛時政見跟著搬 ─────────────────────────────────────────────
const FROM = "00000000-0000-4000-8000-000000000001";
const TO = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000003";
const P = {
  politician_election_id: 36379, from_politician_id: FROM, to_politician_id: TO,
  evidence: { birth_year: 1987 }, reason: "中選會名冊上這一位的出生年是 1987，不是桃園市里長那位 1959 年生的",
};
function seed() {
  return {
    politician_elections: [
      { id: 36379, politician_id: FROM, election_id: 2026, election_type: "縣市議員", position: "縣市議員候選人", regions: { region: "桃園市" },
        politicians: { id: FROM, name: "簡嘉佑", birth_year: 1959, party: "無黨籍", region: "桃園市", merged_into: null } },
      { id: 18457, politician_id: FROM, election_id: 2022, election_type: "村里長" },
      { id: 777, politician_id: TO, election_id: 2022, election_type: "縣市議員" },
    ],
    politicians: [
      { id: FROM, name: "簡嘉佑", birth_year: 1959, party: "無黨籍", region: "桃園市", merged_into: null },
      { id: TO, name: "簡嘉佑", birth_year: 1987, party: "時代力量", region: "台中市", merged_into: null },
    ],
    politician_keys: [], politician_pair_resolutions: [], edit_history: [],
    policies: [
      { id: "pol-a", politician_id: FROM, election_id: 2026, title: "2026 的政見 A", removed_at: null },
      { id: "pol-b", politician_id: FROM, election_id: 2026, title: "2026 的政見 B（已移除）", removed_at: "2026-10-01T00:00:00Z" },
      { id: "pol-old", politician_id: FROM, election_id: 2022, title: "里長 2022 的政見，是原本那位的", removed_at: null },
      { id: "pol-to", politician_id: TO, election_id: 2022, title: "新那位自己的 2022 政見", removed_at: null },
      { id: "pol-x", politician_id: OTHER, election_id: 2026, title: "別人的", removed_at: null },
    ],
  };
}
const row = (payload: unknown) => ({
  id: "c-1", contribution_type: REASSIGN_TYPE as never, payload: payload as Record<string, unknown>,
  source_urls: ["https://web.cec.gov.tw/api/file/x.pdf"], note: null, agent_name: "tester",
} as never);

Deno.test("改掛：掛在那一屆的政見（含已移除的）跟著搬、每筆記履歷；別屆的、新那位自己的、別人的不動", async () => {
  const fake = createFakeSupabase(seed());
  const out = await applyContribution(fake.client, row(P));
  assertEquals(out.status, "applied", out.message);
  const owner = (id: string) => (fake.db.policies as Array<Record<string, unknown>>).find((r) => r.id === id)!.politician_id;
  assertEquals(owner("pol-a"), TO);
  assertEquals(owner("pol-b"), TO, "已移除的也跟著搬，之後還原時才在對的人身上");
  assertEquals(owner("pol-old"), FROM, "原本那位別屆的政見不動");
  assertEquals(owner("pol-to"), TO);
  assertEquals(owner("pol-x"), OTHER);
  assertStringIncludes(out.message, "1 筆政見跟著改掛", "回覆講的是上線可見的筆數（已移除的不算）");
  const edits = fake.db.edit_history as Array<Record<string, unknown>>;
  for (const id of ["pol-a", "pol-b"]) {
    assert(edits.some((e) => e.table_name === "policies" && e.record_id === id && e.field === "politician_id" && e.old_value === FROM && e.new_value === TO), `${id} 要有履歷`);
  }
  assert(!edits.some((e) => e.table_name === "policies" && (e.record_id === "pol-old" || e.record_id === "pol-x")));
  edits.forEach((e, i) => { e.id = i + 1; });
  const steps = planRevert(edits as never);
  for (const id of ["pol-a", "pol-b"]) {
    assert(steps.some((s) => s.op === "restore" && s.table === "policies" && s.record_id === id && s.field === "politician_id" && s.value === FROM), `還原把 ${id} 改回原本那位`);
  }
});

Deno.test("改掛：新建一位時政見也跟著搬到新建的那位", async () => {
  const fake = createFakeSupabase(seed());
  const out = await applyContribution(fake.client, row({
    politician_election_id: 36379, from_politician_id: FROM,
    new_politician: { name: "簡嘉佑", birth_year: 1987, party: "民主進步黨" }, evidence: { birth_year: 1987 }, reason: P.reason,
  }));
  assertEquals(out.status, "applied", out.message);
  const created = (out as { politician_id?: string }).politician_id;
  assert(created && created !== FROM && created !== TO);
  assertEquals((fake.db.policies as Array<Record<string, unknown>>).find((r) => r.id === "pol-a")!.politician_id, created);
});

Deno.test("改掛：沒有政見的參選紀錄照舊改掛，回覆不多講", async () => {
  const s = seed();
  s.policies = [];
  const out = await applyContribution(createFakeSupabase(s).client, row(P));
  assertEquals(out.status, "applied", out.message);
  assert(!out.message.includes("跟著改掛"));
});

// ── 2. 空殼人物走既有的移除流程 ─────────────────────────────────────
const armSql = definitionIn(mine, "contribution_auto_tasks_placeholder_politicians");
assert(armSql, "新 migration 要有這支派工臂");
const orphanArm = armSql.slice(armSql.indexOf("UNION ALL"));

Deno.test("空殼：只派「有一筆參選紀錄被改掛走、沒被還原」的人，沿用 placeholder_politician（走 removal），不直接刪", () => {
  assertStringIncludes(orphanArm, "'placeholder_politician'");
  assertStringIncludes(orphanArm, "'kind', 'orphan'");
  assertStringIncludes(orphanArm, "rc.contribution_type = 'reassign_candidacy'");
  assertStringIncludes(orphanArm, "h.table_name = 'politician_elections' AND h.field = 'politician_id'");
  assertStringIncludes(orphanArm, "h.old_value = to_jsonb(p.id::TEXT) AND h.reverted_at IS NULL", "被還原的改掛不算");
  assertStringIncludes(orphanArm, "p.merged_into IS NULL AND NOT politician_name_is_placeholder(p.name)", "姓名像測試資料的由原本那一種派，task_id 同格式不重複");
  assertStringIncludes(orphanArm, "c.contribution_type = 'removal' AND c.status IN ('pending', 'verified')", "已經有人交了移除在等票的不派");
  assertStringIncludes(orphanArm, "target_table 填 politicians");
  assert(!/DELETE\s+FROM\s+politicians/i.test(mine), "不直接刪人物");
});

Deno.test("空殼：「什麼都沒有」涵蓋移除流程會擋的每一種東西（不然派出去的任務 apply 時被退件）", async () => {
  const src = await Deno.readTextFile(new URL("./apply-contribution.ts", import.meta.url));
  const fnAt = src.indexOf("export async function politicianRemovalBlockers");
  const checks = [...src.slice(fnAt, src.indexOf("return out;", fnAt)).matchAll(/\["([a-z_]+)", "([a-z_]+)", "[^"]+"\]/g)].map((m) => [m[1], m[2]]);
  assert(checks.length >= 8, `只讀到 ${checks.length} 項，解析可能壞了`);
  for (const [table, col] of checks) {
    const covered = orphanArm.includes(`FROM ${table} x WHERE x.${col} = p.id`)
      || (table === "handovers" && orphanArm.includes("FROM handovers x WHERE x.from_politician_id = p.id OR x.to_politician_id = p.id"))
      || (table === "politicians" && orphanArm.includes("FROM politicians x WHERE x.merged_into = p.id"));
    assert(covered, `空殼派工臂沒檢查 ${table}.${col}，但移除流程會因此擋下`);
  }
  assertStringIncludes(orphanArm, "FROM politician_elections x WHERE x.politician_id = p.id", "參選紀錄也要是空的");
});

Deno.test("空殼：原本測試資料那一種一字不改；不動 contribution_auto_tasks_arms", async () => {
  const prev = await previousDefinition("contribution_auto_tasks_placeholder_politicians");
  const firstArm = armSql.slice(0, armSql.indexOf("  UNION ALL")).trimEnd() + "\n$$;";
  assertEquals(firstArm, prev.slice(0, prev.lastIndexOf("$$;") + 3));
  assert(definitionIn(mine, "contribution_auto_tasks_arms") === null, "arms 另有人在改，這支不重寫");
});

Deno.test("空殼：任務敘述（指引、標籤、skill.md）三處都講到空殼", () => {
  assertStringIncludes(TASK_GUIDANCE.placeholder_politician, "orphan");
  assertStringIncludes(TASK_TYPE_LABEL.placeholder_politician, "空殼");
  assertStringIncludes(skill, "`target.kind`＝`orphan`，1.66.0");
  assertStringIncludes(skill, "`target.kind` 是 `orphan`");
});

// ── 3. merge_politician 一起搬脈絡的角色與交接 ───────────────────────
const mergeSql = definitionIn(mine, "merge_politician");
assert(mergeSql);

Deno.test("合併：lineage_participants、handovers 搬過去，每個寫入記履歷；撞鍵、變成同一人同一屆的整列記下再刪", () => {
  const lp = mergeSql.slice(mergeSql.indexOf("-- 政策脈絡的角色"), mergeSql.indexOf("-- 交接（#349）"));
  assertStringIncludes(lp, "k3.politician_id = p_keep AND k3.lineage_id = r.lineage_id AND k3.basis = r.basis", "撞 (脈絡, 人物, 依據) 唯一鍵");
  assertStringIncludes(lp, "VALUES ('lineage_participants', r.id::TEXT, '*', to_jsonb(r), NULL, p_contribution, p_agent)");
  assertStringIncludes(lp, "VALUES ('lineage_participants', r.id::TEXT, 'politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent)");
  const ho = mergeSql.slice(mergeSql.indexOf("-- 交接（#349）"), mergeSql.indexOf("-- 提問、票的指認"));
  assertStringIncludes(ho, "v_new_from = v_new_to AND r.from_election_id IS NOT DISTINCT FROM r.to_election_id", "撞 handovers_distinct_terms");
  assertStringIncludes(ho, "h2.from_election_id IS NOT DISTINCT FROM r.from_election_id", "撞 handovers_one_per_pair（NULLS NOT DISTINCT）");
  assertStringIncludes(ho, "h2.to_election_id IS NOT DISTINCT FROM r.to_election_id");
  assertStringIncludes(ho, "VALUES ('handovers', r.id::TEXT, '*', to_jsonb(r), NULL, p_contribution, p_agent)");
  assertStringIncludes(ho, "'from_politician_id', to_jsonb(p_remove::TEXT)");
  assertStringIncludes(ho, "'to_politician_id', to_jsonb(p_remove::TEXT)");
  assertStringIncludes(mergeSql, "'moved_participants', v_participants, 'moved_handovers', v_handovers");
});

Deno.test("合併：除了加的那兩段與回傳的兩個數字，跟上一版一字不差（政見、參選紀錄、身份鍵、提問、補空欄、配對結論都沒動）", async () => {
  const prev = await previousDefinition("merge_politician");
  const back = mergeSql
    .replace("  v_participants INTEGER := 0; v_handovers INTEGER := 0; v_new_from UUID; v_new_to UUID;\n", "")
    .replace(/  -- 政策脈絡的角色（#349）[\s\S]*?(?=  -- 提問、票的指認)/, "")
    .replace(",\n                            'moved_participants', v_participants, 'moved_handovers', v_handovers", "");
  assertEquals(back, prev);
});

Deno.test("合併：兩張表的搬動能由 edit_history 還原（整列記下的重新放回、改欄位的改回去）", () => {
  // 模擬合併寫下的履歷：脈絡角色改掛、交接前後任改掛、撞鍵的整列刪掉
  const REMOVE = "r", KEEP = "k";
  const edits = [
    { id: 1, table_name: "lineage_participants", record_id: "lp1", field: "politician_id", old_value: REMOVE, new_value: KEEP },
    { id: 2, table_name: "lineage_participants", record_id: "lp2", field: "*", old_value: { id: "lp2", politician_id: REMOVE }, new_value: null },
    { id: 3, table_name: "handovers", record_id: "h1", field: "from_politician_id", old_value: REMOVE, new_value: KEEP },
    { id: 4, table_name: "handovers", record_id: "h1", field: "to_politician_id", old_value: REMOVE, new_value: KEEP },
    { id: 5, table_name: "handovers", record_id: "h2", field: "*", old_value: { id: "h2", from_politician_id: REMOVE }, new_value: null },
  ].map((e) => ({ ...e, contribution_id: "c", agent_name: "a" }));
  const steps = planRevert(edits as never);
  assertEquals(steps.filter((s) => s.op === "reinsert").map((s) => `${s.table}#${s.record_id}`).sort(), ["handovers#h2", "lineage_participants#lp2"]);
  assertEquals(steps.filter((s) => s.op === "restore").map((s) => `${(s as { table: string }).table}#${s.record_id}#${(s as { field: string }).field}`).sort(),
    ["handovers#h1#from_politician_id", "handovers#h1#to_politician_id", "lineage_participants#lp1#politician_id"]);
});

Deno.test("協議 1.66.0：版號與 skill.md 一致、改掛政見跟著搬與合併的搬法寫進 skill.md", () => {
  const [maj, min] = PROTOCOL_VERSION.split(".").map(Number);
  assert(maj > 1 || (maj === 1 && min >= 66), `協議版號 ${PROTOCOL_VERSION} 比 1.66.0 舊`); // 版號跟 skill.md 一致由 protocol.test.ts 盯
  assertStringIncludes(skill, "掛在那一屆的政見跟著改掛到新的那位（1.66.0");
  assert(!skill.includes("**不會**跟著搬"), "舊說法（政見不會跟著搬）要拿掉");
  assertStringIncludes(skill, "政策脈絡的角色與交接（1.66.0）一起搬到保留的那位");
});
