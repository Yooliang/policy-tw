import { assertEquals } from "jsr:@std/assert";
import { findNoOpPending } from "./noop-sweep.ts";

const cur = (table: string, rows: Record<string, unknown>[]) =>
  new Map([[table, new Map(rows.map((r) => [String(r.id), r]))]]);

// 2026-09-23 W-Policy：等票期間別人先修好了，這筆還在池子裡吃票
Deno.test("每一欄都跟現值相同 → 退池", () => {
  const hits = findNoOpPending(
    [{ id: "c1", payload: { target_table: "policies", target_id: "p1", changes: [{ field: "election_id", correct_value: "2024" }] } }],
    cur("policies", [{ id: "p1", election_id: 2024 }]),
  );
  assertEquals(hits, [{ id: "c1", fields: ["election_id"] }]);
});

Deno.test("部分相同 → 不動（還有欄位真的要改）", () => {
  const hits = findNoOpPending(
    [{ id: "c1", payload: { target_table: "policies", target_id: "p1", changes: [
      { field: "election_id", correct_value: 2024 }, { field: "proposed_date", correct_value: "2024-01-01" },
    ] } }],
    cur("policies", [{ id: "p1", election_id: 2024, proposed_date: "2023-05-05" }]),
  );
  assertEquals(hits, []);
});

Deno.test("舊的單欄位格式也認；清空日期與 null 相同", () => {
  const hits = findNoOpPending(
    [{ id: "c1", payload: { target_table: "policies", target_id: "p1", field: "proposed_date", correct_value: "" } }],
    cur("policies", [{ id: "p1", proposed_date: null }]),
  );
  assertEquals(hits.map((h) => h.id), ["c1"]);
});

Deno.test("找不到目標列、不在白名單、沒有 changes → 不動", () => {
  const current = cur("policies", [{ id: "p1", election_id: 2024 }]);
  assertEquals(findNoOpPending([{ id: "a", payload: { target_table: "policies", target_id: "zz", changes: [{ field: "election_id", correct_value: 2024 }] } }], current), []);
  assertEquals(findNoOpPending([{ id: "b", payload: { target_table: "policies", target_id: "p1", changes: [{ field: "id", correct_value: "p1" }] } }], current), []);
  assertEquals(findNoOpPending([{ id: "c", payload: { target_table: "policies", target_id: "p1", changes: [] } }], current), []);
});
