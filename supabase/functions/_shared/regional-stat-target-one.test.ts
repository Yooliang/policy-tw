/**
 * regional_stat 目標分數 3 → 1（#741，維護者 2026-10-27）的守門測試。
 * 一位驗證人同意即上線；一張反對照舊擋得住；其他型別不變；現有 pending 在 migration 內以既有共識函式重算。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { AGREE_THRESHOLDS, rejectFloor, requiredAgree, riskLevel, scoreStatus, needsTwoIps, DISPUTED_MIN_DISAGREE } from "./consensus.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const MIG = "20261027080000_regional_stat_target_one.sql";
const PAYLOAD = { admin_code: "63000010", stat_key: "population", year: 2025, value: 12345, unit: "人" };
const OFFICIAL = ["https://www.ris.gov.tw/app/portal/346"];

async function migration(): Promise<string> {
  return (await Deno.readTextFile(new URL(MIG, MIGRATIONS))).replace(/\r\n/g, "\n");
}
/** 最後一支定義 contribution_required_agree 的 migration 本體（換行統一成 \n） */
async function latestRequiredAgree(): Promise<{ name: string; body: string }> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  names.sort();
  let hit = { name: "", body: "" };
  for (const n of names) {
    const t = (await Deno.readTextFile(new URL(n, MIGRATIONS))).replace(/\r\n/g, "\n");
    if (t.includes("CREATE OR REPLACE FUNCTION contribution_required_agree(")) hit = { name: n, body: t.slice(t.lastIndexOf("CREATE OR REPLACE FUNCTION contribution_required_agree(")) };
  }
  return hit;
}

Deno.test("regional_stat：獨立風險等級、目標 1（不看來源）；不是 light", () => {
  assertEquals(riskLevel("regional_stat", PAYLOAD), "regional_stat");
  assertEquals(AGREE_THRESHOLDS.regional_stat, { official: 1, media: 1, social: 1, other: 1 });
  for (const src of [OFFICIAL, ["https://example.com/x"], []]) assertEquals(requiredAgree("regional_stat", PAYLOAD, src), 1);
  assertEquals(AGREE_THRESHOLDS.light.official, 2, "light 仍是 2");
  assert(!needsTwoIps("regional_stat", PAYLOAD), "不要求兩台機器：一位驗證人即可");
});

Deno.test("一位驗證人同意（+1 或 +2）即上線；沒有票維持 pending", () => {
  const target = requiredAgree("regional_stat", PAYLOAD, OFFICIAL);
  for (const score of [1, 2]) {
    assertEquals(scoreStatus({ score, target, distinctIps: 1, contributionType: "regional_stat", current: "pending" }), "verified", `分數 ${score}`);
  }
  assertEquals(scoreStatus({ score: 0, target, distinctIps: 0, contributionType: "regional_stat", current: "pending" }), "pending", "分數 0 不會被自動落庫");
});

Deno.test("有反對票：1 張反對擋得住、2 張帶反證轉爭議、退件門檻照舊 3", () => {
  const target = requiredAgree("regional_stat", PAYLOAD, OFFICIAL);
  // 一張 +1 同意加一張 −1 反對＝0，不到 1
  assertEquals(scoreStatus({ score: 0, target, distinctIps: 2, contributionType: "regional_stat", current: "pending" }), "pending");
  // 一張 −2 反對擋得住
  assertEquals(scoreStatus({ score: -2, target, distinctIps: 1, contributionType: "regional_stat", current: "pending" }), "pending");
  assertEquals(rejectFloor("regional_stat"), 3);
  assertEquals(scoreStatus({ score: -3, target, distinctIps: 2, contributionType: "regional_stat", current: "pending" }), "rejected");
  assertEquals(DISPUTED_MIN_DISAGREE, 2);
});

Deno.test("其他型別門檻不變", () => {
  assertEquals(requiredAgree("policy", {}, OFFICIAL), 3);
  assertEquals(requiredAgree("politician", {}, OFFICIAL), 3);
  assertEquals(requiredAgree("correction", { field: "name" }, OFFICIAL), 3);
  assertEquals(requiredAgree("party_info", {}, OFFICIAL), 3);
  assertEquals(requiredAgree("district_seats", {}, OFFICIAL), 3);
  assertEquals(requiredAgree("no_change", {}, OFFICIAL), 2);
  assertEquals(requiredAgree("roster_check", {}, OFFICIAL), 2);
  assertEquals(requiredAgree("election_results", {}, OFFICIAL), 2);
  assertEquals(requiredAgree("candidacy", {}, OFFICIAL), 3);
  assertEquals(requiredAgree("removal", {}, OFFICIAL), 3);
  assertEquals(requiredAgree("adjudication", {}, OFFICIAL), 3);
});

Deno.test("SQL 與 TS 一致：最新的 contribution_required_agree 是這支 migration，regional_stat 目標 1，其他列不變", async () => {
  const { name, body } = await latestRequiredAgree();
  assertEquals(name, MIG, "之後若有人再改這支函式，請改看新的那支");
  const fn = body.slice(0, body.indexOf("$$;", body.indexOf("$$") + 2));
  assertStringIncludes(fn, "WHEN p_type = 'regional_stat' THEN 'regional_stat'");
  assertStringIncludes(fn, "WHEN v_risk = 'regional_stat' THEN CASE v_kind WHEN 'official' THEN 1 WHEN 'media' THEN 1 WHEN 'social' THEN 1 ELSE 1 END");
  assert(fn.indexOf("'regional_stat' THEN 'regional_stat'") < fn.indexOf("WHEN p_type = 'candidacy'"), "型別判斷要在 candidacy 之前");
  assertStringIncludes(fn, "WHEN v_risk = 'batch_result' THEN CASE v_kind WHEN 'official' THEN 2");
  assertStringIncludes(fn, "WHEN v_risk = 'normal' THEN CASE v_kind WHEN 'official' THEN 3");
  assertStringIncludes(fn, "WHEN p_type IN ('task_suggestion', 'no_change', 'roster_check') THEN 'light'");
});

Deno.test("重算：現有 pending 的 regional_stat 走既有共識函式；只動共識欄位與派工快照，不 UPDATE 任何正式資料表", async () => {
  const sql = await migration();
  const doBlock = sql.slice(sql.indexOf("DO $$"));
  assertStringIncludes(doBlock, "contribution_type = 'regional_stat' AND status = 'pending'");
  assertStringIncludes(doBlock, "PERFORM contribution_apply_consensus(r.id)");
  const updates = [...sql.matchAll(/^\s*UPDATE\s+(\w+)/gim)].map((m) => m[1]);
  assertEquals(updates, ["task_dispatches"], "只允許對齊派工快照");
  assert(!/\b(INSERT\s+INTO|DELETE\s+FROM)\b/i.test(sql.replace(/--.*$/gm, "")), "不寫入或刪除任何資料");
  assert(!/regional_stats\b/.test(sql.replace(/--.*$/gm, "")), "不碰正式表 regional_stats");
});
