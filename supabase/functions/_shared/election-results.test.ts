/**
 * 整批補選舉結果（2026-10-06，小良哥：「改批次，票數 2 票，讓 jev 扣下來」；設計照 #377 第 4 節）的守門測試。
 *
 * SQL（派工臂、比對、系統票）在 PGlite 上灌 10-06 唯讀資料實跑過（見 PR 說明）；這支守住改壞了不會報錯的幾件事：
 *   1. 計分：目標 2（batch_result）、系統票只在每一位都對得上時投、對不上不投（不是 not_supported）、退件門檻 3、不要求兩台機器
 *      ——SQL 與 TS 兩份要一致
 *   2. 系統票只由名單核對投：一般 Jev 預判不撿這一型
 *   3. 派工：一個單位一件、一件最多 120 位、等票中的不再派、對不上的各自派而且不跟 raw 那支重複
 *   4. 交件與落庫：items 只收兩欄、只補空白不覆蓋、每一位一筆 edit_history（可還原）
 *   5. 四處清點與協議
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  AGREE_THRESHOLDS, CEC_CHECK_ONLY_TYPES, effectiveRequiredAgree, needsTwoIps, rejectFloor, requiredAgree, riskLevel, scoreStatus, SYSTEM_VOTE_ELIGIBLE_TYPES,
} from "./consensus.ts";
import {
  COMPARE_STATUS_LABEL, COMPARE_STATUSES, ELECTION_RESULTS_TASK, ELECTION_RESULTS_TYPE, MAX_RESULTS_PER_SUBMISSION, planElectionResults, RESULTS_BATCH_MODEL_PREFIX,
  resultItems, resultsSystemVote, shapeResultsRows,
} from "./election-results.ts";
import { CONTRIBUTION_TYPES, TASK_TYPES, validateContributionRequest } from "./contribution-schema.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { buildReportTemplate, PAYLOAD_SHAPE, TASK_GUIDANCE } from "./task-guidance.ts";
import { shapeTaskCurrent, shapeVerifyCurrent } from "./task-context.ts";
import { applyContribution } from "./apply-contribution.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { planRevert } from "./edit-history.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { summarizeContribution } from "./contribution-summary.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

/** 最後一支含 marker 的 migration（換行統一成 \n：Windows 工作樹是 CRLF） */
async function latestDefining(marker: string): Promise<{ name: string; sql: string }> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  names.sort();
  let hit = { name: "", sql: "" };
  for (const n of names) {
    const text = (await Deno.readTextFile(new URL(n, MIGRATIONS))).replace(/\r\n/g, "\n");
    if (text.includes(marker)) hit = { name: n, sql: text };
  }
  if (!hit.name) throw new Error(`找不到 ${marker}`);
  return hit;
}
/** 從 CREATE 那一行切到 $$; 為止（一支函式的本體） */
async function fnBody(name: string): Promise<string> {
  const { sql } = await latestDefining(`CREATE OR REPLACE FUNCTION ${name}(`);
  const at = sql.lastIndexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  const end = sql.indexOf("$$;", sql.indexOf("$$", at) + 2);
  return sql.slice(at, end);
}

const PAYLOAD = {
  election_id: 2022, election_type: "村里長", region: "台北市", sub_region: "中山區",
  items: [{ politician_election_id: 101, election_result: "elected" }, { politician_election_id: 102, election_result: "not_elected" }],
};
const SRC = ["https://db.cec.gov.tw/ElecTable/Election/ElecTickets?dataType=tickets&typeId=ELC&subjectId=V1&legisId=00&themeId=x"];

// ── 1. 計分 ────────────────────────────────────────────────────────
Deno.test("計分：election_results 目標 2（batch_result，不看來源）、退件門檻 3、不要求兩台機器", () => {
  assertEquals(riskLevel(ELECTION_RESULTS_TYPE, PAYLOAD), "batch_result");
  assertEquals(AGREE_THRESHOLDS.batch_result, { official: 2, media: 2, social: 2, other: 2 });
  for (const src of [SRC, ["https://www.cna.com.tw/news/a/1.aspx"], []]) assertEquals(requiredAgree(ELECTION_RESULTS_TYPE, PAYLOAD, src), 2);
  assertEquals(rejectFloor(ELECTION_RESULTS_TYPE), 3, "會改正式資料，退件門檻照一般 3");
  assert(!needsTwoIps(ELECTION_RESULTS_TYPE, PAYLOAD), "不要求兩台機器：系統票加一張代理同意就上線");
  // 其他型別不受影響
  assertEquals(requiredAgree("candidacy", { politician_id: "a4ad066b-c02b-4046-84c9-889da17df8d5", election_id: 2022, election_result: "elected" }, SRC), 3, "一位一筆的補結果照舊 3");
  assertEquals(requiredAgree("policy", {}, SRC), 3);
});

