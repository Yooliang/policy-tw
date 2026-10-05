import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { changedFields, electionResultLabel, electionResultPatch, ignoredVoteFields, voteFieldsNotice } from "./candidacy-result.ts";

// 2026-09-19：election_result_missing 的答案（張嘉哲 2022 南投市長）通過後只記了 confirmed→confirmed，結果三欄全丟
// 2026-10-06（#345）：得票數、得票率不收——只剩 election_result 會寫進去
Deno.test("electionResultPatch：只收格式對的 election_result；得票數、得票率一律不寫（#345）", () => {
  assertEquals(electionResultPatch({ election_result: "elected", votes_received: 29150, vote_percentage: 53.7 }), { election_result: "elected" });
  assertEquals(electionResultPatch({ election_result: "won", votes_received: -1, vote_percentage: 120 }), {});
  assertEquals(electionResultPatch({ candidate_status: "confirmed" }), {});
  assertEquals(electionResultPatch({ election_result: "not_elected", votes_received: 12.5 }), { election_result: "not_elected" });
  assertEquals(electionResultPatch({ votes_received: 29150 }), {});
});

Deno.test("ignoredVoteFields／voteFieldsNotice：帶了票數就講一聲，沒帶不講", () => {
  assertEquals(ignoredVoteFields({ votes_received: 29150, vote_percentage: 53.7 }), ["votes_received", "vote_percentage"]);
  assertEquals(ignoredVoteFields({ election_result: "elected", vote_percentage: null }), []);
  assertEquals(voteFieldsNotice({ election_result: "elected" }), null);
  const n = voteFieldsNotice({ votes_received: 0 }) ?? "";
  assertEquals(n.includes("votes_received") && n.includes("不收"), true);
});

Deno.test("electionResultLabel：當選／落選，不帶票數；沒結果就 null", () => {
  assertEquals(electionResultLabel({ election_result: "elected", votes_received: 29150, vote_percentage: 53.7 }), "當選");
  assertEquals(electionResultLabel({ election_result: "not_elected" }), "落選");
  assertEquals(electionResultLabel({ election_result: "not_elected", vote_percentage: 31.2 }), "落選");
  assertEquals(electionResultLabel({ candidate_status: "confirmed" }), null);
});

Deno.test("changedFields：沒變的不列；null→值、值→值都列；undefined 當沒給", () => {
  const before = { candidate_status: "confirmed", election_result: null, source_note: "中選會官方資料" };
  const after = { candidate_status: "confirmed", election_result: "elected", source_note: "貢獻者：a-zhen", position: undefined };
  assertEquals(changedFields(before, after), [
    ["election_result", null, "elected"],
    ["source_note", "中選會官方資料", "貢獻者：a-zhen"],
  ]);
  assertEquals(changedFields(null, { candidate_status: "registered" }), [["candidate_status", null, "registered"]]);
  assertEquals(changedFields({ cand_no: 3 }, { cand_no: 3 }), []);
});
