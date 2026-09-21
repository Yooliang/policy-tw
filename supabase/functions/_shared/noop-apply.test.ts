import { assertEquals } from "jsr:@std/assert";
import { splitNoOpChanges } from "./correction.ts";
import { contributionStatusFor } from "./apply-contribution.ts";

// #3／#6（2026-09-22）：提交時的 no_op_correction 只擋得住那一刻；等票期間別人先修好了，落庫時要再比一次。
Deno.test("全部欄位改完跟現值一樣 → 沒有要改的，落庫標 superseded", () => {
  const r = splitNoOpChanges({ election_id: 2026, candidate_status: "not_running" }, { election_id: 2026, candidate_status: "not_running" });
  assertEquals(Object.keys(r.changed), []);
  assertEquals(r.noop, ["election_id", "candidate_status"]);
  assertEquals(contributionStatusFor("superseded"), "superseded");
});

Deno.test("部分一樣 → 只改真的會改的欄位，一樣的列出來", () => {
  const r = splitNoOpChanges({ election_id: 2026, proposed_date: "2026-01-02" }, { election_id: "2026", proposed_date: "2025-12-31" });
  assertEquals(r.changed, { proposed_date: "2026-01-02" });
  assertEquals(r.noop, ["election_id"], "2026 與 \"2026\" 正規化後相同");
});

Deno.test("空值收斂：null／undefined／空字串互相算相同", () => {
  const r = splitNoOpChanges({ bio: "" }, { bio: null });
  assertEquals(Object.keys(r.changed), []);
});
