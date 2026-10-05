import { assertEquals } from "jsr:@std/assert@1";
import { currentElection, daysUntil, splitElections, taipeiDay } from "./election-list.ts";

// 線上的三筆（10-05）：id 剛好是年份；另造一場補選，id 不是年份、投票日夾在中間
const E2022 = { id: 2022, electionDate: "2022-11-26" };
const E2024 = { id: 2024, electionDate: "2024-01-13" };
const E2026 = { id: 2026, electionDate: "2026-11-28" };
const BY = { id: 4, electionDate: "2025-08-23" };
const ALL = [E2022, E2024, E2026]; // 跟前端載入的順序一樣（依 id 遞增）

Deno.test("taipeiDay：用台灣日期，不是 UTC（台灣午夜 0:30 已經是隔天）", () => {
  assertEquals(taipeiDay(Date.parse("2026-11-27T16:30:00Z")), "2026-11-28");
  assertEquals(taipeiDay(Date.parse("2026-11-27T15:59:00Z")), "2026-11-27");
});

Deno.test("今後／過去：投票日當天還算今後；今後由近到遠、過去由近到遠", () => {
  const { upcoming, past } = splitElections([...ALL, BY], "2026-11-28");
  assertEquals(upcoming.map((e) => e.id), [2026]);
  assertEquals(past.map((e) => e.id), [4, 2024, 2022]);
  const before = splitElections([...ALL, BY], "2023-01-01");
  assertEquals(before.upcoming.map((e) => e.id), [2024, 4, 2026]);
  assertEquals(before.past.map((e) => e.id), [2022]);
});

Deno.test("目前的選舉：選前是最近一場還沒投的", () => {
  assertEquals(currentElection(ALL, "2026-10-05")?.id, 2026);
  assertEquals(currentElection(ALL, "2026-11-28")?.id, 2026);
});

Deno.test("目前的選舉：投票隔天不會退回 2022（舊的 startDate ≤ 今天 ≤ endDate 會）", () => {
  assertEquals(currentElection(ALL, "2026-11-29")?.id, 2026);
  assertEquals(currentElection(ALL, "2027-06-01")?.id, 2026);
});

Deno.test("目前的選舉：看投票日不看 id——id 不是年份的補選照日期排", () => {
  assertEquals(currentElection([...ALL, BY], "2025-01-01")?.id, 4);
  assertEquals(currentElection([...ALL, BY], "2025-09-01")?.id, 2026);
});

Deno.test("目前的選舉：沒有選舉回 undefined；沒有投票日的不算", () => {
  assertEquals(currentElection([], "2026-10-05"), undefined);
  assertEquals(currentElection([{ id: 9, electionDate: "" }], "2026-10-05"), undefined);
});

Deno.test("距離投票日：今天投票 0、明天 1、昨天 -1，跨月跨年都對", () => {
  assertEquals(daysUntil("2026-11-28", "2026-11-28"), 0);
  assertEquals(daysUntil("2026-11-28", "2026-10-05"), 54);
  assertEquals(daysUntil("2026-11-28", "2026-11-29"), -1);
  assertEquals(daysUntil("2028-01-15", "2027-12-31"), 15);
});
