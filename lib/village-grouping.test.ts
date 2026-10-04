import { assertEquals } from "jsr:@std/assert@1";
import { groupByVillage } from "./village-grouping.ts";

Deno.test("依 knownVillages 的順序分組，每組只留真的有人的里", () => {
  const people = [
    { name: "甲", village: "力行里" },
    { name: "乙", village: "大光里" },
    { name: "丙", village: "力行里" },
  ];
  const groups = groupByVillage(people, ["力行里", "大光里", "大港里"]);
  assertEquals(groups.map(g => g.village), ["力行里", "大光里"]);
  assertEquals(groups[0].people.map(p => p.name), ["甲", "丙"]);
  assertEquals(groups[1].people.map(p => p.name), ["乙"]);
});

Deno.test("village 是空值的人收進「未標示里別」，不會悄悄消失", () => {
  const people = [
    { name: "甲", village: "力行里" },
    { name: "乙", village: undefined },
    { name: "丙", village: null },
  ];
  const groups = groupByVillage(people, ["力行里"]);
  assertEquals(groups.map(g => g.village), ["力行里", "未標示里別"]);
  assertEquals(groups[1].people.map(p => p.name), ["乙", "丙"]);
});

Deno.test("village 不在 knownVillages 清單裡的人（資料對不上）也收進「未標示里別」", () => {
  const people = [
    { name: "甲", village: "力行里" },
    { name: "乙", village: "已裁併里" },
  ];
  const groups = groupByVillage(people, ["力行里"]);
  assertEquals(groups.map(g => g.village), ["力行里", "未標示里別"]);
  assertEquals(groups[1].people.map(p => p.name), ["乙"]);
});

Deno.test("「未標示里別」一律排在最後，就算它先出現在資料裡", () => {
  const people = [
    { name: "甲", village: undefined },
    { name: "乙", village: "力行里" },
  ];
  const groups = groupByVillage(people, ["力行里"]);
  assertEquals(groups.map(g => g.village), ["力行里", "未標示里別"]);
});

Deno.test("沒有任何未標示的人就不會多出空的「未標示里別」組", () => {
  const people = [{ name: "甲", village: "力行里" }];
  const groups = groupByVillage(people, ["力行里", "大光里"]);
  assertEquals(groups.map(g => g.village), ["力行里"]);
});
