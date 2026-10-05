/**
 * 同職位、同選區參選人的政見並排比較（#364，2026-10-05）。
 *
 * 守的是「只並排、不排名」：欄的順序只看號次、沒有號次看姓名筆畫，不看政見數或其他；
 * 同一場的人才放在同一張表（縣市長一縣一場、立委一選區一場、鄉鎮首長一鄉鎮一場，沒選區的不硬湊）；
 * 退選與不參選的人不上表；任內施政承諾不是這場選舉的政見。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { belongsToElection, compareColumnOrder, compareMatrix, comparablePeople, gridCompareGroups, worthComparing, type ComparePerson } from "./policy-compare.ts";
import type { Policy } from "../types.ts";

const person = (id: string, name: string, over: Partial<ComparePerson> = {}): ComparePerson => ({ id, name, ...over });
function policy(id: string, politicianId: string, category: string, over: Partial<Policy> = {}): Policy {
  return {
    id, politicianId, electionId: 2026, title: `政見${id}`, description: "", category, status: "Campaign Pledge" as Policy["status"],
    proposedDate: null, lastUpdated: "2026-09-01", progress: 0, tags: [], logs: [], stanceSupport: 0, stanceOppose: 0, stancePriority: 0, ...over,
  };
}

Deno.test("欄的順序：有號次照號次，沒有號次的排後面照姓名筆畫（先字數再筆畫）", () => {
  const people = [person("a", "歐陽大明"), person("b", "王二", { candNo: 3 }), person("c", "李四"), person("d", "張三", { candNo: 1 })];
  assertEquals([...people].sort(compareColumnOrder).map((p) => p.id), ["d", "b", "c", "a"]);
});

Deno.test("欄的順序不看政見多寡：政見多的人不會因此排前面", () => {
  const people = [person("b", "王二"), person("a", "丁一")];
  const policies = [policy("1", "b", "交通建設"), policy("2", "b", "交通建設"), policy("3", "b", "社會福利")];
  const m = compareMatrix(people, policies, 2026, ["交通建設", "社會福利"]);
  assertEquals(m.columns.map((c) => c.id), ["a", "b"], "丁一筆畫少排前面，跟他沒有政見無關");
});

Deno.test("退選與不參選的人不上表", () => {
  const people = [person("a", "甲", { candidateStatus: "registered" }), person("b", "乙", { candidateStatus: "withdrawn" }), person("c", "丙", { candidateStatus: "not_running" })];
  assertEquals(comparablePeople(people).map((p) => p.id), ["a"]);
});

Deno.test("列＝類別（照網站分類表的順序，只列有人有政見的類別），格子＝那個人在這一類的政見，沒有就是空的", () => {
  // 丁（2 畫）排在王（4 畫）前面：欄的順序就是 a、b
  const people = [person("b", "王二"), person("a", "丁一")];
  const policies = [
    policy("1", "a", "社會福利"),
    policy("2", "b", "交通建設"),
    policy("3", "a", "交通建設"),
    policy("4", "z", "交通建設"), // 不在這張表的人
  ];
  const m = compareMatrix(people, policies, 2026, ["交通建設", "都市發展與住宅", "社會福利"]);
  assertEquals(m.rows.map((r) => r.category), ["交通建設", "社會福利"], "沒人有政見的類別不列");
  assertEquals(m.rows[0].cells.map((c) => c.map((p) => p.id)), [["3"], ["2"]]);
  assertEquals(m.rows[1].cells.map((c) => c.map((p) => p.id)), [["1"], []], "王二沒有社會福利類的政見：格子是空的，不是借別類來填");
  assertEquals(m.policyCount, 3);
  assert(worthComparing(m));
});

Deno.test("只放這一場選舉的政見：別屆的、任內施政承諾（Proposed）不放；推動中、已實現的照放", () => {
  assert(belongsToElection({ electionId: 2022, status: "In Progress" as Policy["status"] }, 2022));
  assert(belongsToElection({ electionId: 2022, status: "Achieved" as Policy["status"] }, 2022));
  assert(!belongsToElection({ electionId: 2022, status: "Proposed" as Policy["status"] }, 2022));
  assert(!belongsToElection({ electionId: 2024, status: "Campaign Pledge" as Policy["status"] }, 2026));
});

Deno.test("值得畫：至少兩位、至少一條政見；一個人或一條都沒有就不畫", () => {
  const one = compareMatrix([person("a", "甲")], [policy("1", "a", "交通建設")], 2026, []);
  assert(!worthComparing(one));
  const none = compareMatrix([person("a", "甲"), person("b", "乙")], [], 2026, []);
  assert(!worthComparing(none));
});

Deno.test("同一場的人才同一張表：縣市長一縣一場、立委一選區一場、鄉鎮首長一鄉鎮一場、沒選區的不硬湊", () => {
  const mayors = [person("a", "甲", { region: "台北市" }), person("b", "乙", { region: "台北市" })];
  assertEquals(gridCompareGroups(mayors, "縣市長").map((g) => g.people.length), [2]);
  assertEquals(gridCompareGroups(mayors, "縣市長")[0].label, "", "縣市長不用標選區");

  const legislators = [
    person("a", "甲", { region: "台中市", subRegion: "臺中市第02選區" }),
    person("b", "乙", { region: "台中市", subRegion: "臺中市第01選區" }),
    person("c", "丙", { region: "台中市", subRegion: "臺中市第01選區" }),
    person("d", "丁", { region: "台中市", subRegion: "大雅區" }), // 借來的假選區
    person("e", "戊", { region: "台中市" }),
  ];
  const lg = gridCompareGroups(legislators, "立法委員");
  assertEquals(lg.map((g) => g.label), ["臺中市第01選區", "臺中市第02選區"], "選區自然排序；假選區與沒選區的不並排");
  assertEquals(lg[0].people.map((p) => p.id), ["b", "c"]);

  const townshipHeads = [
    person("a", "甲", { region: "嘉義縣", subRegion: "大林鎮" }),
    person("b", "乙", { region: "嘉義縣", subRegion: "民雄鄉" }),
    person("c", "丙", { region: "嘉義縣", subRegion: "大林鎮" }),
  ];
  const th = gridCompareGroups(townshipHeads, "鄉鎮市長");
  assertEquals(th.map((g) => [g.label, g.people.length]), [["大林鎮", 2], ["民雄鄉", 1]]);
  const tickets = gridCompareGroups([
    person("a", "甲", { position: "總統" }), person("b", "乙", { position: "副總統" }),
    person("c", "丙", { position: "總統" }), person("d", "丁", { position: "副總統" }),
  ], "總統副總統");
  assertEquals(tickets.length, 1, "總統全國一場");
  assertEquals(tickets[0].people.map((p) => p.id), ["a", "c"], "一組搭檔一欄，副手不另佔一欄");
});
