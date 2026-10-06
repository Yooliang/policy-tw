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
  belongsToElection, buildPick, compareColumnOrder, compareMatrix, comparablePeople, hasPk, hasPolicies, parsePick, pickGroup, pkGroupLabel, pkGroups, pkNeeds, pkQuery,
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
  const people = [person("a", "甲", { candidacyStatus: "filed" }), person("b", "乙", { candidacyStatus: "withdrawn" }), person("c", "丙", { candidacyStatus: "withdrawn" })];
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
  assert(!hasPk({ label: "x", people: [person("a", "甲"), person("b", "乙", { candidacyStatus: "withdrawn" })] }), "退選的不算");
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

Deno.test("選舉頁真的把「政見 PK」按鈕掛在每個區塊標題列：卡片區塊與分組區塊、這一層與下一層各一處；切換鈕拿掉了", () => {
  const page = Deno.readTextFileSync(new URL("../pages/ElectionPage.vue", import.meta.url));
  const grid = Deno.readTextFileSync(new URL("../pages/election/PoliticianGrid.vue", import.meta.url));
  const chips = Deno.readTextFileSync(new URL("../pages/election/ChipFilteredGroups.vue", import.meta.url));
  // 屬性要真的落在元件標籤上（寫到 > 後面會變成被丟掉的文字，畫面上就沒有按鈕——2026-10-06 實際踩過）
  assertEquals(page.match(/<PoliticianGrid [^>]*:pk-link="sectionPkLink\(section\)"[^>]*>/g)?.length, 2);
  assertEquals(page.match(/<ChipFilteredGroups(?:\s+[^>\s]+)*\s+:pk-link-for="groupPkLinkFor\(section\.spec\.type\)"\s*>/g)?.length, 2);
  assert(/:pk-link="pkLinkFor\?\.\(group\)"/.test(chips));
  assert(/<RouterLink\s+v-if="pkLink"\s+:to="pkLink"/.test(grid), "按鈕是真連結");
  assert(!grid.includes("顯示方式") && !grid.includes("localStorage"), "大頭照／清單切換拿掉了");
});

Deno.test("PK 不進預渲染 HTML（不是正文，10-06 裁決）：頁籤用 v-if 掛；畫面上不放說明文字", () => {
  const page = Deno.readTextFileSync(new URL("../pages/ElectionPage.vue", import.meta.url));
  const pk = Deno.readTextFileSync(new URL("../pages/election/PolicyPk.vue", import.meta.url));
  const elements = Deno.readTextFileSync(new URL("../components/PolicyElements.vue", import.meta.url));
  // 預渲染時 viewMode 一律是候選人頁籤；改成 v-show 的話表格就會進 HTML
  assert(/<div v-if="viewMode === 'comparison'"[^>]*>\s*<!-- 職位/.test(page), "PK 頁籤要用 v-if");
  assertEquals(page.match(/<PolicyPk\b/g)?.length, 1);
  const template = (s: string) => s.slice(s.indexOf("<template>"));
  assert(!template(pk).includes("不排名"), "表格上方不放欄的順序說明");
  assert(!/還沒有人查過原文|查過原文，沒有寫/.test(template(elements)), "未說明／未調查只留標籤");
});

// ── PK 跟上方地區選擇連動（2026-10-06 維護者：縣市、鄉鎮、選區的選擇只有上方縣市選擇器與右側面板，PK 不另做一組）──

Deno.test("PK 缺什麼範圍：全台頁要先選縣市（總統副總統例外）；縣市頁的鄉鎮首長、代表、村里長要先在右側選鄉鎮市區", () => {
  assertEquals(pkNeeds("總統副總統", "All", "All"), null, "全國一場");
  for (const t of ["縣市長", "縣市議員", "立法委員", "鄉鎮市長", "村里長"]) assertEquals(pkNeeds(t, "All", "All"), "county", `${t} 全台頁要先選縣市`);
  for (const t of ["縣市長", "縣市議員", "立法委員"]) assertEquals(pkNeeds(t, "台北市", "All"), null, `${t} 縣市頁夠了（選區在右側面板選）`);
  for (const t of ["鄉鎮市長", "鄉鎮市民代表", "直轄市山地原住民區長", "直轄市山地原住民區民代表", "村里長"]) {
    assertEquals(pkNeeds(t, "嘉義縣", "All"), "township", `${t} 縣市頁要先選鄉鎮市區`);
    assertEquals(pkNeeds(t, "嘉義縣", "大林鎮"), null, `${t} 鄉鎮頁夠了`);
  }
  assertEquals(pkNeeds("縣市長", "台北市", "大安區"), null);
});

