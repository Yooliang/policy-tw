import { assertEquals } from "jsr:@std/assert@1";
import { planRevert } from "./edit-history.ts";

// 2026-09-20 審查建議 6：合併時被刪掉的參選列與身份鍵要能還原——field='*'、old=整列、new=NULL 就是「請把這一列放回去」
Deno.test("planRevert：合併的還原順序＝先放回被刪的列、再還原欄位、最後刪新增的列", () => {
  const keep = "00000000-0000-4000-8000-000000000001", remove = "00000000-0000-4000-8000-000000000002";
  const edits = [
    { id: 1, table_name: "policies", record_id: "p1", field: "politician_id", old_value: remove, new_value: keep, contribution_id: "c", agent_name: "a" },
    { id: 2, table_name: "politician_elections", record_id: "77", field: "*", old_value: { id: 77, politician_id: remove, election_id: 2022 }, new_value: null, contribution_id: "c", agent_name: "a" },
    { id: 3, table_name: "politicians", record_id: keep, field: "birth_year", old_value: null, new_value: 1986, contribution_id: "c", agent_name: "a" },
    { id: 4, table_name: "politicians", record_id: remove, field: "merged_into", old_value: null, new_value: keep, contribution_id: "c", agent_name: "a" },
    { id: 5, table_name: "politician_pair_resolutions", record_id: "r1", field: "*", old_value: null, new_value: { id: "r1", resolution: "same" }, contribution_id: "c", agent_name: "a" },
  ];
  const steps = planRevert(edits);
  assertEquals(steps.map((s) => s.op), ["reinsert", "restore", "restore", "restore", "delete"]);
  assertEquals(steps[0], { op: "reinsert", table: "politician_elections", record_id: "77", row: { id: 77, politician_id: remove, election_id: 2022 }, edit_id: 2 });
  assertEquals(steps.find((s) => s.op === "restore" && s.record_id === "p1"), { op: "restore", table: "policies", record_id: "p1", field: "politician_id", value: remove, edit_id: 1 });
  assertEquals(steps[steps.length - 1], { op: "delete", table: "politician_pair_resolutions", record_id: "r1", edit_id: 5 });
});
