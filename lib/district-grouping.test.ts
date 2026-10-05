/**
 * 守三件事：自然排序（第02 在 第10 前面）、選區沒填的人不會從畫面消失、
 * 以及快篩清單裡不要出現「未標示選舉區」這種點不下去的東西。
 */
import { assertEquals } from "jsr:@std/assert@1";
import { UNLABELED_DISTRICT, districtsOf, groupByDistrict } from "./district-grouping.ts";

const p = (name: string, subRegion?: string | null) => ({ name, subRegion });

Deno.test("依選區分組，組內保持原順序", () => {
  const groups = groupByDistrict([
    p("甲", "第01選舉區"),
    p("乙", "第02選舉區"),
    p("丙", "第01選舉區"),
  ]);
  assertEquals(groups.length, 2);
  assertEquals(groups[0].district, "第01選舉區");
  assertEquals(groups[0].people.map((x) => x.name), ["甲", "丙"]);
  assertEquals(groups[1].people.map((x) => x.name), ["乙"]);
});

// 字串比較會把 第10 排到 第02 前面（字元 '1' < '2'），那樣分組順序整個亂掉
Deno.test("自然排序：第02選舉區 排在 第10選舉區 前面", () => {
  const groups = groupByDistrict([
    p("十", "第10選舉區"),
    p("二", "第02選舉區"),
    p("一", "第01選舉區"),
    p("九", "第09選舉區"),
  ]);
  assertEquals(groups.map((g) => g.district), ["第01選舉區", "第02選舉區", "第09選舉區", "第10選舉區"]);
});

Deno.test("原住民區代表的選區格式（XX區第NN選舉區）照樣分得開", () => {
  const groups = groupByDistrict([
    p("那一", "那瑪夏區第01選舉區"),
    p("桃一", "桃源區第01選舉區"),
    p("那二", "那瑪夏區第02選舉區"),
  ]);
  assertEquals(groups.map((g) => g.district), ["那瑪夏區第01選舉區", "那瑪夏區第02選舉區", "桃源區第01選舉區"]);
});

// 2022 的縣市議員有 41 筆 sub_region 是 NULL。舊寫法若只留「有選區」的人，這 41 位就從畫面上消失了。
Deno.test("選區沒填的人收進最後一組，不會從畫面消失", () => {
  const groups = groupByDistrict([
    p("甲", "第01選舉區"),
    p("沒填", null),
    p("空字串", ""),
    p("空白", "   "),
    p("未定義", undefined),
  ]);
  assertEquals(groups.length, 2);
  assertEquals(groups[0].district, "第01選舉區");
  assertEquals(groups[1].district, UNLABELED_DISTRICT);
  assertEquals(groups[1].people.map((x) => x.name), ["沒填", "空字串", "空白", "未定義"]);
});

Deno.test("全部都沒填選區時只有一組，而且總人數不少", () => {
  const groups = groupByDistrict([p("甲"), p("乙")]);
  assertEquals(groups.length, 1);
  assertEquals(groups[0].district, UNLABELED_DISTRICT);
  assertEquals(groups[0].people.length, 2);
});

Deno.test("沒有人就沒有組", () => {
  assertEquals(groupByDistrict([]), []);
});

Deno.test("分組不會吃掉任何人", () => {
  const people = [p("a", "第01選舉區"), p("b", null), p("c", "第02選舉區"), p("d", "第01選舉區"), p("e", "")];
  const total = groupByDistrict(people).reduce((n, g) => n + g.people.length, 0);
  assertEquals(total, people.length);
});

Deno.test("快篩清單是排好序的真選區，不含「未標示選舉區」", () => {
  const list = districtsOf([
    p("十", "第10選舉區"),
    p("沒填", null),
    p("二", "第02選舉區"),
  ]);
  assertEquals(list, ["第02選舉區", "第10選舉區"]);
});

Deno.test("快篩清單不會有重複的選區", () => {
  const list = districtsOf([p("甲", "第01選舉區"), p("乙", "第01選舉區")]);
  assertEquals(list, ["第01選舉區"]);
});