Deno.test("不先擋掉的話，全台的縣市長池子會分成每縣市一組、縣市頁的鄉鎮市長池子會分成每鄉鎮一組——那就是不該畫成第二排按鈕的東西", () => {
  const mayors = [person("a", "甲", { region: "台北市" }), person("b", "乙", { region: "台中市" })];
  assertEquals(pkGroups(mayors, "縣市長").map((g) => g.label).length, 2);
  const townMayors = [person("c", "丙", { region: "嘉義縣", subRegion: "大林鎮" }), person("d", "丁", { region: "嘉義縣", subRegion: "民雄鄉" })];
  assertEquals(pkGroups(townMayors, "鄉鎮市長").map((g) => g.label).length, 2);
  assertEquals(pkNeeds("縣市長", "All", "All"), "county");
  assertEquals(pkNeeds("鄉鎮市長", "嘉義縣", "All"), "township");
});

Deno.test("選舉頁沒有自己的地區選擇：PK 本體不收選區、不畫選區列；範圍不夠就提示；選區放右側面板；右側面板不分頁籤", () => {
  const page = Deno.readTextFileSync(new URL("../pages/ElectionPage.vue", import.meta.url));
  const pk = Deno.readTextFileSync(new URL("../pages/election/PolicyPk.vue", import.meta.url));
  // PK 本體：屬性只有標題、候選人、勾選、表；沒有縣市／鄉鎮／選區，也不畫選區列
  const props = pk.slice(pk.indexOf("defineProps"), pk.indexOf("defineEmits"));
  assert(!/regions?\??:|counties|townships?\??:|subRegions?\??:|districts\??:/.test(props), "PolicyPk 的屬性裡沒有縣市／鄉鎮／選區");
  assert(!pk.includes('aria-label="選區"'), "PK 主欄沒有選區列");
  // 範圍不夠：提示在 PolicyPk 之前，PolicyPk 用 v-else
  assert(/v-if="pkMissing"[^>]*data-testid="pk-pick-region"[\s\S]*?先在上方選擇縣市[\s\S]*?先在右側選擇鄉鎮市區[\s\S]*?<PolicyPk\s+v-else/.test(page), "提示先選縣市／鄉鎮市區，取代 PK 本體");
  assertEquals(page.match(/pkNeeds\(/g)?.length, 5, "區塊按鈕兩處（卡片與分組）、頁籤的範圍檢查、職位預設、職位列各看一次");
  assert(/const pkGroupList = computed\(\(\) => pkMissing\.value \? \[\]/.test(page), "範圍不夠時沒有選區");
  // 選區在右側面板（真連結），村里長的村里在 PK 頁籤只出現一份
  assert(/<div v-if="pkDistrictPanel"[^>]*data-testid="pk-district-panel"/.test(page));
  assert(/v-if="availableVillages\.length > 0 && viewMode !== 'comparison'"/.test(page), "PK 頁籤的村里選擇只有 PK 的那一份");
  // 全台頁的職位列：有全國一場的職位就只列它（區域立委不列，舊網址 type=立法委員 退回第一個職位）
  assert(/const national = levels\.filter\(l => !pkNeeds\(l\.type[^)]*\)\)\s*return selectedRegion\.value === 'All' && national\.length > 0 \? national : levels/.test(page), "全台頁的職位列只列全國性職位");
  // 右側子地區面板的條件只看縣市與有沒有鄉鎮，不看頁籤；左欄可以縮（表很寬時不把右欄擠出畫面）
  assert(/<div v-if="selectedRegion !== 'All' && availableSubRegions\.length > 0" class="order-first md:order-last md:w-1\/3 shrink-0">/.test(page), "子地區面板不分頁籤都在");
  assert(/'flex-1 min-w-0 md:w-2\/3'/.test(page), "左欄 min-w-0");
  // 桌機捲動時右側面板停在頁首（Navbar h-16＝4rem）下方，不被蓋住；手機版面板在上方、不 sticky
  assert(/<div class="md:sticky md:top-\[4\.5rem\] space-y-4">/.test(page), "右側面板 sticky 距頂 4.5rem");
});
