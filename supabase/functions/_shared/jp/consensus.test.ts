import { assertEquals } from "jsr:@std/assert@1";
import { effectiveRequiredAgree, JP_AGREE_THRESHOLDS, riskLevel, rejectFloor, requiredAgree, SYSTEM_VOTE_ELIGIBLE_TYPES, systemVoteEligible } from "./consensus.ts";
import { requiredAgree as twRequired, rejectFloor as twFloor } from "../consensus.ts";

// 日本站 SQL（policy_jp.contribution_required_agree／contribution_reject_floor）與正見同值：no_change／task_suggestion 2、correction 3
Deno.test("門檻：no_change／task_suggestion 目標 2，correction 目標 3", () => {
  assertEquals(requiredAgree("no_change"), 2);
  assertEquals(requiredAgree("task_suggestion"), 2);
  assertEquals(requiredAgree("correction"), 3);
  assertEquals(JP_AGREE_THRESHOLDS, { normal: 3, light: 2 });
});

Deno.test("退件門檻：light −2、其餘 −3", () => {
  assertEquals(rejectFloor("no_change"), 2);
  assertEquals(rejectFloor("task_suggestion"), 2);
  assertEquals(rejectFloor("correction"), 3);
});

Deno.test("跟正見同型別同門檻（不是另創一套）", () => {
  for (const t of ["no_change", "task_suggestion"]) {
    assertEquals(requiredAgree(t), twRequired(t, {}, ["https://example.test/a"]));
    assertEquals(rejectFloor(t), twFloor(t));
  }
  // correction：正見只有動 candidate_status 才升高風險，其他欄位同為 3
  assertEquals(requiredAgree("correction"), twRequired("correction", { target_table: "policies", changes: [{ field: "title" }] }, []));
  assertEquals(rejectFloor("correction"), twFloor("correction"));
});

Deno.test("系統票：supported −1（最少 1）、not_supported +1、棄權照舊", () => {
  assertEquals(effectiveRequiredAgree(3, "supported"), 2);
  assertEquals(effectiveRequiredAgree(1, "supported"), 1);
  assertEquals(effectiveRequiredAgree(3, "not_supported"), 4);
  assertEquals(effectiveRequiredAgree(3, null), 3);
  assertEquals(systemVoteEligible("correction"), true);
  assertEquals(systemVoteEligible("no_change"), false);
});

// election（查到的選舉日程，PR②）：SQL（policy_jp.contribution_required_agree／contribution_reject_floor／system_vote_eligible）
// 沒有為它開分支，走 ELSE：目標 3、退件 −3、不拿系統票。SQL 那一邊由 policy-jp-election-discovery.test.ts 對齊。
Deno.test("election：目標 3、退件 −3（跟 correction 同級，不是 light）", () => {
  assertEquals(riskLevel("election"), "normal");
  assertEquals(requiredAgree("election"), 3);
  assertEquals(requiredAgree("election", { election_type: "mayor" }, ["https://www.city.example.lg.jp/senkyo/"]), 3);
  assertEquals(rejectFloor("election"), 3);
});

Deno.test("election：不拿系統票——可投型別清單沒有它，門檻不被調", () => {
  assertEquals(systemVoteEligible("election"), false);
  assertEquals([...SYSTEM_VOTE_ELIGIBLE_TYPES], ["correction"]);
  // 就算有人硬帶系統票結果，呼叫端也不會對 election 取（不 eligible），但函式本身的算法不分型別：eligible 的判斷在 systemVoteEligible
  assertEquals(effectiveRequiredAgree(requiredAgree("election"), null), 3);
});

// local_government、regional_stat（落庫那一批 PR）：跟 election 同級（SQL 走 ELSE 的 normal）；SQL 與 TS 的逐型別對齊在 policy-jp-apply.test.ts
Deno.test("local_government／regional_stat：目標 3、退件 −3、不拿系統票、不需要兩個網段", () => {
  for (const t of ["local_government", "regional_stat"]) {
    assertEquals(riskLevel(t), "normal");
    assertEquals(requiredAgree(t), 3);
    assertEquals(requiredAgree(t, { lg_code: "232033" }, ["https://www.soumu.go.jp/denshijiti/code.html"]), 3);
    assertEquals(rejectFloor(t), 3);
    assertEquals(systemVoteEligible(t), false);
    assertEquals(effectiveRequiredAgree(requiredAgree(t), null), 3);
  }
});
