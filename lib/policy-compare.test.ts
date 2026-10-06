/**
 * 政見 PK：同職位、同選區參選人的政見並排比較（#364，2026-10-05；10-06 併進「政見 PK」頁籤、改成多人）。
 *
 * 守的是「只並排、不排名」：欄的順序只看號次、沒有號次看姓名筆畫，不看政見數或其他；
 * 同一場的人才放在同一張表（縣市長一縣一場、議員與立委一選區一場、鄉鎮首長一鄉鎮一場、村里長一里一場，沒選區的不硬湊）；
 * 退選與不參選的人不上表；任內施政承諾不是這場選舉的政見；
 * PK 的網址參數：舊的 view／type 照舊、新的 district／pick 預設值不寫、對不上就退回全部。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  belongsToElection, buildPick, compareColumnOrder, compareMatrix, comparablePeople, hasPk, hasPolicies, parsePick, pickGroup, pkGroupLabel, pkGroups, pkQuery,
  type ComparePerson,
} from "./policy-compare.ts";
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
});

Deno.test("多人：三位以上照樣一人一欄，欄數就是勾選的人數", () => {
  const people = ["甲", "乙", "丙", "丁", "戊"].map((n, i) => person(String(i + 1), n, { candNo: 5 - i }));
  const m = compareMatrix(people, [policy("1", "3", "交通建設")], 2026, []);
  assertEquals(m.columns.map((c) => c.id), ["5", "4", "3", "2", "1"], "照號次");
  assertEquals(m.rows[0].cells.map((c) => c.length), [0, 0, 1, 0, 0]);
});

Deno.test("只放這一場選舉的政見：別屆的、任內施政承諾（Proposed）不放；推動中、已實現的照放", () => {
  assert(belongsToElection({ electionId: 2022, status: "In Progress" as Policy["status"] }, 2022));
  assert(belongsToElection({ electionId: 2022, status: "Achieved" as Policy["status"] }, 2022));
  assert(!belongsToElection({ electionId: 2022, status: "Proposed" as Policy["status"] }, 2022));
  assert(!belongsToElection({ electionId: 2024, status: "Campaign Pledge" as Policy["status"] }, 2026));
});

Deno.test("同一場的人才同一組：縣市長一縣一場、立委一選區一場、鄉鎮首長一鄉鎮一場、沒選區的不硬湊", () => {
  const mayors = [person("a", "甲", { region: "台北市" }), person("b", "乙", { region: "台北市" }), person("c", "丙", { region: "嘉義縣" })];
  assertEquals(pkGroups(mayors, "縣市長").map((g) => [g.label, g.people.length]), [["台北市", 2], ["嘉義縣", 1]], "組名＝縣市，照地名排");

  const legislators = [
    person("a", "甲", { region: "台中市", subRegion: "臺中市第02選區" }),
    person("b", "乙", { region: "台中市", subRegion: "臺中市第01選區" }),
    person("c", "丙", { region: "台中市", subRegion: "臺中市第01選區" }),
    person("d", "丁", { region: "台中市", subRegion: "大雅區" }), // 借來的假選區
    person("e", "戊", { region: "台中市" }),
  ];
  const lg = pkGroups(legislators, "立法委員");
  assertEquals(lg.map((g) => g.label), ["臺中市第01選區", "臺中市第02選區"], "選區自然排序；假選區與沒選區的不並排");
  assertEquals(lg[0].people.map((p) => p.id), ["b", "c"]);

  const townshipHeads = [
    person("a", "甲", { region: "嘉義縣", subRegion: "大林鎮" }),
    person("b", "乙", { region: "嘉義縣", subRegion: "民雄鄉" }),
    person("c", "丙", { region: "嘉義縣", subRegion: "大林鎮" }),
  ];
  assertEquals(pkGroups(townshipHeads, "鄉鎮市長").map((g) => [g.label, g.people.length]), [["大林鎮", 2], ["民雄鄉", 1]]);

  const tickets = pkGroups([
    person("a", "甲", { position: "總統" }), person("b", "乙", { position: "副總統" }),
    person("c", "丙", { position: "總統" }), person("d", "丁", { position: "副總統" }),
  ], "總統副總統");
  assertEquals(tickets.length, 1, "總統全國一場");
  assertEquals(tickets[0].people.map((p) => p.id), ["a", "c"], "一組搭檔一欄，副手不另佔一欄");
});

Deno.test("議員一選舉區一組：組名跟選舉頁分組標題同一個（第08選舉區），選區待補的不並排；選區照自然排序", () => {
  const councilors = [
    person("a", "甲", { subRegion: "第10選舉區" }),
    person("b", "乙", { subRegion: "第08選舉區" }),
    person("c", "丙", { subRegion: "第08選舉區" }),
    person("d", "丁", { subRegion: "大雅區" }),
    person("e", "戊"),
  ];
  const groups = pkGroups(councilors, "縣市議員");
  assertEquals(groups.map((g) => g.label), ["第08選舉區", "第10選舉區"]);
  assertEquals(pkGroupLabel(councilors[3], "縣市議員"), undefined, "假選區不知道是哪一場");
  assertEquals(pkGroupLabel(councilors[4], "縣市議員"), undefined);
});

Deno.test("組的順序：地名先字數再筆畫（跟選舉頁的鄉鎮、村里排法同一套），不是照字碼", () => {
  const heads = ["阿里山鄉", "番路鄉", "竹崎鄉"].map((t, i) => person(String(i), "某", { subRegion: t }));
  assertEquals(pkGroups(heads, "鄉鎮市長").map((g) => g.label), ["竹崎鄉", "番路鄉", "阿里山鄉"], "竹 6 畫在番 12 畫前面；四個字的排最後");
});

Deno.test("村里長一里一組", () => {
  const chiefs = [person("a", "甲", { village: "東門里" }), person("b", "乙", { village: "東門里" }), person("c", "丙", { village: " " })];
  assertEquals(pkGroups(chiefs, "村里長").map((g) => [g.label, g.people.length]), [["東門里", 2]]);
});

Deno.test("PK 按鈕：至少兩位會出現在選票上的人才給", () => {
  assert(hasPk({ label: "x", people: [person("a", "甲"), person("b", "乙")] }));
  assert(!hasPk({ label: "x", people: [person("a", "甲"), person("b", "乙", { candidateStatus: "withdrawn" })] }), "退選的不算");
  assert(!hasPk(undefined));
});

Deno.test("網址的組名對不上（別頁的、還沒載入的）就退回第一個有政見的組，都沒有就第一組", () => {
  const a = person("a", "甲"), b = person("b", "乙"), c = person("c", "丙");
  const groups = [{ label: "第01選舉區", people: [a] }, { label: "第02選舉區", people: [b] }, { label: "第03選舉區", people: [c] }];
  const withPolicies = (g: { people: ComparePerson[] }) => hasPolicies(g.people, [policy("1", "c", "交通建設")], 2026);
  assertEquals(pickGroup(groups, "第02選舉區", withPolicies)?.label, "第02選舉區", "網址選的優先，有沒有政見都一樣");
  assertEquals(pickGroup(groups, "第99選舉區", withPolicies)?.label, "第03選舉區");
  assertEquals(pickGroup(groups, "", withPolicies)?.label, "第03選舉區");
  assertEquals(pickGroup(groups, "", () => false)?.label, "第01選舉區");
  assertEquals(pickGroup(groups, "")?.label, "第01選舉區");
  assertEquals(pickGroup([], "第01選舉區"), undefined);
});

Deno.test("有沒有這一場的政見：別屆的、任內施政承諾不算", () => {
  const people = [person("a", "甲")];
  assert(hasPolicies(people, [policy("1", "a", "交通建設")], 2026));
  assert(!hasPolicies(people, [policy("1", "a", "交通建設", { electionId: 2022 })], 2026));
  assert(!hasPolicies(people, [policy("1", "a", "交通建設", { status: "Proposed" as Policy["status"] })], 2026));
  assert(!hasPolicies(people, [policy("1", "z", "交通建設")], 2026));
});

Deno.test("PK 網址：view=comparison 照舊；職位一律寫明（沒帶 type 是自動選）；組名寫在 district", () => {
  assertEquals(pkQuery("縣市議員", "第08選舉區"), { view: "comparison", type: "縣市議員", district: "第08選舉區" });
  assertEquals(pkQuery("縣市長"), { view: "comparison", type: "縣市長" });
  assertEquals(pkQuery("縣市長", "台北市"), { view: "comparison", type: "縣市長", district: "台北市" });
});

Deno.test("pick：全部勾選不寫（預設），勾掉幾位才寫；對不上的 id 丟掉，一個都對不上＝全部", () => {
  const ids = ["5", "3", "9"];
  assertEquals(buildPick(new Set(ids), ids), "");
  assertEquals(buildPick(new Set(["9", "5"]), ids), "5,9", "照欄的順序");
  assertEquals(buildPick(new Set(), ids), "", "一個都沒勾＝全部");
  assertEquals(parsePick("", ids), ids);
  assertEquals(parsePick("9,5", ids), ["5", "9"]);
  assertEquals(parsePick("9,777", ids), ["9"], "別組的人丟掉");
  assertEquals(parsePick("777", ids), ids, "全對不上＝全部，不是空表");
});
