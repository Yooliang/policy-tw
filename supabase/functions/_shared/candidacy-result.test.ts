import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { changedFields, electionResultLabel, electionResultPatch } from "./candidacy-result.ts";

// 2026-09-19：election_result_missing 的答案（張嘉哲 2022 南投市長）通過後只記了 confirmed→confirmed，結果三欄全丟
Deno.test("electionResultPatch：只收格式對的三欄，沒給的不出現", () => {
  assertEquals(electionResultPatch({ election_result: "elected", votes_received: 29150, vote_percentage: 53.7 }), { election_result: "elected", votes_received: 29150, vote_percentage: 53.7 });
  assertEquals(electionResultPatch({ election_result: "won", votes_received: -1, vote_percentage: 120 }), {});
  assertEquals(electionResultPatch({ candidate_status: "confirmed" }), {});
  assertEquals(electionResultPatch({ election_result: "not_elected", votes_received: 12.5 }), { election_result: "not_elected" });
});

Deno.test("electionResultLabel：當選（29,150 票，53.7%）；沒結果就 null", () => {
  assertEquals(electionResultLabel({ election_result: "elected", votes_received: 29150, vote_percentage: 53.7 }), "當選（29,150 票，53.7%）");
  assertEquals(electionResultLabel({ election_result: "not_elected" }), "落選");
  assertEquals(electionResultLabel({ election_result: "not_elected", vote_percentage: 31.2 }), "落選（31.2%）");
  assertEquals(electionResultLabel({ candidate_status: "confirmed" }), null);
});

Deno.test("changedFields：沒變的不列；null→值、值→值都列；undefined 當沒給", () => {
  const before = { candidate_status: "confirmed", election_result: null, votes_received: null, source_note: "中選會官方資料" };
  const after = { candidate_status: "confirmed", election_result: "elected", votes_received: 29150, source_note: "貢獻者：a-zhen", position: undefined };
  assertEquals(changedFields(before, after), [
    ["election_result", null, "elected"],
    ["votes_received", null, 29150],
    ["source_note", "中選會官方資料", "貢獻者：a-zhen"],
  ]);
  assertEquals(changedFields(null, { candidate_status: "registered" }), [["candidate_status", null, "registered"]]);
  assertEquals(changedFields({ votes_received: 29150 }, { votes_received: 29150 }), []);
});
