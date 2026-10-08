/**
 * 守號次的呈現（#460）：
 *   1. 只有正整數算號次，其餘一律當沒有（徽章、標題都不出）；
 *   2. 標題帶「（2 號）」、沒有號次標題不變；
 *   3. 同一場選舉內有號次的在前、沒有的維持原順序，而且不同場次互不干擾、整份清單的位置不動。
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  ballotLabel,
  ballotNo,
  ballotNoOfElection,
  compareBallotNo,
  nameWithBallot,
  orderByBallotNo,
  orderPeopleByBallotNo,
} from "./ballot-number.ts";

Deno.test("只有正整數算號次", () => {
  assertEquals(ballotNo(1), 1);
  assertEquals(ballotNo(12), 12);
  for (const bad of [0, -3, 1.5, NaN, "2", null, undefined, true]) assertEquals(ballotNo(bad), undefined);
});

Deno.test("徽章文字：N 號；沒有號次是空字串", () => {
  assertEquals(ballotLabel(2), "2 號");
  assertEquals(ballotLabel(undefined), "");
  assertEquals(ballotLabel(0), "");
});

Deno.test("姓名帶號次：標題用", () => {
  assertEquals(nameWithBallot("王小明", 2), "王小明（2 號）");
  assertEquals(nameWithBallot("王小明", undefined), "王小明");
  assertEquals(nameWithBallot("王小明", null), "王小明");
});

Deno.test("號次先後：有號次在前、小的在前、都沒有回 0", () => {
  assertEquals(compareBallotNo(1, 2) < 0, true);
  assertEquals(compareBallotNo(3, 1) > 0, true);
  assertEquals(compareBallotNo(5, undefined) < 0, true);
  assertEquals(compareBallotNo(undefined, 5) > 0, true);
  assertEquals(compareBallotNo(undefined, undefined), 0);
  assertEquals(compareBallotNo(0, undefined), 0, "0 不是號次");
});

type P = { id: string; name: string; candNo?: number; electionType: string; region?: string; subRegion?: string; village?: string };
const p = (id: string, electionType: string, o: Partial<P> = {}): P => ({ id, name: id, electionType, ...o });
const ids = (xs: P[]) => xs.map((x) => x.id);

Deno.test("同一場：有號次照號次在前，沒有號次排後面並維持原順序", () => {
  const list = [
    p("無甲", "縣市長", { region: "臺北市" }),
    p("三號", "縣市長", { region: "臺北市", candNo: 3 }),
    p("無乙", "縣市長", { region: "臺北市" }),
    p("一號", "縣市長", { region: "臺北市", candNo: 1 }),
  ];
  assertEquals(ids(orderPeopleByBallotNo(list)), ["一號", "三號", "無甲", "無乙"]);
});

Deno.test("沒有任何人有號次：整份清單完全不變", () => {
  const list = [p("丙", "縣市長", { region: "臺北市" }), p("甲", "縣市長", { region: "臺北市" }), p("乙", "縣市長", { region: "新北市" })];
  assertEquals(ids(orderPeopleByBallotNo(list)), ["丙", "甲", "乙"]);
});

Deno.test("不同縣市的縣市長互不干擾：各縣市佔的位置不動", () => {
  const list = [
    p("北無", "縣市長", { region: "臺北市" }),
    p("新二", "縣市長", { region: "新北市", candNo: 2 }),
    p("北一", "縣市長", { region: "臺北市", candNo: 1 }),
    p("新一", "縣市長", { region: "新北市", candNo: 1 }),
  ];
  // 臺北市佔第 0、2 格：一號進第 0 格、無號次的退到第 2 格；新北市佔第 1、3 格：一號進第 1 格
  assertEquals(ids(orderPeopleByBallotNo(list)), ["北一", "新一", "北無", "新二"]);
});

Deno.test("議員照選舉區分場；選區待補的人（分不出哪一場）原地不動", () => {
  const list = [
    p("待補", "縣市議員", { region: "臺北市" }),
    p("二區二", "縣市議員", { region: "臺北市", subRegion: "第02選舉區", candNo: 2 }),
    p("一區無", "縣市議員", { region: "臺北市", subRegion: "第01選舉區" }),
    p("二區一", "縣市議員", { region: "臺北市", subRegion: "第02選舉區", candNo: 1 }),
    p("一區五", "縣市議員", { region: "臺北市", subRegion: "第01選舉區", candNo: 5 }),
  ];
  assertEquals(ids(orderPeopleByBallotNo(list)), ["待補", "二區一", "一區五", "二區二", "一區無"]);
});

Deno.test("總統副總統：副手分不出場次，原地不動", () => {
  const list = [
    p("副", "總統副總統", { position: "副總統" } as Partial<P>),
    p("總二", "總統副總統", { position: "總統", candNo: 2 } as Partial<P>),
    p("總一", "總統副總統", { position: "總統", candNo: 1 } as Partial<P>),
  ];
  assertEquals(ids(orderPeopleByBallotNo(list)), ["副", "總一", "總二"]);
});

Deno.test("通用版：group 回 undefined 的不動；不改動原陣列", () => {
  const src = [{ n: 2, g: "a" }, { n: undefined, g: undefined }, { n: 1, g: "a" }];
  const out = orderByBallotNo(src, { candNo: (x) => x.n, group: (x) => x.g });
  assertEquals(out.map((x) => x.n), [1, undefined, 2]);
  assertEquals(src.map((x) => x.n), [2, undefined, 1]);
});

Deno.test("某一屆的號次：只認該屆、退選的不算", () => {
  const els = [
    { electionId: 2022, candNo: 7, candidacyStatus: "not_elected" },
    { electionId: 2026, candNo: 2, candidacyStatus: "filed" },
  ];
  assertEquals(ballotNoOfElection(els, 2026), 2);
  assertEquals(ballotNoOfElection(els, 2022), 7);
  assertEquals(ballotNoOfElection(els, 2024), undefined);
  assertEquals(ballotNoOfElection([{ electionId: 2026, candNo: 2, candidacyStatus: "withdrawn" }], 2026), undefined);
  assertEquals(ballotNoOfElection([{ electionId: 2026, candidacyStatus: "filed" }], 2026), undefined);
  assertEquals(ballotNoOfElection(undefined, 2026), undefined);
  assertEquals(ballotNoOfElection(els, null), undefined);
});
