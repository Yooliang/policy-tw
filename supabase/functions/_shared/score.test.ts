import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { rejectFloor, scoreStatus, voteWeight, weightReason } from "./consensus.ts";

// 分數制（2026-09-21）。這些是 SQL 的鏡像；最後一條測試直接盯 migration 的文字，
// 兩邊的權重表不一致就紅。

Deno.test("一票值幾分", () => {
  assertEquals(voteWeight("agree", false), 1);
  assertEquals(voteWeight("agree", true), 2);
  assertEquals(voteWeight("disagree", false), -1);
  assertEquals(voteWeight("disagree", true), -2);
  assertEquals(voteWeight("unsure", false), 0);
  assertEquals(voteWeight("unsure", true), 0);
});

Deno.test("理由要告訴代理怎麼拿到 +2", () => {
  assertStringIncludes(weightReason("agree", false), "evidence_url");
  assertStringIncludes(weightReason("disagree", false), "−2");
});

Deno.test("附了來源但沒核過：理由要講「系統會自己核」，不是「去附來源」、更不是「去打 judge」", () => {
  // 2026-09-23：代理不該把判斷外包給 Jev，+2 由系統核 evidence_url 決定
  assertStringIncludes(weightReason("agree", false, true), "系統會");
  assertEquals(weightReason("agree", false, true).includes("附一個不同網域"), false);
  assertEquals(weightReason("agree", false, true).includes("judge"), false);
  assertStringIncludes(weightReason("disagree", false, true), "系統會");
  assertEquals(weightReason("disagree", false, true).includes("judge"), false);
});

Deno.test("達目標→verified；跌到退件門檻→rejected；其餘 pending", () => {
  // 目標 2（系統票 supported 把 3 壓成 2）：上線門檻跟著目標，退件門檻不跟——policy 仍是 −3 才退
  const base = { target: 2, distinctIps: 2, contributionType: "policy", current: "pending" };
  assertEquals(scoreStatus({ ...base, score: 2 }), "verified");
  assertEquals(scoreStatus({ ...base, score: 3 }), "verified");
  assertEquals(scoreStatus({ ...base, score: 1 }), "pending");
  assertEquals(scoreStatus({ ...base, score: -1 }), "pending");
  assertEquals(scoreStatus({ ...base, score: -2 }), "pending");
  assertEquals(scoreStatus({ ...base, score: -3 }), "rejected");
});

Deno.test("退件門檻固定（2026-09-23）：目標被 Jev 調高到 4，−3 照樣退；不動正式資料的型別 −2 就退", () => {
  assertEquals(rejectFloor("policy"), 3);
  assertEquals(rejectFloor("candidacy"), 3);
  assertEquals(rejectFloor("task_suggestion"), 2);
  assertEquals(rejectFloor("no_change"), 2);
  assertEquals(rejectFloor("roster_check"), 2);
  // Jev 判不支持 → 目標 4；退件不能因此變成 −4
  assertEquals(scoreStatus({ score: -3, target: 4, distinctIps: 2, contributionType: "policy", current: "pending" }), "rejected");
  assertEquals(scoreStatus({ score: -2, target: 4, distinctIps: 2, contributionType: "policy", current: "pending" }), "pending");
  // 票數預算接上後目標可到 7：退件仍是 −3
  assertEquals(scoreStatus({ score: -3, target: 7, distinctIps: 2, contributionType: "candidacy", current: "pending" }), "rejected");
  assertEquals(scoreStatus({ score: -2, target: 2, distinctIps: 1, contributionType: "task_suggestion", current: "pending" }), "rejected");
});

Deno.test("SQL 的退件門檻跟 TS 一致（盯 migration 文字）", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20260923000007_reject_floor.sql", import.meta.url));
  assertStringIncludes(sql, "WHEN p_type IN ('task_suggestion', 'no_change', 'roster_check') THEN 2");
  assertStringIncludes(sql, "ELSE 3");
  assertStringIncludes(sql, "IF v_score <= -v_reject THEN", "SQL 的退件要用固定門檻 v_reject，不是 −v_target");
});

Deno.test("裁決退場：兩張反對不再變 disputed，而是依分數退件或繼續等", () => {
  const base = { target: 3, distinctIps: 2, contributionType: "policy", current: "pending" };
  // 兩張 −1 = −2，目標 3 → 還沒到 −3，繼續 pending（以前這裡會變 disputed）
  assertEquals(scoreStatus({ ...base, score: -2 }), "pending");
  assertEquals(scoreStatus({ ...base, score: -3 }), "rejected");
});

Deno.test("高風險型別：單一 IP 湊到分數也不過", () => {
  const base = { score: 4, target: 4, current: "pending" };
  assertEquals(scoreStatus({ ...base, distinctIps: 1, contributionType: "candidacy" }), "pending");
  assertEquals(scoreStatus({ ...base, distinctIps: 2, contributionType: "candidacy" }), "verified");
  assertEquals(scoreStatus({ ...base, distinctIps: 1, contributionType: "policy" }), "verified");
});

Deno.test("已定案的狀態不受分數影響", () => {
  for (const current of ["applied", "rejected", "withdrawn", "approved"]) {
    assertEquals(scoreStatus({ score: 9, target: 2, distinctIps: 3, contributionType: "policy", current }), current);
  }
});

Deno.test("SQL 的權重表跟 TS 一致（盯 migration 文字）", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20260921000021_score_consensus.sql", import.meta.url));
  assertStringIncludes(sql, "WHEN p_verdict = 'agree'    THEN CASE WHEN COALESCE(p_judge_backed, false) THEN 2 ELSE 1 END");
  assertStringIncludes(sql, "WHEN p_verdict = 'disagree' THEN CASE WHEN COALESCE(p_judge_backed, false) THEN -2 ELSE -1 END");
  assertStringIncludes(sql, "IF v_score <= -v_target THEN");
  assertStringIncludes(sql, "v_type NOT IN ('merge_politician', 'candidacy', 'removal') OR v_ips >= 2");
  // 不再產生 disputed
  assertEquals(/v_new := 'disputed'/.test(sql), false);
});
