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

// 2026-10-12：source_url（政見）、candidate_status（參選紀錄）是協議的欄位名，資料表裡已沒有同名欄位。
// 掃地機以前拿去 select，整張表那一批讀取報錯跳過（正式庫日誌每輪兩條），同表其他更正也不退池。
Deno.test("協議欄位名不是資料表欄位：不判這筆、也不拿去讀", async () => {
  assertEquals(findNoOpPending(
    [{ id: "s", payload: { target_table: "policies", target_id: "p1", changes: [{ field: "source_url", correct_value: "https://a" }] } },
     { id: "c", payload: { target_table: "politician_elections", target_id: "7", changes: [{ field: "candidate_status", correct_value: "registered" }] } }],
    new Map<string, Map<string, Record<string, unknown>>>([
      ["policies", new Map([["p1", { id: "p1", source_url: "https://a" }]])],
      ["politician_elections", new Map([["7", { id: 7, candidate_status: "registered" }]])],
    ]),
  ), []);

  const PE_COLUMNS = new Set(["id", "position", "election_type", "withdrawn_after_filing", "candidacy_status"]);
  const POLICY_COLUMNS = new Set(["id", "title", "description", "category", "status", "proposed_date", "election_id", "origin"]);
  const pending = [
    { id: "s", payload: { target_table: "policies", target_id: "p1", changes: [{ field: "source_url", correct_value: "https://a" }] } },
    { id: "e", payload: { target_table: "policies", target_id: "p1", changes: [{ field: "election_id", correct_value: 2024 }] } },
    { id: "c", payload: { target_table: "politician_elections", target_id: "7", changes: [{ field: "candidate_status", correct_value: "registered" }] } },
    { id: "t", payload: { target_table: "politician_elections", target_id: "7", changes: [{ field: "position", correct_value: "議員" }] } },
  ];
  const rows: Record<string, Record<string, unknown>> = {
    policies: { id: "p1", election_id: 2024 },
    politician_elections: { id: 7, position: "議員" },
  };
  const retired: string[] = [];
  const client = {
    from(table: string) {
      return {
        select(cols: string) {
          if (table === "contributions") {
            const q = { eq: () => q, order: () => q, limit: () => Promise.resolve({ data: pending, error: null }) };
            return q;
          }
          const known = table === "policies" ? POLICY_COLUMNS : PE_COLUMNS;
          const bad = cols.split(",").map((c) => c.trim()).find((c) => !known.has(c));
          return { in: () => Promise.resolve(bad ? { data: null, error: { message: `column ${table}.${bad} does not exist` } } : { data: [rows[table]], error: null }) };
        },
        update() {
          let id = "";
          const q = { eq: (k: string, v: string) => { if (k === "id") id = v; return q; }, select: () => { retired.push(id); return Promise.resolve({ data: [{ id }], error: null }); } };
          return q;
        },
      };
    },
  };
  const { sweepNoOpCorrections } = await import("./noop-sweep.ts");
  const out = await sweepNoOpCorrections(client);
  assertEquals(out.superseded.sort(), ["e", "t"]);
});