Deno.test("系統票算一票：全部對得上 → 目標 2−1＝1，再一張代理同意就上線；對不上不投票 → 兩張同意", () => {
  const withVote = effectiveRequiredAgree(requiredAgree(ELECTION_RESULTS_TYPE, PAYLOAD, SRC), "supported");
  assertEquals(withVote, 1);
  assertEquals(scoreStatus({ score: 1, target: withVote, distinctIps: 1, contributionType: ELECTION_RESULTS_TYPE, current: "pending" }), "verified");
  const noVote = effectiveRequiredAgree(requiredAgree(ELECTION_RESULTS_TYPE, PAYLOAD, SRC), null);
  assertEquals(noVote, 2);
  assertEquals(scoreStatus({ score: 1, target: noVote, distinctIps: 1, contributionType: ELECTION_RESULTS_TYPE, current: "pending" }), "pending");
  assertEquals(scoreStatus({ score: 2, target: noVote, distinctIps: 2, contributionType: ELECTION_RESULTS_TYPE, current: "pending" }), "verified");
  assertEquals(scoreStatus({ score: -3, target: withVote, distinctIps: 3, contributionType: ELECTION_RESULTS_TYPE, current: "pending" }), "rejected");
});

Deno.test("系統票規則（TS 鏡像）：每一位都 match 才 supported；任何一位不是就不投（不是 not_supported）；空的不投", () => {
  assertEquals(resultsSystemVote([{ politician_election_id: 1, status: "match" }, { politician_election_id: 2, status: "match" }]), "supported");
  for (const s of COMPARE_STATUSES.filter((x) => x !== "match")) {
    assertEquals(resultsSystemVote([{ politician_election_id: 1, status: "match" }, { politician_election_id: 2, status: s }]), null, `${s} 一位就不投`);
  }
  assertEquals(resultsSystemVote([]), null);
  for (const s of COMPARE_STATUSES) assert(COMPARE_STATUS_LABEL[s], `${s} 要有中文說明`);
});

