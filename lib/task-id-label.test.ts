import { assert, assertEquals } from "jsr:@std/assert@1";
import { TASK_KIND_LABEL, taskIdLabel } from "./task-id-label.ts";
import { TASK_TYPE_LABEL } from "./task-labels.ts";

const U = "3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b";

Deno.test("子類先於型別：profile_detail_gap:sources 是補學經歷出處，不是補學經歷條列", () => {
  assertEquals(taskIdLabel(`auto:profile_detail_gap:sources:${U}`), "補學經歷出處");
  assertEquals(taskIdLabel(`auto:profile_detail_gap:${U}`), TASK_TYPE_LABEL.profile_detail_gap);
  assert(TASK_KIND_LABEL["profile_detail_gap:sources"] !== TASK_TYPE_LABEL.profile_detail_gap);
});

Deno.test("沒有子類的自動缺口走 task-labels 的型別名稱（整數 id、uuid 都行）", () => {
  assertEquals(taskIdLabel("auto:candidate_status_stale:10009"), TASK_TYPE_LABEL.candidate_status_stale);
  assertEquals(taskIdLabel(`auto:policy_missing:${U}`), TASK_TYPE_LABEL.policy_missing);
  assertEquals(taskIdLabel(`auto:duplicate_policy:${U}:${U}`), TASK_TYPE_LABEL.duplicate_policy);
});

Deno.test("其他子類", () => {
  assertEquals(taskIdLabel(`auto:candidacy_source_missing:party:${U}`), "補參選政黨");
  assertEquals(taskIdLabel("auto:candidacy_source_missing:cand_no:112-新北市-x"), "補號次");
  assertEquals(taskIdLabel("auto:not_running_recheck:filing:123"), "登記後退選核對");
  // 沒有子類的同型別，仍走型別名稱
  assertEquals(taskIdLabel("auto:candidacy_source_missing:123"), TASK_TYPE_LABEL.candidacy_source_missing);
});

Deno.test("手動任務（單純 uuid）與驗證（verify: 開頭）", () => {
  assertEquals(taskIdLabel(U), "手動任務");
  assertEquals(taskIdLabel(U.toUpperCase()), "手動任務");
  assertEquals(taskIdLabel(`verify:${U}`), "驗證");
  assertEquals(taskIdLabel("verify:12345"), "驗證");
});

Deno.test("對不上的類型顯示原字串，不顯示空白；沒有編號回空字串", () => {
  assertEquals(taskIdLabel("auto:brand_new_type:123"), "auto:brand_new_type:123");
  assertEquals(taskIdLabel("something-else"), "something-else");
  assertEquals(taskIdLabel("auto:"), "auto:");
  assertEquals(taskIdLabel("auto:constructor:1"), "auto:constructor:1");
  assertEquals(taskIdLabel(null), "");
  assertEquals(taskIdLabel(undefined), "");
  assertEquals(taskIdLabel("  "), "");
});

Deno.test("子類名稱都是純中文（含全形括號），型別鍵都真的存在於 task-labels", () => {
  for (const [key, label] of Object.entries(TASK_KIND_LABEL)) {
    assert(!/[A-Za-z]/.test(label), `${key} 的名稱要純中文：${label}`);
    assert(key.split(":")[0] in TASK_TYPE_LABEL, `${key} 的型別不在 TASK_TYPE_LABEL`);
  }
});
