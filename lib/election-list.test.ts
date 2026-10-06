import { assertEquals } from "jsr:@std/assert@1";
import { currentElection, daysUntil, footerElections, splitElections, taipeiDay, turnoutText } from "./election-list.ts";

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

Deno.test("投票率：寫明首長選舉合計與是哪幾場；沒有投票率不顯示", () => {
  // 2022 地方選舉：直轄市長＋縣市長兩場合計 61.16%（不是媒體常引的直轄市長 59.86%）
  assertEquals(turnoutText({ turnout: 61.16, types: ["縣市長", "縣市議員", "村里長"] }), "投票率 61.16%（首長選舉合計：直轄市長＋縣市長）");
  assertEquals(turnoutText({ turnout: 71.86, types: ["總統副總統", "立法委員"] }), "投票率 71.86%（首長選舉合計：總統副總統）");
  assertEquals(turnoutText({ turnout: 60.5, types: [] }), "投票率 60.50%（首長選舉合計：直轄市長＋縣市長）");
  assertEquals(turnoutText({ turnout: null, types: ["縣市長"] }), null);
  assertEquals(turnoutText({ types: ["縣市長"] }), null);
});

Deno.test("頁尾選舉清單：最近要投票的一場＋過去由新到舊，合計最多 3 筆", () => {
  // 選前：2026 在最前，後面接 2024、補選（過去由新到舊），2022 被 3 筆上限擋掉
  assertEquals(footerElections([...ALL, BY], "2026-10-05").map((e) => e.id), [2026, 4, 2024]);
  assertEquals(footerElections(ALL, "2026-10-05").map((e) => e.id), [2026, 2024, 2022]);
});

Deno.test("頁尾選舉清單：投完票隔天，沒有未來的選舉就放最近的 3 場過去屆別；今後有好幾場只放最近那一場", () => {
  assertEquals(footerElections([...ALL, BY], "2026-11-29").map((e) => e.id), [2026, 4, 2024]);
  assertEquals(footerElections([...ALL, { id: 5, electionDate: "2028-01-15" }], "2026-11-29").map((e) => e.id), [5, 2026, 2024]);
  assertEquals(footerElections([], "2026-10-05"), []);
});

// #344 第二階段 A：2022-12-18 嘉義市長重行選舉（id 4）拆成自己的一場後，頁尾的過去屆別不能被它擠掉 2022 九合一
const RERUN = { id: 4, electionDate: "2022-12-18", electionReason: "rerun" };
const BY_ELECTION = { id: 5, electionDate: "2027-03-06", electionReason: "by_election" };
Deno.test("頁尾選舉清單：過去的補選、重行選舉不佔名額（從選舉一覽進去）；今後最近的一場補選照樣算", () => {
  assertEquals(footerElections([...ALL, RERUN], "2026-10-05").map((e) => e.id), [2026, 2024, 2022]);
  assertEquals(footerElections([...ALL, RERUN, BY_ELECTION], "2026-11-29").map((e) => e.id), [5, 2026, 2024], "補選還沒投就是「最近要投票的那一場」");
  assertEquals(footerElections([...ALL, RERUN, BY_ELECTION], "2027-03-07").map((e) => e.id), [2026, 2024, 2022], "補選投完就退到一覽");
});

Deno.test("選舉一覽與目前的選舉：重行選舉依投票日排在 2024 與 2022 之間，不看 id（id 4 比 2022 小、但日期比較晚）", () => {
  assertEquals(splitElections([RERUN, ...ALL], "2026-10-05").past.map((e) => e.id), [2024, 4, 2022]);
  assertEquals(currentElection([RERUN, ...ALL], "2026-10-05")?.id, 2026);
});
