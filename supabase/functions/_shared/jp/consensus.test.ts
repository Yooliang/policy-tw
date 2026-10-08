import { assertEquals } from "jsr:@std/assert@1";
import { effectiveRequiredAgree, JP_AGREE_THRESHOLDS, rejectFloor, requiredAgree, systemVoteEligible } from "./consensus.ts";
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
