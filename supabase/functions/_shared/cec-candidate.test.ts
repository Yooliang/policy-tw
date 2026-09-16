import { assert, assertEquals } from "jsr:@std/assert@1";
import { normalizeCandidacies, pickByElectionId, withoutFutureResults } from "./cec-candidate.ts";

// 2026-09-17 對 db.cec.gov.tw 實抓「蔡易餘」的回傳（只留用得到的欄位）
const RAW = [
  { theme_id: "9c96a2080bfc199c590ec54f3a2bda7b", theme_name: "第11屆立法委員選舉 - 區域", vote_date: "2024-01-13", cand_id: 203374, cand_name: "蔡易餘", cand_birthyear: "1981", party_name: "民主進步黨", is_victor: "*", area_data: { current_area: { area_name: "嘉義縣嘉義縣第01選區" } } },
  { theme_id: "081e3c257c", theme_name: "第08屆立法委員選舉 - 區域", vote_date: "2012-01-14", cand_id: 6677, cand_name: "蔡易餘", cand_birthyear: "1981", party_name: "民主進步黨", is_victor: "", area_data: { current_area: { area_name: "嘉義縣第01選區" } } },
  { theme_id: "be404784ef", theme_name: "第10屆立法委員選舉 - 區域", vote_date: "2020-01-11", cand_id: 7228, cand_name: "蔡易餘", cand_birthyear: "1981", party_name: "民主進步黨", is_victor: "*" },
];

Deno.test("中選會回傳整理：依投票日新到舊、屆別取投票年份、is_victor 轉成 election_result", () => {
  const list = normalizeCandidacies(RAW);
  assertEquals(list.map((c) => c.election_id), [2024, 2020, 2012], "新的在前");
  assertEquals(list[0].election_result, "elected");
  assertEquals(list[2].election_result, "not_elected", "is_victor 空字串＝沒當選");
  assertEquals(list[0].birth_year, 1981);
  assertEquals(list[0].party, "民主進步黨");
  assertEquals(list[0].cand_id, 203374);
  assert((list[0].area ?? "").includes("第01選區"));
});

Deno.test("還沒投票的選舉不能說沒當選", () => {
  const future = normalizeCandidacies([{ theme_name: "2026 縣市長", vote_date: "2026-11-28", cand_name: "某人", is_victor: "" }]);
  assertEquals(future[0].election_result, "not_elected", "整理階段照實轉");
  assertEquals(withoutFutureResults(future, "2026-09-17")[0].election_result, null, "投票日還沒到 → 結果未知");
  assertEquals(withoutFutureResults(normalizeCandidacies(RAW), "2026-09-17")[0].election_result, "elected", "已投票的不受影響");
});

Deno.test("挑某一屆：找得到回那筆，找不到回 null", () => {
  const list = normalizeCandidacies(RAW);
  assertEquals(pickByElectionId(list, 2020)?.cand_id, 7228);
  assertEquals(pickByElectionId(list, 2026), null);
});

Deno.test("欄位缺漏不會炸", () => {
  const list = normalizeCandidacies([{}]);
  assertEquals(list[0].name, "");
  assertEquals(list[0].election_id, null);
  assertEquals(list[0].birth_year, null);
});
