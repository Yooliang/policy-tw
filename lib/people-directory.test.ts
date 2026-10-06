/**
 * 人物一覽（#346）：依姓氏筆畫分組。守的是：
 *   1. 筆畫數是台灣寫法（陳 11、黃 12、吳 7、顏 18，不是康熙部首算法），漢字以外歸「其他」
 *   2. 一行說明照職稱規則：只來自任期；沒有現任公職的寫最近一次參選（照投票日，不照 id）；落選的人不寫成現任
 *   3. 每一位都在、只在一組；已合併的人不列；同一組照姓名筆畫排、同姓排在一起
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildDirectory, candidacyNote, chineseNumber, directoryLabel, firstChar, groupKeyOf, groupLabel, isGroupKey, OTHER_GROUP, RESULT_PENDING,
  sectionsBySurname, strokeCount,
} from "./people-directory.ts";
import type { Election, Politician } from "../types.ts";

const person = (p: Partial<Politician> & { id: string; name: string }): Politician =>
  ({ party: "無黨籍", position: "", region: "", ...p }) as Politician;
const ELECTIONS: Election[] = [
  { id: 2022, name: "2022 地方選舉", shortName: "2022 地方", startDate: "", endDate: "", electionDate: "2022-11-26", types: [] },
  { id: 2024, name: "2024 總統立委", shortName: "2024", startDate: "", endDate: "", electionDate: "2024-01-13", types: [] },
  { id: 2026, name: "2026 地方選舉", shortName: "2026 地方", startDate: "", endDate: "", electionDate: "2026-11-28", types: [] },
  // 之後新增的選舉 id 不是年份（#344）：id 小、投票日最晚
  { id: 7, name: "2027 補選", shortName: "2027 補選", startDate: "", endDate: "", electionDate: "2027-03-01", types: [] },
];
const dates = new Map(ELECTIONS.map((e) => [e.id, e.electionDate]));
const TODAY = "2026-10-06";

Deno.test("筆畫數：台灣寫法，漢字以外是 null", () => {
  const want: Record<string, number> = { 一: 1, 丁: 2, 王: 4, 吳: 7, 李: 7, 林: 8, 陳: 11, 張: 11, 郭: 11, 黃: 12, 曾: 12, 蔡: 15, 劉: 15, 賴: 16, 謝: 17, 顏: 18, 龔: 22 };
  for (const [ch, n] of Object.entries(want)) assertEquals(strokeCount(ch), n, ch);
  assertEquals(strokeCount("A"), null);
  assertEquals(strokeCount(""), null);
  assertEquals(strokeCount("．"), null);
  assertEquals(groupKeyOf("陳建志"), "11");
  assertEquals(groupKeyOf("Kawlo．Iyun"), OTHER_GROUP);
  assertEquals(groupKeyOf(" 林小明"), "8", "前後空白不算");
  assertEquals(firstChar("𦰡里長"), "𦰡", "罕用字（兩個 UTF-16 單位）照字算");
});

Deno.test("組名：中文數字＋畫；網址的組名只認 1～64 與 other", () => {
  assertEquals([1, 2, 10, 11, 19, 20, 22, 30].map(chineseNumber), ["一", "二", "十", "十一", "十九", "二十", "二十二", "三十"]);
  assertEquals(groupLabel("11"), "十一畫");
  assertEquals(groupLabel(OTHER_GROUP), "其他");
  for (const ok of ["1", "11", "64", OTHER_GROUP]) assert(isGroupKey(ok), ok);
  for (const bad of ["0", "65", "011", "abc", "", "11a", "../x"]) assert(!isGroupKey(bad), bad);
});

Deno.test("一行說明：現任職稱只來自任期；沒有就寫最近一次參選（照投票日）；落選的人不寫成現任", () => {
  const mayor = person({
    id: "a", name: "甲", elections: [{ electionId: 2022, position: "", region: "台南市", electionType: "縣市長", electionResult: "elected", candidateStatus: "elected" }],
    offices: [{ electionId: 2022, electionType: "縣市長", region: "台南市" }],
  });
  assertEquals(directoryLabel(mayor, dates, TODAY), "台南市長");
  const loser = person({
    id: "b", name: "乙", position: "台南市立委",
    elections: [{ electionId: 2024, position: "台南市立委", region: "台南市", electionType: "立法委員", electionResult: "not_elected" }],
  });
  assertEquals(directoryLabel(loser, dates, TODAY), "2024 台南市立委・落選", "position 不能當職稱");
  const byElection = person({
    id: "c", name: "丙",
    elections: [
      { electionId: 2026, position: "", region: "高雄市", electionType: "縣市議員", candidateStatus: "registered" },
      { electionId: 7, position: "", region: "高雄市", electionType: "立法委員", candidateStatus: "registered" },
    ],
  });
  assertEquals(directoryLabel(byElection, dates, TODAY), "2027 高雄市立委・已登記", "最近一次與年份都照投票日（補選 id 7 在 2027）");
  assertEquals(directoryLabel(person({ id: "d", name: "丁" }), dates, TODAY), "");
  // 2022 早期匯入的人狀態停在 confirmed：投完票之後不寫「表態參選」，結果還沒補上就寫「參選人」
  const village = person({ id: "e", name: "戊", elections: [{ electionId: 2022, position: "", region: "屏東縣", subRegion: "東港鎮", village: "內關帝里", electionType: "村里長", candidateStatus: "confirmed" }] });
  assertEquals(directoryLabel(village, dates, TODAY), "2022 東港鎮內關帝里長參選人");
});

Deno.test("狀態字：投完票只講結果（沒結果寫結果待補），還沒投票講登記階段", () => {
  assertEquals(candidacyNote({ candidateStatus: "confirmed" }, true), RESULT_PENDING);
  assertEquals(candidacyNote({ candidateStatus: "registered" }, true), RESULT_PENDING);
  assertEquals(candidacyNote({ candidateStatus: "confirmed" }, false), "表態參選");
  assertEquals(candidacyNote({ candidateStatus: "registered" }, false), "已登記");
  assertEquals(candidacyNote({ candidateStatus: "confirmed", electionResult: "elected" }, true), "當選");
  assertEquals(candidacyNote({ candidateStatus: "defeated" }, true), "落選");
  assertEquals(candidacyNote({ candidateStatus: "not_running", withdrawnAfterFiling: true }, true), "登記後退選");
  assertEquals(candidacyNote({ candidateStatus: "not_running" }, false), "不參選");
});

Deno.test("分組：每一位都在、只在一組；已合併的不列；同一組照姓名筆畫排、同姓在一起", () => {
  const people = [
    person({ id: "1", name: "陳二" }), person({ id: "2", name: "林一" }), person({ id: "3", name: "張三" }),
    person({ id: "4", name: "陳一" }), person({ id: "5", name: "Kawlo" }), person({ id: "6", name: "陳一" }),
    person({ id: "7", name: "王五", mergedInto: "x" }), person({ id: "8", name: "  " }),
  ];
  const { index, groups } = buildDirectory(people, ELECTIONS, TODAY);
  const ids = [...groups.values()].flatMap((g) => g.entries.map((e) => e.id)).sort();
  assertEquals(ids, ["1", "2", "3", "4", "5", "6"]);
  assertEquals(index.map((g) => g.key), ["8", "11", OTHER_GROUP], "照筆畫數排，其他在最後");
  assertEquals(index.find((g) => g.key === "11")!.count, 4);
  const eleven = groups.get("11")!;
  const sections = sectionsBySurname(eleven.entries);
  assertEquals(sections.map((s) => s.char).sort(), ["張", "陳"].sort());
  assertEquals(sections.find((s) => s.char === "陳")!.entries.map((e) => e.id), ["4", "6", "1"], "同名照 id，同姓排在一起");
  assertEquals(index.find((g) => g.key === "11")!.surnames.reduce((n, s) => n + s.count, 0), 4);
});