Deno.test("SQL 與 TS 一致：門檻、系統票合格型別、名單核對專屬型別", async () => {
  const req = await fnBody("contribution_required_agree");
  assertStringIncludes(req, "WHEN p_type = 'election_results' THEN 'batch_result'");
  assertStringIncludes(req, "WHEN v_risk = 'batch_result' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END");
  assert(req.indexOf("'batch_result'") < req.indexOf("WHEN p_type = 'candidacy'"), "batch_result 要在 candidacy 的判斷之前（型別判斷不能被別的分支吃掉）");
  const elig = await fnBody("system_vote_eligible");
  for (const t of SYSTEM_VOTE_ELIGIBLE_TYPES) assertStringIncludes(elig, `'${t}'`);
  assert((SYSTEM_VOTE_ELIGIBLE_TYPES as readonly string[]).includes(ELECTION_RESULTS_TYPE));
  const only = await fnBody("system_vote_cec_only");
  const list = [...only.slice(only.indexOf("IN (")).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assertEquals(list, [...CEC_CHECK_ONLY_TYPES], "名單核對專屬的型別兩份要一樣");
  // 一般預判不撿：條件在 LIMIT 之前
  const pre = await fnBody("system_one_precheck_candidates");
  const at = pre.indexOf("AND NOT system_vote_cec_only(c.contribution_type)");
  assert(at > 0 && at < pre.lastIndexOf("LIMIT"), "一般 Jev 預判要排掉名單核對專屬的型別（而且在 LIMIT 之前），不然讀網頁的判定會蓋掉名單核對");
});

Deno.test("SQL 系統票：全部 match 才 supported、否則 cannot_tell（不投 not_supported）；model 前綴跟 TS 一樣；寫完重算共識；核過的不再核", async () => {
  const check = await fnBody("election_results_system_check");
  assertStringIncludes(check, "CASE WHEN v_total > 0 AND v_match = v_total THEN 'supported' ELSE 'cannot_tell' END");
  assert(!check.includes("'not_supported'"), "名單對不上不投反對：多半是我們的地區或姓名寫法，不是交件錯");
  assertStringIncludes(check, `'${RESULTS_BATCH_MODEL_PREFIX}-`);
  assertStringIncludes(check, "PERFORM contribution_apply_consensus(p_contribution_id)");
  assertStringIncludes(check, "status = 'pending'");
  const pending = await fnBody("election_results_check_pending");
  assertStringIncludes(pending, `j.model LIKE '${RESULTS_BATCH_MODEL_PREFIX}%'`);
  const cmp = await fnBody("election_results_compare");
  for (const s of COMPARE_STATUSES) assertStringIncludes(cmp, `'${s}'`, `比對狀態 ${s} SQL 要有`);
  assertStringIncludes(cmp, "election_result_cec_matches(", "比對要用同一支比對函式");
  const { sql } = await latestDefining("REVOKE EXECUTE ON FUNCTION election_results_system_check");
  assertStringIncludes(sql, "REVOKE EXECUTE ON FUNCTION election_results_system_check(UUID) FROM PUBLIC, anon, authenticated;");
  assertStringIncludes(sql, "REVOKE EXECUTE ON FUNCTION election_results_check_pending(INTEGER) FROM PUBLIC, anon, authenticated;");
});

Deno.test("比對規則只有一份：同屆、同選舉、同縣市、cec_name_key 同名；鄉鎮（代表去掉選舉區）與村里有就一起對；唯一一列才算", async () => {
  const m = await fnBody("election_result_cec_matches");
  assertStringIncludes(m, "cc.election_id = x.election_id AND cc.election_type = x.election_type");
  assertStringIncludes(m, "cc.region = x.county AND cc.name_norm = x.nn");
  assertStringIncludes(m, "cec_name_key(p.name) AS nn");
  assertStringIncludes(m, "replace(COALESCE(r.region, p.region), '臺', '台') AS county");
  assertStringIncludes(m, "(x.town IS NULL OR regexp_replace(COALESCE(cc.sub_region, ''), '(第[0-9]+)?選舉區$', '') = x.town)");
  assertStringIncludes(m, "(x.village IS NULL OR cc.village = x.village)");
  assertStringIncludes(m, "LEFT JOIN cec_candidates c ON m.n = 1 AND c.id = m.cec_id", "只有唯一一列才帶出中選會那一列");
});

// ── 2. 派工 ────────────────────────────────────────────────────────
Deno.test("派工臂：接進 arms、缺口條件、一個單位一件最多 120 位、等票中的不再派、對不上各自派而且不跟 raw 重複", async () => {
  const arms = await fnBody("contribution_auto_tasks_arms");
  assertStringIncludes(arms, "UNION ALL SELECT * FROM contribution_auto_tasks_election_results()");
  // 前一版 arms 的每一支臂都要還在（照抄時掉一支，那種任務就安靜地不再派）
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  const defining: string[] = [];
  for (const n of names.sort()) {
    const text = (await Deno.readTextFile(new URL(n, MIGRATIONS))).replace(/\r\n/g, "\n");
    if (text.includes("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms(")) defining.push(text);
  }
  const prev = defining[defining.length - 2];
  const prevBody = prev.slice(prev.lastIndexOf("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms("), prev.indexOf("$$;", prev.lastIndexOf("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms(")));
  const prevArms = [...prevBody.matchAll(/contribution_auto_tasks_[a-z_]+\(\)/g)].map((m) => m[0]).filter((a) => a !== "contribution_auto_tasks_arms()");
  assert(prevArms.length >= 20, `前一版 arms 只解析出 ${prevArms.length} 支`);
  for (const a of prevArms) assertStringIncludes(arms, a, `arms 掉了 ${a}`);
  const arm = await fnBody("contribution_auto_tasks_election_results");
  assertStringIncludes(arm, "pe.election_result IS NULL");
  assertStringIncludes(arm, "pe.candidate_status <> 'not_running'");
  assertStringIncludes(arm, "e.election_date < CURRENT_DATE", "還沒投票的屆別不派");
  assertStringIncludes(arm, "p.merged_into IS NULL");
  assertStringIncludes(arm, `(row_number() OVER w - 1) / ${MAX_RESULTS_PER_SUBMISSION} + 1 AS part,`, "派工臂的上限跟交件上限同一個數字");
  assertStringIncludes(arm, `- 1) / ${MAX_RESULTS_PER_SUBMISSION} + 1 AS parts`, "拆幾件也照同一個上限算");
  assertStringIncludes(arm, "c.contribution_type = 'election_results' AND c.status IN ('pending', 'verified')", "交了在等票的不再派");
  assertStringIncludes(arm, "WHERE m.cec_hits = 1", "只有唯一對上的進批次");
  assertStringIncludes(arm, `'auto:${ELECTION_RESULTS_TASK}:'`);
  assertStringIncludes(arm, "WHERE m.cec_hits <> 1", "對不上的各自派");
  assertStringIncludes(arm, "'auto:election_result_missing:' || m.politician_election_id", "各自派用 raw 同一個 task_id 形狀");
  assertStringIncludes(arm, "NOT EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = m.politician_id AND pl.removed_at IS NULL)", "名下有政見的 raw 已經在派，不重複");
  assertStringIncludes(arm, "IN ('村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN m.town END AS unit_town", "村里長與代表到鄉鎮");
  assert(!/'items'\s*,\s*jsonb_agg\(jsonb_build_object/.test(arm), "target 只放參選紀錄 id，名單細節派工當下才查（佇列每 10 分鐘整批重寫 target）");
});

Deno.test("排程與 system-one：results-batch-10min 叫 system-one?action=results_batch，它呼叫 SQL 那一支", async () => {
  const { sql } = await latestDefining("cron.schedule('results-batch-10min'");
  assertStringIncludes(sql, "system-one?action=results_batch");
  const src = await Deno.readTextFile(new URL("../system-one/index.ts", import.meta.url));
  assertStringIncludes(src, 'action === "results_batch"');
  assertStringIncludes(src, 'rpc("election_results_check_pending"');
});

// ── 3. 交件 ────────────────────────────────────────────────────────
Deno.test("交件：四欄照 target、items 每項只收兩欄、id 不重複、最多 120 位、結果二選一", () => {
  const body = (payload: unknown) => ({ agent_name: "tester", contributions: [{ contribution_type: ELECTION_RESULTS_TYPE, payload, source_urls: SRC }] });
  assert(validateContributionRequest(body(PAYLOAD)).ok);
  const errs = (payload: unknown) => validateContributionRequest(body(payload)).errors.map((e) => e.path);
  assert(errs({ ...PAYLOAD, items: [] }).includes("payload.items"));
  assert(errs({ ...PAYLOAD, items: Array.from({ length: MAX_RESULTS_PER_SUBMISSION + 1 }, (_, i) => ({ politician_election_id: i + 1, election_result: "elected" })) }).includes("payload.items"));
  assert(errs({ ...PAYLOAD, items: [PAYLOAD.items[0], PAYLOAD.items[0]] }).includes("payload.items[1].politician_election_id"), "重複");
  assert(errs({ ...PAYLOAD, items: [{ politician_election_id: 101, election_result: "withdrawn" }] }).includes("payload.items[0].election_result"));
  assert(errs({ ...PAYLOAD, items: [{ politician_election_id: "101", election_result: "elected" }] }).includes("payload.items[0].politician_election_id"));
  assert(errs({ ...PAYLOAD, items: [{ politician_election_id: 101, election_result: "elected", candidate_status: "qualified" }] }).includes("payload.items[0].candidate_status"), "順手改狀態不收");
  assert(errs({ ...PAYLOAD, election_id: 2018 }).includes("payload.election_id"));
  assert(errs({ ...PAYLOAD, region: undefined }).includes("payload.region"));
  assertEquals(resultItems({ items: [{ politician_election_id: 1, election_result: "elected" }, { politician_election_id: "x", election_result: "elected" }] }).length, 1);
});

// ── 4. 落庫 ────────────────────────────────────────────────────────
Deno.test("落庫規劃：只補空白；同結果略過；不同結果不覆蓋；別的屆別或選舉略過", () => {
  const plan = planElectionResults([
    { id: 1, election_id: 2022, election_type: "村里長", election_result: null },
    { id: 2, election_id: 2022, election_type: "村里長", election_result: "elected" },
    { id: 3, election_id: 2022, election_type: "村里長", election_result: "not_elected" },
    { id: 4, election_id: 2026, election_type: "村里長", election_result: null },
    { id: 5, election_id: 2022, election_type: "縣市議員", election_result: null },
  ], [
    { politician_election_id: 1, election_result: "elected" }, { politician_election_id: 2, election_result: "elected" },
    { politician_election_id: 3, election_result: "elected" }, { politician_election_id: 4, election_result: "elected" },
    { politician_election_id: 5, election_result: "elected" }, { politician_election_id: 6, election_result: "elected" },
  ], 2022, "村里長");
  assertEquals(plan.writes, [{ id: 1, election_result: "elected" }]);
  assertEquals(plan.unchanged, [2]);
  assertEquals(plan.conflicts, [{ id: 3, current: "not_elected", claimed: "elected" }]);
  assertEquals(plan.stray, [4, 5, 6]);
});

function seedCandidacies() {
  return {
    politician_elections: [
      { id: 101, election_id: 2022, election_type: "村里長", election_result: null, politician_id: "p1" },
      { id: 102, election_id: 2022, election_type: "村里長", election_result: null, politician_id: "p2" },
      { id: 103, election_id: 2022, election_type: "村里長", election_result: "not_elected", politician_id: "p3" },
    ],
    edit_history: [],
  };
}
const row = (payload: unknown, id = "c-1") => ({ id, contribution_type: ELECTION_RESULTS_TYPE as never, payload: payload as Record<string, unknown>, source_urls: SRC, note: null, agent_name: "tester", contributor_url: null });

Deno.test("落庫：結果空白的寫進去、每一位一筆 edit_history（可還原）、已有不同結果的不覆蓋並講出來", async () => {
  const fake = createFakeSupabase(seedCandidacies());
  const out = await applyContribution(fake.client, row({ ...PAYLOAD, items: [...PAYLOAD.items, { politician_election_id: 103, election_result: "elected" }] }));
  assertEquals(out.status, "applied", out.message);
  const pe = (id: number) => fake.db.politician_elections.find((r) => r.id === id)!;
  assertEquals([pe(101).election_result, pe(102).election_result, pe(103).election_result], ["elected", "not_elected", "not_elected"]);
  const edits = fake.db.edit_history.filter((e) => e.table_name === "politician_elections");
  assertEquals(edits.map((e) => [e.record_id, e.field, e.old_value, e.new_value]).sort(), [["101", "election_result", null, "elected"], ["102", "election_result", null, "not_elected"]]);
  assertStringIncludes(out.message, "已補 2 位（當選 1、落選 1）");
  assertStringIncludes(out.message, "103", "沒覆蓋的那一位要講出來");
  // 還原：倒回空白
  fake.db.edit_history.forEach((e, i) => { e.id = i + 1; });
  const steps = planRevert(fake.db.edit_history as never);
  assertEquals(steps.map((s) => s.op === "restore" ? [s.record_id, s.field, s.value] : null).filter(Boolean).sort(), [["101", "election_result", null], ["102", "election_result", null]]);
  // 同一份再交一次：都補過了 → superseded
  const again = await applyContribution(fake.client, row(PAYLOAD, "c-2"));
  assertEquals(again.status, "superseded");
});

// ── 5. 任務與驗證項 ─────────────────────────────────────────────────
Deno.test("任務：current.items 逐位帶中選會線索；骨架照 target 填好單位、items 只列 id 不預填結果", () => {
  const target = { election_id: 2022, election_type: "村里長", region: "台北市", sub_region: "中山區", politician_election_ids: [101, 102] };
  const cur = shapeTaskCurrent(ELECTION_RESULTS_TASK, {
    results_items: [
      { politician_election_id: 101, name: "甲", county: "台北市", town: "中山區", village: "一里", cec_hits: 1, cec_elected: true, cec_village: "一里", cec_birth_year: 1960 },
      { politician_election_id: 102, name: "乙", county: "台北市", town: "中山區", village: "二里", cec_hits: 1, cec_elected: false },
    ],
  }, { task_id: "auto:election_results_missing:2022:村里長:台北市:中山區", target });
  const items = cur.items as Array<Record<string, unknown>>;
  assertEquals(items.map((i) => [i.politician_election_id, i.place, (i.cec as Record<string, unknown>).elected]), [[101, "台北市 中山區 一里", true], [102, "台北市 中山區 二里", false]]);
  assertEquals(cur.hint, TASK_GUIDANCE[ELECTION_RESULTS_TASK]);
  const tpl = buildReportTemplate(ELECTION_RESULTS_TASK, ELECTION_RESULTS_TYPE, target, "auto:x")!;
  const p = tpl.payload as Record<string, unknown>;
  assertEquals([p.election_id, p.election_type, p.region, p.sub_region], [2022, "村里長", "台北市", "中山區"]);
  assertEquals((p.items as Array<Record<string, unknown>>).map((i) => i.politician_election_id), [101, 102]);
  assert((p.items as Array<Record<string, unknown>>).every((i) => !["elected", "not_elected"].includes(String(i.election_result))), "結果不預填：照抄系統的線索等於沒核對");
});

Deno.test("驗證項：逐位列出比對結果、對不上的排前面；hint 依有沒有對不上而不同、講投 agree／disagree", () => {
  const rows = [
    { politician_election_id: 1, name: "甲", county: "台北市", status: "match", cec_hits: 1, cec_elected: true, claimed: "elected" },
    { politician_election_id: 2, name: "乙", county: "台北市", status: "ambiguous", cec_hits: 2, claimed: "elected" },
  ];
  const cur = shapeVerifyCurrent(ELECTION_RESULTS_TYPE, PAYLOAD, { results_compare: rows });
  const items = cur.items as Array<Record<string, unknown>>;
  assertEquals(items.map((i) => i.politician_election_id), [2, 1], "對不上的排前面");
  assertEquals(cur.mismatched_count, 1);
  assertStringIncludes(String(cur.hint), "有 1 位對不上");
  assertStringIncludes(String(cur.hint), "disagree");
  const all = shapeVerifyCurrent(ELECTION_RESULTS_TYPE, PAYLOAD, { results_compare: [rows[0]] });
  assertStringIncludes(String(all.hint), "每一位都對得上");
  assertEquals(shapeResultsRows(rows)[0].status_label, COMPARE_STATUS_LABEL.ambiguous);
});

// ── 6. 四處清點與協議 ────────────────────────────────────────────────
Deno.test("四處清點：DB CHECK、TS 清單、skill.md、標籤；協議 1.58.0 寫進計分與做法", async () => {
  assert((CONTRIBUTION_TYPES as readonly string[]).includes(ELECTION_RESULTS_TYPE));
  assert((TASK_TYPES as readonly string[]).includes(ELECTION_RESULTS_TASK));
  assertEquals(SUGGESTED_TYPE[ELECTION_RESULTS_TASK], ELECTION_RESULTS_TYPE);
  assert(PAYLOAD_SHAPE[ELECTION_RESULTS_TYPE]);
  const { sql } = await latestDefining("ADD CONSTRAINT contributions_contribution_type_check");
  const check = sql.slice(sql.lastIndexOf("ADD CONSTRAINT contributions_contribution_type_check"));
  assertStringIncludes(check.slice(0, check.indexOf(";")), `'${ELECTION_RESULTS_TYPE}'`);
  const labels = await Deno.readTextFile(new URL("../../../lib/task-labels.ts", import.meta.url));
  assert(new RegExp(`\\b${ELECTION_RESULTS_TASK}:\\s*'`).test(labels));
  for (const f of ["../../../pages/Queue.vue", "../../../pages/Contributions.vue", "../../../lib/model-quality.ts"]) {
    assertStringIncludes(await Deno.readTextFile(new URL(f, import.meta.url)), `${ELECTION_RESULTS_TYPE}:`, `${f} 要有中文名稱`);
  }
  const [major, minor] = PROTOCOL_VERSION.split(".").map(Number);
  assert(major > 1 || (major === 1 && minor >= 58), `協議版號 ${PROTOCOL_VERSION} 比 1.58.0 舊`);
  const md = (await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url))).replace(/\r/g, "");
  // 合併衝突記號混進對外協議（這支 PR 第一版 rebase 時真的發生過，測試全綠沒有人發現）
  assert(!/^(<<<<<<<|>>>>>>>) /m.test(md), "skill.md 有合併衝突記號");
  for (const s of ["`election_results_missing` → `election_results`", "**`election_results`**", "整批補已投票選舉的結果（`election_results`，1.58.0）2", "| `election_results` **整批**補已投票選舉的結果"]) {
    assertStringIncludes(md, s);
  }
});

Deno.test("貢獻看板摘要：講出單位與人數", () => {
  const s = summarizeContribution({ id: "c", contribution_type: ELECTION_RESULTS_TYPE, payload: PAYLOAD, status: "pending", created_at: "2026-10-06", agent_name: "t" } as never);
  assertStringIncludes(s.summary, "台北市中山區 2022 村里長");
  assertStringIncludes(s.summary, "2 位（當選 1、落選 1）");
});
