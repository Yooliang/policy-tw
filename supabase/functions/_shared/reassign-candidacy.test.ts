/**
 * 同名人物接錯、參選紀錄改掛（reassign_candidacy／candidacy_owner_mismatch，2026-10-06）的守門測試。
 *
 * SQL（派工臂、系統票）在 PGlite 上灌 10-06 唯讀資料實跑過（見 PR 說明）；這支守住改壞了不會報錯的幾件事：
 *   1. 伺服器檢查：同名、不是同一人、出處出生年對得上、同一屆不會兩筆——交件與落庫同一份
 *   2. 門檻：比照合併要兩台機器（SQL 與 TS 兩份）、分數門檻一般值；系統票照現有 ±1 規則、只由名冊核對投
 *   3. 派工：五種訊號、等票中與確認過的不派、接進 arms
 *   4. 落庫：改掛、記履歷、兩人記不同人、可還原；等票期間被改過的不蓋
 *   5. 四處清點與協議
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { CEC_CHECK_ONLY_TYPES, needsTwoIps, rejectFloor, requiredAgree, riskLevel, SCORE_TWO_IP_TYPES, scoreStatus, SYSTEM_VOTE_ELIGIBLE_TYPES } from "./consensus.ts";
import {
  OWNER_MISMATCH_TASK, REASSIGN_MODEL_PREFIX, REASSIGN_TYPE, type ReassignContext, reassignProblems, reassignSystemVote, sameNameOrAlias,
} from "./reassign-candidacy.ts";
import { CONTRIBUTION_TYPES, TASK_TYPES, validateContributionRequest } from "./contribution-schema.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { buildBranchTemplates, PAYLOAD_SHAPE, TASK_GUIDANCE } from "./task-guidance.ts";
import { shapeVerifyCurrent } from "./task-context.ts";
import { applyContribution } from "./apply-contribution.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { planRevert } from "./edit-history.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { MIN_DISTINCT_VOTERS } from "./vote-budget.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
async function latestDefining(marker: string): Promise<string> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  let hit = "";
  for (const n of names.sort()) {
    const text = (await Deno.readTextFile(new URL(n, MIGRATIONS))).replace(/\r\n/g, "\n");
    if (text.includes(marker)) hit = text;
  }
  if (!hit) throw new Error(`找不到 ${marker}`);
  return hit;
}
async function fnBody(name: string): Promise<string> {
  const sql = await latestDefining(`CREATE OR REPLACE FUNCTION ${name}(`);
  const at = sql.lastIndexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  return sql.slice(at, sql.indexOf("$$;", sql.indexOf("$$", at) + 2));
}

const FROM = "00000000-0000-4000-8000-000000000001";
const TO = "00000000-0000-4000-8000-000000000002";
const base = (over: Partial<ReassignContext> = {}): ReassignContext => ({
  pe: { id: 36379, politician_id: FROM, election_id: 2026, election_type: "縣市議員", county: "桃園市" },
  from: { id: FROM, name: "簡嘉佑", birth_year: 1959, region: "桃園市", aliases: [] },
  to: { id: TO, name: "簡嘉佑", birth_year: 1987, region: "台中市", aliases: [] },
  to_election_ids: [2022],
  pair_resolution: null,
  ...over,
});
const P = { politician_election_id: 36379, from_politician_id: FROM, to_politician_id: TO, evidence: { birth_year: 1987, party: "民主進步黨", district: "台中市第09選舉區" }, reason: "中選會登記彙總表台中市第09選舉區的簡嘉佑是民進黨，1987 年生，不是桃園豐林里長" };

// ── 1. 伺服器檢查 ──────────────────────────────────────────────────
Deno.test("伺服器檢查：簡嘉佑那種（同名、出生年不同、出處對得上新的、同一屆沒有兩筆）沒有問題", () => {
  assertEquals(reassignProblems(base(), P), []);
});

Deno.test("伺服器檢查：不同名不收、別名算同名；出生年一樣＝同一人（走合併）；記成同一人的擋；改掛到自己擋", () => {
  const msg = (ctx: ReassignContext, p: unknown = P) => reassignProblems(ctx, p).map((x) => x.message).join("|");
  assertStringIncludes(msg(base({ to: { ...base().to!, name: "簡家佑" } })), "只收同名");
  assertEquals(reassignProblems(base({ to: { ...base().to!, name: "簡家佑", aliases: ["簡嘉佑"] } }), P), [], "登記過別名的算同名");
  assert(sameNameOrAlias({ id: "a", name: "臺 灣", birth_year: null }, { id: "b", name: "台灣", birth_year: null }), "臺／台、空白正規化");
  assertStringIncludes(msg(base({ to: { ...base().to!, birth_year: 1959 } }), { ...P, evidence: { party: "x" } }), "merge_politician");
  assertStringIncludes(msg(base({ pair_resolution: "same" })), "同一個人");
  assertStringIncludes(msg(base({ to: { ...base().to!, id: FROM } })), "就是現在掛的這位");
  assertStringIncludes(msg(base({ to: { ...base().to!, merged_into: "00000000-0000-4000-8000-000000000003" } })), "已經併入");
  assertStringIncludes(msg(base(), { ...P, from_politician_id: "00000000-0000-4000-8000-000000000009" }), "現在掛的是", "現在掛的不是交件寫的那位");
});

Deno.test("伺服器檢查：出處的出生年要對得上新的、不能是舊的；改掛後同一屆不會兩筆；找不到的報 target_not_found", () => {
  const codes = (ctx: ReassignContext, p: unknown = P) => reassignProblems(ctx, p);
  assertStringIncludes(codes(base({ to: { ...base().to!, birth_year: 1988 } }))[0].message, "對不上");
  assertStringIncludes(codes(base(), { ...P, evidence: { birth_year: 1959 } }).map((x) => x.message).join("|"), "這筆就是他的");
  assertStringIncludes(codes(base({ to_election_ids: [2022, 2026] }))[0].message, "同一屆會有兩筆");
  assertEquals(codes(base({ pe: null }))[0].code, "target_not_found");
  assertEquals(codes(base({ to: null }))[0].code, "target_not_found");
  // 新建的人（id 空）只看名字與出生年
  assertEquals(reassignProblems(base({ to: { id: null, name: "簡嘉佑", birth_year: 1987 }, to_election_ids: [] }), { ...P, to_politician_id: undefined, new_politician: { name: "簡嘉佑", birth_year: 1987, party: "民主進步黨" } }), []);
});

// ── 2. 門檻與系統票 ─────────────────────────────────────────────────
Deno.test("門檻：比照合併要兩台機器、分數門檻一般值 3、退件門檻 3", () => {
  assertEquals(riskLevel(REASSIGN_TYPE, P), "normal");
  assertEquals(requiredAgree(REASSIGN_TYPE, P, ["https://web.cec.gov.tw/x"]), 3);
  assertEquals(rejectFloor(REASSIGN_TYPE), 3);
  assert(needsTwoIps(REASSIGN_TYPE, P));
  assert((SCORE_TWO_IP_TYPES as readonly string[]).includes("merge_politician") && (SCORE_TWO_IP_TYPES as readonly string[]).includes(REASSIGN_TYPE));
  assertEquals(scoreStatus({ score: 4, target: 3, distinctIps: 1, contributionType: REASSIGN_TYPE, current: "pending" }), "pending", "分數到了只有一台機器 → 還在等");
  assertEquals(scoreStatus({ score: 3, target: 3, distinctIps: 2, contributionType: REASSIGN_TYPE, current: "pending" }), "verified");
  assertEquals(MIN_DISTINCT_VOTERS[REASSIGN_TYPE], 2, "票數預算的人數地板也比照合併");
});

Deno.test("SQL 與 TS 一致：兩台機器的型別清單、系統票合格型別、名單核對專屬型別", async () => {
  const two = await fnBody("contribution_needs_two_ips");
  const list = [...two.slice(two.indexOf("p_type IN (")).split(")")[0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assertEquals(list, [...SCORE_TWO_IP_TYPES], "contribution_needs_two_ips 的型別清單要跟 SCORE_TWO_IP_TYPES 一樣");
  assertStringIncludes(two, "p_type = 'lineage_handover' AND COALESCE(p_payload->>'handover_type', '') = 'stop'", "中止交接那一條照舊");
  const elig = await fnBody("system_vote_eligible");
  for (const t of SYSTEM_VOTE_ELIGIBLE_TYPES) assertStringIncludes(elig, `'${t}'`);
  const only = await fnBody("system_vote_cec_only");
  assertEquals([...only.slice(only.indexOf("IN (")).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), [...CEC_CHECK_ONLY_TYPES]);
  assert((CEC_CHECK_ONLY_TYPES as readonly string[]).includes(REASSIGN_TYPE));
});

Deno.test("系統票（TS 鏡像與 SQL）：名冊出生年對得上新的、對不上舊的 supported；反過來 not_supported；其餘棄權", async () => {
  assertEquals(reassignSystemVote(1, 1987, 1959, 1987), "supported");
  assertEquals(reassignSystemVote(1, 1959, 1959, 1987), "not_supported");
  assertEquals(reassignSystemVote(1, 1987, 1987, 1987), null, "兩個都對得上分不出來");
  assertEquals(reassignSystemVote(1, 1990, 1959, 1987), null);
  assertEquals(reassignSystemVote(0, null, 1959, 1987), null, "2026 不在名冊");
  assertEquals(reassignSystemVote(2, 1987, 1959, 1987), null, "名冊同名多位");
  assertEquals(reassignSystemVote(1, null, 1959, 1987), null, "名冊沒出生年");
  const check = await fnBody("reassign_candidacy_system_check");
  assertStringIncludes(check, "WHEN v_hits = 1 AND v_cec_by IS NOT NULL AND v_to_by = v_cec_by AND v_from_by IS DISTINCT FROM v_cec_by THEN 'supported'");
  assertStringIncludes(check, "WHEN v_hits = 1 AND v_cec_by IS NOT NULL AND v_from_by = v_cec_by AND v_to_by IS DISTINCT FROM v_cec_by THEN 'not_supported'");
  assertStringIncludes(check, "ELSE 'cannot_tell' END");
  assertStringIncludes(check, "election_result_cec_matches(ARRAY[v_pe])", "跟補選舉結果同一支比對");
  assertStringIncludes(check, `'${REASSIGN_MODEL_PREFIX}-`);
  assertStringIncludes(check, "PERFORM contribution_apply_consensus(p_contribution_id)");
  const pending = await fnBody("reassign_candidacy_check_pending");
  assertStringIncludes(pending, `j.model LIKE '${REASSIGN_MODEL_PREFIX}%'`, "核過的不再核");
  const sql = await latestDefining("REVOKE EXECUTE ON FUNCTION reassign_candidacy_system_check");
  assertStringIncludes(sql, "REVOKE EXECUTE ON FUNCTION reassign_candidacy_system_check(UUID) FROM PUBLIC, anon, authenticated;");
  const cron = await latestDefining("cron.schedule('reassign-check-10min'");
  assertStringIncludes(cron, "system-one?action=reassign_check");
  const src = await Deno.readTextFile(new URL("../system-one/index.ts", import.meta.url));
  assertStringIncludes(src, 'action === "reassign_check"');
  assertStringIncludes(src, 'rpc("reassign_candidacy_check_pending"');
});

// ── 3. 派工 ────────────────────────────────────────────────────────
Deno.test("派工臂：五種訊號、接進 arms、等票中與確認是同一人的不派", async () => {
  const sig = await fnBody("candidacy_owner_mismatch_signals");
  for (const k of ["cec_birth_year", "submitted_region", "county_jump", "said_different", "vote_said_different"]) assertStringIncludes(sig, `'${k}'`, `訊號 ${k}`);
  assertStringIncludes(sig, "c.cec_birth_year <> x.birth_year", "名冊出生年不同");
  assertStringIncludes(sig, "c.applied_politician_id = x.politician_id", "交件縣市看的是建立這筆、而且還掛在這個人身上的交件");
  assertStringIncludes(sig, "b.election_date - a.election_date < 1700", "相隔一屆");
  assertStringIncludes(sig, "a.county <> b.county");
  assert(!/b\.election_type IN \([^)]*'縣市長'/.test(sig) && !/b\.election_type IN \([^)]*'立法委員'/.test(sig), "縣市長、立委換縣市很常見，不算訊號");
  assertEquals(sig.split("!~ '(不是|非|並非)同名不同人'").length - 1, 2, "查證者、驗證者兩種訊號都要排掉「不是同名不同人」");
  assertStringIncludes(sig, "AND EXISTS (SELECT 1 FROM politician_elections o WHERE o.politician_id = x.politician_id AND o.id <> x.id)", "驗證者說不同人的，只抓掛在另有別屆紀錄的既有人物上的");
  const arm = await fnBody("contribution_auto_tasks_owner_mismatch");
  assertStringIncludes(arm, `'auto:${OWNER_MISMATCH_TASK}:'`);
  assertStringIncludes(arm, "c.contribution_type = 'reassign_candidacy' AND c.status IN ('pending', 'verified')", "有人交了改掛在等票的不派");
  assertStringIncludes(arm, "tc.task_id = 'auto:candidacy_owner_mismatch:' || pe.id AND tc.outcome = 'confirmed'", "確認是同一人的不再派");
  for (const k of ["'other_records'", "'same_name'", "'cec_same_name'", "'signals'"]) assertStringIncludes(arm, k);
  const arms = await fnBody("contribution_auto_tasks_arms");
  // 派工時間窗 P1（20261008060000）起每個分支貼臂名：SELECT * FROM f() → SELECT 'f' AS arm, t.* FROM f() t
  assertStringIncludes(arms, "UNION ALL SELECT 'owner_mismatch' AS arm, t.* FROM contribution_auto_tasks_owner_mismatch() t");
  assertStringIncludes(arms, "UNION ALL SELECT 'election_results' AS arm, t.* FROM contribution_auto_tasks_election_results() t", "PR A 的臂照舊");
});

// ── 4. 交件與落庫 ───────────────────────────────────────────────────
Deno.test("交件：改掛對象二擇一、新建要姓名出生年政黨、evidence 至少一項、reason ≥20 字", () => {
  const errs = (payload: unknown) => validateContributionRequest({ agent_name: "tester", contributions: [{ contribution_type: REASSIGN_TYPE, payload, source_urls: ["https://web.cec.gov.tw/api/file/x.pdf"] }] }).errors.map((e) => e.path);
  assertEquals(errs(P), []);
  assertEquals(errs({ ...P, to_politician_id: undefined, new_politician: { name: "簡嘉佑", birth_year: 1987, party: "民主進步黨" } }), []);
  assert(errs({ ...P, new_politician: { name: "簡嘉佑", birth_year: 1987, party: "x" } }).includes("payload.to_politician_id"), "兩個都給");
  assert(errs({ ...P, to_politician_id: undefined }).includes("payload.to_politician_id"), "兩個都沒給");
  assert(errs({ ...P, to_politician_id: undefined, new_politician: { name: "簡嘉佑", party: "x" } }).includes("payload.new_politician.birth_year"), "新建要出生年");
  assert(errs({ ...P, to_politician_id: undefined, new_politician: { name: "簡嘉佑", birth_year: 1987 } }).includes("payload.new_politician.party"), "新建要政黨");
  assert(errs({ ...P, evidence: {} }).includes("payload.evidence"));
  assert(errs({ ...P, evidence: undefined }).includes("payload.evidence"));
  assert(errs({ ...P, reason: "不同人" }).includes("payload.reason"));
  assert(errs({ ...P, politician_election_id: "36379" }).includes("payload.politician_election_id"));
  assert(errs({ ...P, from_politician_id: undefined }).includes("payload.from_politician_id"), "現在掛的那位要寫（等票期間被改過的不蓋）");
});

function seed() {
  return {
    politician_elections: [{
      id: 36379, politician_id: FROM, election_id: 2026, election_type: "縣市議員", position: "縣市議員候選人",
      regions: { region: "桃園市" }, politicians: { id: FROM, name: "簡嘉佑", birth_year: 1959, party: "無黨籍", region: "桃園市", merged_into: null },
    }, { id: 18457, politician_id: FROM, election_id: 2022, election_type: "村里長" }, { id: 777, politician_id: TO, election_id: 2022, election_type: "縣市議員" }],
    politicians: [
      { id: FROM, name: "簡嘉佑", birth_year: 1959, party: "無黨籍", region: "桃園市", merged_into: null },
      { id: TO, name: "簡嘉佑", birth_year: 1987, party: "時代力量", region: "台中市", merged_into: null },
    ],
    politician_keys: [], politician_pair_resolutions: [], policies: [], edit_history: [],
  };
}
const row = (payload: unknown, id = "c-1") => ({ id, contribution_type: REASSIGN_TYPE as never, payload: payload as Record<string, unknown>, source_urls: ["https://web.cec.gov.tw/api/file/x.pdf"], note: null, agent_name: "tester", contributor_url: null });

Deno.test("落庫：改掛到既有的那位、記履歷、兩人記不同人；整筆還原倒回原本那位、刪掉不同人的判定", async () => {
  const fake = createFakeSupabase(seed());
  const out = await applyContribution(fake.client, row(P));
  assertEquals(out.status, "applied", out.message);
  assertEquals(fake.db.politician_elections.find((r) => r.id === 36379)!.politician_id, TO);
  assertEquals(fake.db.politician_elections.find((r) => r.id === 18457)!.politician_id, FROM, "同一人別屆的紀錄不動");
  const edits = fake.db.edit_history;
  assert(edits.some((e) => e.table_name === "politician_elections" && e.record_id === "36379" && e.field === "politician_id" && e.old_value === FROM && e.new_value === TO));
  const pair = fake.db.politician_pair_resolutions[0];
  assertEquals([pair.resolution, pair.pair_key], ["different", [FROM, TO].sort().join("|")]);
  assert(edits.some((e) => e.table_name === "politician_pair_resolutions" && e.field === "*"), "不同人的判定要能還原");
  assertStringIncludes(out.message, "1987");
  edits.forEach((e, i) => { e.id = i + 1; });
  const steps = planRevert(edits as never);
  assert(steps.some((s) => s.op === "restore" && s.table === "politician_elections" && s.field === "politician_id" && s.value === FROM), "還原把參選紀錄改回原本那位");
  assert(steps.some((s) => s.op === "delete" && s.table === "politician_pair_resolutions"), "還原刪掉不同人的判定");
});

Deno.test("落庫：檢查不過 → 退件不改；等票期間已經不掛在原本那位 → superseded 不蓋", async () => {
  const fake = createFakeSupabase(seed());
  const bad = await applyContribution(fake.client, row({ ...P, evidence: { birth_year: 1959 } }));
  assertEquals(bad.status, "disputed");
  assertEquals(fake.db.politician_elections.find((r) => r.id === 36379)!.politician_id, FROM, "沒有改");
  const moved = seed();
  moved.politician_elections[0].politician_id = "00000000-0000-4000-8000-000000000009";
  const fake2 = createFakeSupabase(moved);
  const out = await applyContribution(fake2.client, row(P));
  assertEquals(out.status, "superseded", out.message);
});

Deno.test("驗證項：寫清楚會把哪一筆從誰改到誰、要兩台機器；骨架兩條路都給", () => {
  const cur = shapeVerifyCurrent(REASSIGN_TYPE, P, { reassign: { ctx: base(), from_elections: [], to_elections: [], cec: null } });
  assertStringIncludes(String(cur.target_summary), "從 簡嘉佑（1959 年生");
  assertStringIncludes(String(cur.target_summary), "改掛到 簡嘉佑（1987 年生");
  assertStringIncludes(String(cur.hint), "兩台不同機器");
  assertStringIncludes(String(cur.hint), "agree");
  const tpl = buildBranchTemplates(OWNER_MISMATCH_TASK, { politician_election_id: 36379, name: "簡嘉佑", same_name: [{ politician_id: TO }] }, "auto:candidacy_owner_mismatch:36379")!;
  assertEquals(Object.keys(tpl).sort(), ["no_change", "reassign_candidacy"]);
  assertEquals((tpl.reassign_candidacy.payload as Record<string, unknown>).politician_election_id, 36379);
  const tpl2 = buildBranchTemplates(OWNER_MISMATCH_TASK, { politician_election_id: 36379, politician_id: FROM, name: "簡嘉佑" }, "auto:candidacy_owner_mismatch:36379")!;
  assertEquals((tpl2.reassign_candidacy.payload as Record<string, unknown>).from_politician_id, FROM, "骨架填好現在掛的那位");
});

// ── 5. 四處清點與協議 ────────────────────────────────────────────────
Deno.test("四處清點：DB CHECK、TS 清單、skill.md、標籤；協議 1.59.0", async () => {
  assert((CONTRIBUTION_TYPES as readonly string[]).includes(REASSIGN_TYPE));
  assert((TASK_TYPES as readonly string[]).includes(OWNER_MISMATCH_TASK));
  assertEquals(SUGGESTED_TYPE[OWNER_MISMATCH_TASK], REASSIGN_TYPE);
  assert(PAYLOAD_SHAPE[REASSIGN_TYPE] && TASK_GUIDANCE[OWNER_MISMATCH_TASK]);
  const sql = await latestDefining("ADD CONSTRAINT contributions_contribution_type_check");
  const check = sql.slice(sql.lastIndexOf("ADD CONSTRAINT contributions_contribution_type_check"));
  assertStringIncludes(check.slice(0, check.indexOf(";")), `'${REASSIGN_TYPE}'`);
  const labels = await Deno.readTextFile(new URL("../../../lib/task-labels.ts", import.meta.url));
  assert(new RegExp(`\\b${OWNER_MISMATCH_TASK}:\\s*'`).test(labels));
  for (const f of ["../../../pages/Queue.vue", "../../../pages/Contributions.vue", "../../../lib/model-quality.ts"]) {
    assertStringIncludes(await Deno.readTextFile(new URL(f, import.meta.url)), `${REASSIGN_TYPE}:`, `${f} 要有中文名稱`);
  }
  const [major, minor] = PROTOCOL_VERSION.split(".").map(Number);
  assert(major > 1 || (major === 1 && minor >= 59), `協議版號 ${PROTOCOL_VERSION} 比 1.59.0 舊`);
  const md = (await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url))).replace(/\r/g, "");
  for (const s of ["`candidacy_owner_mismatch` → `reassign_candidacy`", "**`reassign_candidacy`**", "| `reassign_candidacy`（同名人物接錯", "`removal`／`reassign_candidacy`（1.59.0）"]) assertStringIncludes(md, s);
});
