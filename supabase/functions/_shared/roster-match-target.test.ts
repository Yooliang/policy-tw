/**
 * 名冊逐位吻合的參選紀錄：目標分數 1（維護者 2026-10-01 核准）。
 *
 * 起因：系統逐位核對中選會名冊（model policy-tw/roster-batch…）判「姓名、縣市、政黨都對得上」的參選紀錄，
 * 原本跟一般 Jev 系統票一樣只讓目標 −1（3→2）。實測 89 筆名冊吻合的 pending 目標都是 2、84 筆 0 票：
 * 名冊來源就是中選會，驗證者找不到不同網域的第二來源拿 +2，實際要兩台機器各投一票。
 * 改成：名冊逐位吻合的 supported → 目標 1，一張普通同意就過；反對照舊能擋（+1−1=0 不到 1）。
 * 只對這種「系統逐位比對官方名冊」的 supported 生效，一般 Jev 的 supported 維持 −1。
 *
 * SQL 與 TS 各一份（contribution_effective_agree／contribution_apply_consensus vs consensus.ts），這裡兩邊一起盯。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { effectiveRequiredAgree, isRosterMatchModel, ROSTER_MATCH_MODEL_PREFIX, ROSTER_MATCHED_TARGET, scoreStatus } from "./consensus.ts";
import { ROSTER_BATCH_MODEL } from "./cec-roster.ts";

async function latestMigrationDefining(marker: string): Promise<{ name: string; sql: string }> {
  const dir = new URL("../../migrations/", import.meta.url);
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  for (const name of names.sort().reverse()) {
    const sql = await Deno.readTextFile(new URL(name, dir));
    const at = sql.indexOf(marker);
    if (at >= 0) return { name, sql: sql.slice(at) };
  }
  throw new Error(`找不到定義 ${marker} 的 migration`);
}

Deno.test("名冊逐位吻合：目標 1；一般系統票 supported 照舊 −1；not_supported 不受影響", () => {
  assertEquals(ROSTER_MATCHED_TARGET, 1);
  assertEquals(effectiveRequiredAgree(3, "supported", true), 1, "名冊吻合 → 一張同意就過");
  assertEquals(effectiveRequiredAgree(3, "supported", false), 2, "一般 Jev supported 維持 3→2");
  assertEquals(effectiveRequiredAgree(3, "supported"), 2, "沒說是名冊就是一般系統票");
  assertEquals(effectiveRequiredAgree(3, "not_supported", true), 4, "名冊吻合只看 supported；not_supported 照舊 +1");
  assertEquals(effectiveRequiredAgree(3, null, true), 3, "棄權不降");
});

Deno.test("名冊模型辨識：前綴與 system-one 寫入的 model 一致", () => {
  assert(ROSTER_BATCH_MODEL.startsWith(ROSTER_MATCH_MODEL_PREFIX), "system-one 寫的 model 要對得上辨識前綴");
  assert(isRosterMatchModel(ROSTER_BATCH_MODEL));
  assert(!isRosterMatchModel("policy-tw/moi-check-20260924"));
  assert(!isRosterMatchModel("openrouter/some-model"));
  assert(!isRosterMatchModel(null));
});

Deno.test("名冊吻合的參選紀錄：一張同意（一台機器）就通過；一同意一反對不過", () => {
  const base = { target: 1, contributionType: "candidacy", current: "pending" };
  assertEquals(scoreStatus({ ...base, score: 1, distinctIps: 1, rosterMatched: true }), "verified", "一張 +1 就到目標，系統逐位核過名冊算另一雙眼睛");
  assertEquals(scoreStatus({ ...base, score: 0, distinctIps: 2, rosterMatched: true }), "pending", "反對照舊能擋");
  assertEquals(scoreStatus({ ...base, score: 1, distinctIps: 1 }), "pending", "不是名冊吻合的參選紀錄仍要兩台機器");
});

Deno.test("SQL 與 TS 一致：名冊吻合判斷、目標 1、免兩台機器都在最新的計票函式裡", async () => {
  const matched = await latestMigrationDefining("FUNCTION contribution_roster_matched");
  assert(matched.sql.includes(`LIKE '${ROSTER_MATCH_MODEL_PREFIX}%'`), "SQL 要用同一個 model 前綴辨識名冊核對");
  assert(matched.sql.includes("'supported'"), "只有 supported 算吻合");
  assert(matched.sql.includes("system_one_min_probability()"), "跟 contribution_system_vote 同一套合格條件（最新一張有效系統票）");

  const eff = await latestMigrationDefining("FUNCTION contribution_effective_agree");
  assert(eff.sql.includes("contribution_roster_matched(p_contribution_id)"), "有效門檻要看名冊吻合");
  assert(eff.sql.includes(`THEN LEAST(v_need, ${ROSTER_MATCHED_TARGET})`), "名冊吻合的目標是 ROSTER_MATCHED_TARGET（跟 TS 的 Math.min 同義）");
  // 一般 supported：依核得過的獨立來源數 −1～−2（2026-10-09，policy-ops#39），名冊吻合那一條排在它前面
  assert(eff.sql.includes("GREATEST(1, v_need - COALESCE(contribution_system_vote_sources(p_contribution_id), 1))"), "一般 supported −1～−2、最少 1");
  assert(eff.sql.indexOf("contribution_roster_matched(p_contribution_id)") < eff.sql.indexOf("contribution_system_vote_sources(p_contribution_id)"), "名冊吻合優先");

  const fn = await latestMigrationDefining("FUNCTION contribution_apply_consensus");
  // 2026-10-06（#349）起「要兩台機器」的判斷抽成 contribution_needs_two_ips（多看 payload：中止交接），名冊吻合的例外照舊
  assert(
    fn.sql.includes("v_type NOT IN ('merge_politician', 'candidacy', 'removal') OR v_ips >= 2 OR contribution_roster_matched(p_contribution_id)")
      || fn.sql.includes("NOT contribution_needs_two_ips(v_type, v_payload) OR v_ips >= 2 OR contribution_roster_matched(p_contribution_id)"),
    "名冊吻合的參選紀錄免兩台機器，否則目標 1 也要兩票");

  // 讓現有符合條件的 pending 立刻重算
  // 2026-10-09（policy-ops#39）起 contribution_effective_agree 由 20261009290000 重新定義，重算那一段留在名冊那支 migration（定義 contribution_roster_matched 的那支）
  assert(/contribution_apply_consensus\(c\.id\)/.test(matched.sql) || /contribution_apply_consensus\(c\.id\)/.test(fn.sql), "migration 要把現有名冊吻合的 pending 重算一次");
});
