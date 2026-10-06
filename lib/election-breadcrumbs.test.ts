/**
 * 人物頁、政見頁麵包屑的守門：
 *   1. 三種層級（縣市長、議員、里長）× 未投票／已投票，文字與連結都對
 *   2. 職位層連到的錨點，必須是選舉頁畫區塊時掛的那個 id——連到不存在的 id 瀏覽器只會安靜地不捲動，沒有任何錯誤，
 *      所以這裡用「選舉頁自己的分組函式算出來的 id」去對，並讀 ElectionPage.vue 的原始碼確認 id 真的有掛上去
 *   3. 鄉鎮頁網址只從 electionTownshipPath 來（另一個 PR 要把 ?sub= 改成路徑，這裡不寫死網址長相）
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  candidacyCrumbs,
  candidacyWord,
  pkLinkFor,
  taiwanDate,
  type CrumbElection,
  type CrumbRecord,
} from "./election-breadcrumbs.ts";
import { POSITIONS, sectionAnchor } from "./election-levels.ts";
import { electionRegionPath, electionTownshipPath } from "./election-regions.ts";
import { groupByDistrict } from "./district-grouping.ts";
import { groupByVillage } from "./village-grouping.ts";
import { pkGroups } from "./policy-compare.ts";

const E2026: CrumbElection = { name: "2026 九合一地方公職人員選舉", shortName: "2026 九合一", electionDate: "2026-11-28" };
const E2022: CrumbElection = { name: "111年地方公職人員選舉", shortName: "2022 九合一", electionDate: "2022-11-26" };
const E2024: CrumbElection = { name: "113年總統副總統及立法委員選舉", shortName: "2024 大選", electionDate: "2024-01-13" };
/** 2026-10-05 12:00（台灣）：2026 九合一還沒投票，2022 與 2024 已投票 */
const NOW = new Date("2026-10-05T04:00:00Z");

const enc = encodeURIComponent;

// ── 縣市長 ──

Deno.test("縣市長（未投票）：年 › 縣市 › 縣市長候選人 › 連到縣市頁的 #縣市長", () => {
  const rec: CrumbRecord = { electionId: 2026, electionType: "縣市長", region: "金門縣" };
  assertEquals(candidacyCrumbs(rec, E2026, NOW), [
    { name: "2026 九合一", path: "/election/2026" },
    { name: "金門縣", path: `/election/2026/${enc("金門縣")}` },
    { name: "縣市長候選人", path: `/election/2026/${enc("金門縣")}#${enc("縣市長")}` },
  ]);
});

Deno.test("縣市長（已投票）：寫參選人，不寫候選人", () => {
  const rec: CrumbRecord = { electionId: 2022, electionType: "縣市長", region: "宜蘭縣" };
  const crumbs = candidacyCrumbs(rec, E2022, NOW);
  assertEquals(crumbs.map((c) => c.name), ["2022 九合一", "宜蘭縣", "縣市長參選人"]);
});

Deno.test("縣市長：連結是完整的百分比編碼字面值（釘住長相，不靠實作自己產生的字串）", () => {
  const crumbs = candidacyCrumbs({ electionId: 2026, electionType: "縣市長", region: "金門縣" }, E2026, NOW);
  assertEquals(crumbs[2].path, "/election/2026/%E9%87%91%E9%96%80%E7%B8%A3#%E7%B8%A3%E5%B8%82%E9%95%B7");
});

// ── 議員 ──

Deno.test("縣市議員（未投票）：帶選舉區，連到該選區那一組", () => {
  const rec: CrumbRecord = { electionId: 2026, electionType: "縣市議員", region: "金門縣", subRegion: "第01選舉區" };
  assertEquals(candidacyCrumbs(rec, E2026, NOW), [
    { name: "2026 九合一", path: "/election/2026" },
    { name: "金門縣", path: `/election/2026/${enc("金門縣")}` },
    { name: "縣市議員候選人（第01選舉區）", path: `/election/2026/${enc("金門縣")}#${enc("縣市議員-第01選舉區")}` },
  ]);
});

Deno.test("縣市議員（已投票）：參選人，同樣帶選舉區", () => {
  const rec: CrumbRecord = { electionId: 2022, electionType: "縣市議員", region: "台北市", subRegion: "第04選舉區" };
  assertEquals(candidacyCrumbs(rec, E2022, NOW).at(-1)?.name, "縣市議員參選人（第04選舉區）");
});

Deno.test("縣市議員沒填選舉區：不帶括號，連到整個議員區塊（#縣市議員）", () => {
  const rec: CrumbRecord = { electionId: 2022, electionType: "縣市議員", region: "新北市" };
  const last = candidacyCrumbs(rec, E2022, NOW).at(-1);
  assertEquals(last?.name, "縣市議員參選人");
  assertEquals(last?.path, `/election/2022/${enc("新北市")}#${enc("縣市議員")}`);
});

// 2026-10-05：「台北市第03選區」是立委選區的寫法，議員紀錄帶著它是借到了人物 2024 參選立委的地區（張烱春、李政憲）。
// 選舉頁把這種人收進「選區待補」，麵包屑也不寫出假選區、連到整個議員區塊
Deno.test("議員帶著不是議員選區的字串（立委選區、鄉鎮名）：當成沒填，不帶括號，連到 #縣市議員", () => {
  for (const sub of ["台北市第03選區", "大雅區"]) {
    const rec: CrumbRecord = { electionId: 2026, electionType: "縣市議員", region: "台北市", subRegion: sub };
    const last = candidacyCrumbs(rec, E2026, NOW).at(-1);
    assertEquals(last?.name, "縣市議員候選人", sub);
    assertEquals(last?.path, `/election/2026/${enc("台北市")}#${enc("縣市議員")}`);
  }
});

Deno.test("立法委員（縣市層、卡片排法）：不帶選區，連到 #立法委員", () => {
  const rec: CrumbRecord = { electionId: 2024, electionType: "立法委員", region: "台南市", subRegion: "第02選舉區" };
  assertEquals(candidacyCrumbs(rec, E2024, NOW).slice(1), [
    { name: "台南市", path: `/election/2024/${enc("台南市")}` },
    { name: "立法委員參選人", path: `/election/2024/${enc("台南市")}#${enc("立法委員")}` },
  ]);
});

// ── 里長與鄉鎮層 ──

Deno.test("村里長（已投票）：多一層鄉鎮，職位帶里名，連到鄉鎮頁的那個里", () => {
  const rec: CrumbRecord = { electionId: 2022, electionType: "村里長", region: "金門縣", subRegion: "金城鎮", village: "東門里" };
  const township = electionTownshipPath(2022, "金門縣", "金城鎮");
  assertEquals(candidacyCrumbs(rec, E2022, NOW), [
    { name: "2022 九合一", path: "/election/2022" },
    { name: "金門縣", path: `/election/2022/${enc("金門縣")}` },
    { name: "金城鎮", path: township },
    { name: "村里長參選人（東門里）", path: `${township}#${enc("村里長-東門里")}` },
  ]);
});

Deno.test("村里長（未投票）：候選人", () => {
  const rec: CrumbRecord = { electionId: 2026, electionType: "村里長", region: "台北市", subRegion: "松山區", village: "松基里" };
  assertEquals(candidacyCrumbs(rec, E2026, NOW).at(-1)?.name, "村里長候選人（松基里）");
});

Deno.test("鄉鎮市長：年 › 縣市 › 鄉鎮 › 鄉鎮市長候選人，連到鄉鎮頁的 #鄉鎮市長", () => {
  const rec: CrumbRecord = { electionId: 2026, electionType: "鄉鎮市長", region: "金門縣", subRegion: "金沙鎮" };
  const township = electionTownshipPath(2026, "金門縣", "金沙鎮");
  assertEquals(candidacyCrumbs(rec, E2026, NOW), [
    { name: "2026 九合一", path: "/election/2026" },
    { name: "金門縣", path: `/election/2026/${enc("金門縣")}` },
    { name: "金沙鎮", path: township },
    { name: "鄉鎮市長候選人", path: `${township}#${enc("鄉鎮市長")}` },
  ]);
});

Deno.test("鄉鎮市民代表：同樣在鄉鎮之下", () => {
  const rec: CrumbRecord = { electionId: 2026, electionType: "鄉鎮市民代表", region: "嘉義縣", subRegion: "大林鎮" };
  const crumbs = candidacyCrumbs(rec, E2026, NOW);
  assertEquals(crumbs.map((c) => c.name), ["2026 九合一", "嘉義縣", "大林鎮", "鄉鎮市民代表候選人"]);
});

Deno.test("原住民區代表：鄉鎮取「那瑪夏區」，括號只留選舉區，錨點用完整選區字串", () => {
  const rec: CrumbRecord = { electionId: 2022, electionType: "直轄市山地原住民區民代表", region: "高雄市", subRegion: "那瑪夏區第02選舉區" };
  const township = electionTownshipPath(2022, "高雄市", "那瑪夏區");
  assertEquals(candidacyCrumbs(rec, E2022, NOW).slice(2), [
    { name: "那瑪夏區", path: township },
    { name: "原住民區代表參選人（第02選舉區）", path: `${township}#${enc("原住民區代表-那瑪夏區第02選舉區")}` },
  ]);
});

Deno.test("原住民區長：多一層區，不帶選區", () => {
  const rec: CrumbRecord = { electionId: 2022, electionType: "直轄市山地原住民區長", region: "高雄市", subRegion: "桃源區" };
  assertEquals(candidacyCrumbs(rec, E2022, NOW).map((c) => c.name), ["2022 九合一", "高雄市", "桃源區", "原住民區長參選人"]);
});

Deno.test("鄉鎮頁網址只從 electionTownshipPath 來：麵包屑的鄉鎮層就是它的輸出", () => {
  const rec: CrumbRecord = { electionId: 2022, electionType: "村里長", region: "金門縣", subRegion: "金城鎮", village: "東門里" };
  assertEquals(candidacyCrumbs(rec, E2022, NOW)[2].path, electionTownshipPath(2022, "金門縣", "金城鎮"));
});

// ── 缺資料時的退路 ──

Deno.test("里長缺鄉鎮：沒有鄉鎮層，職位層退到縣市頁、不帶找不到的錨點", () => {
  const rec: CrumbRecord = { electionId: 2022, electionType: "村里長", region: "金門縣", village: "東門里" };
  assertEquals(candidacyCrumbs(rec, E2022, NOW).slice(1), [
    { name: "金門縣", path: `/election/2022/${enc("金門縣")}` },
    { name: "村里長參選人（東門里）", path: `/election/2022/${enc("金門縣")}` },
  ]);
});

Deno.test("里長缺里名：不帶括號，連到整個村里長區塊（#村里長）", () => {
  const rec: CrumbRecord = { electionId: 2022, electionType: "村里長", region: "金門縣", subRegion: "金城鎮" };
  const last = candidacyCrumbs(rec, E2022, NOW).at(-1);
  assertEquals(last?.name, "村里長參選人");
  assertStringIncludes(last?.path ?? "", `#${enc("村里長")}`);
});

Deno.test("不分區立委（地區是全國）：沒有縣市層，職位層連到年頁、不帶錨點", () => {
  const rec: CrumbRecord = { electionId: 2024, electionType: "立法委員", region: "全國" };
  assertEquals(candidacyCrumbs(rec, E2024, NOW), [
    { name: "2024 大選", path: "/election/2024" },
    { name: "立法委員參選人", path: "/election/2024" },
  ]);
});

Deno.test("總統副總統：全台頁的 #總統副總統", () => {
  const rec: CrumbRecord = { electionId: 2024, electionType: "總統副總統", region: "全國" };
  assertEquals(candidacyCrumbs(rec, E2024, NOW).at(-1), {
    name: "總統副總統參選人",
    path: `/election/2024#${enc("總統副總統")}`,
  });
});

Deno.test("沒有選舉別的舊資料：不知道是什麼職位就不編，只到縣市（跟加職位層之前一樣）", () => {
  const rec: CrumbRecord = { electionId: 2022, region: "金門縣" };
  assertEquals(candidacyCrumbs(rec, E2022, NOW).map((c) => c.name), ["2022 九合一", "金門縣"]);
});

Deno.test("找不到那一屆選舉：年那層退回「選舉 2026」，用中性的參選人", () => {
  const rec: CrumbRecord = { electionId: 2026, electionType: "縣市長", region: "金門縣" };
  assertEquals(candidacyCrumbs(rec, undefined, NOW).map((c) => c.name), ["選舉 2026", "金門縣", "縣市長參選人"]);
});

Deno.test("年那層優先用簡稱，沒有簡稱才用全名", () => {
  const rec: CrumbRecord = { electionId: 2026, electionType: "縣市長", region: "金門縣" };
  assertEquals(candidacyCrumbs(rec, { name: "全名", electionDate: "2026-11-28" }, NOW)[0].name, "全名");
});

// ── 候選人／參選人的界線 ──

Deno.test("投票日當天仍是候選人，隔天（台灣時間）起才是參選人", () => {
  assertEquals(candidacyWord("2026-11-28", new Date("2026-11-28T15:30:00Z")), "候選人"); // 台灣 11-28 23:30
  assertEquals(candidacyWord("2026-11-28", new Date("2026-11-28T16:30:00Z")), "參選人"); // 台灣 11-29 00:30
  assertEquals(candidacyWord("2026-11-28", new Date("2026-10-05T04:00:00Z")), "候選人");
});

Deno.test("台灣日期用 UTC+8 算：UTC 還在前一天的下午，台灣已經是隔天", () => {
  assertEquals(taiwanDate(new Date("2026-11-28T16:00:00Z")), "2026-11-29");
  assertEquals(taiwanDate(new Date("2026-11-28T15:59:59Z")), "2026-11-28");
});

Deno.test("沒有投票日：用參選人（不論投過沒有都說得通）；投票日帶時間也認得", () => {
  assertEquals(candidacyWord(undefined, NOW), "參選人");
  assertEquals(candidacyWord("2026-11-28T00:00:00+00:00", NOW), "候選人");
});

// ── 錨點與選舉頁的 id 對得上 ──

Deno.test("錨點只有一個來源 sectionAnchor：職位名稱取自 POSITIONS，每個職位的 id 不重複、沒有空白", () => {
  const ids = POSITIONS.map((p) => sectionAnchor(p.type));
  assertEquals(new Set(ids).size, POSITIONS.length);
  for (const id of ids) assert(id && !/\s/.test(id), `id 不能是空的或帶空白：${id}`);
  assertEquals(sectionAnchor("縣市長"), "縣市長");
  assertEquals(sectionAnchor("縣市議員", "第01選舉區"), "縣市議員-第01選舉區");
  assertEquals(sectionAnchor("不存在的職位"), undefined);
});

function anchorOf(crumbs: { path?: string }[]): string {
  const path = crumbs.at(-1)?.path ?? "";
  return decodeURIComponent(path.slice(path.indexOf("#") + 1));
}

Deno.test("議員：麵包屑的錨點＝選舉頁分組函式（groupByDistrict）算出來那一組的 id", () => {
  const rec: CrumbRecord = { electionId: 2026, electionType: "縣市議員", region: "金門縣", subRegion: "第02選舉區" };
  // 選舉頁把議員交給 groupByDistrict，再用 sectionAnchor(type, 組名) 當那一組的 id
  const groups = groupByDistrict([{ subRegion: "第01選舉區" }, { subRegion: "第02選舉區" }], "縣市議員");
  const pageIds = groups.map((g) => sectionAnchor("縣市議員", g.district));
  assert(pageIds.includes(anchorOf(candidacyCrumbs(rec, E2026, NOW))));
});

Deno.test("里長：麵包屑的錨點＝選舉頁分組函式（groupByVillage）算出來那一組的 id", () => {
  const rec: CrumbRecord = { electionId: 2022, electionType: "村里長", region: "金門縣", subRegion: "金城鎮", village: "西門里" };
  const known = ["東門里", "西門里"];
  const groups = groupByVillage([{ village: "東門里" }, { village: "西門里" }], known);
  const pageIds = groups.map((g) => sectionAnchor("村里長", g.village));
  assert(pageIds.includes(anchorOf(candidacyCrumbs(rec, E2022, NOW))));
});

Deno.test("每個職位都有一個連得到的錨點：沒有分組可帶時連整個職位區塊的 id，有分組時連那一組的 id", () => {
  // [紀錄, 期待的組名]：沒有組名＝整個職位區塊。區代表的鄉鎮取自選區字串，所以一定有組名（選區，跟選舉頁分組一致）
  const samples: Array<[CrumbRecord, string | undefined]> = [
    [{ electionId: 2024, electionType: "總統副總統", region: "全國" }, undefined],
    [{ electionId: 2026, electionType: "縣市長", region: "金門縣" }, undefined],
    [{ electionId: 2026, electionType: "縣市議員", region: "金門縣" }, undefined],
    [{ electionId: 2024, electionType: "立法委員", region: "台南市" }, undefined],
    [{ electionId: 2026, electionType: "鄉鎮市長", region: "金門縣", subRegion: "金沙鎮" }, undefined],
    [{ electionId: 2026, electionType: "鄉鎮市民代表", region: "金門縣", subRegion: "金沙鎮" }, undefined],
    [{ electionId: 2022, electionType: "直轄市山地原住民區長", region: "高雄市", subRegion: "桃源區" }, undefined],
    [{ electionId: 2022, electionType: "直轄市山地原住民區民代表", region: "高雄市", subRegion: "桃源區第01選舉區" }, "桃源區第01選舉區"],
    [{ electionId: 2022, electionType: "村里長", region: "金門縣", subRegion: "金城鎮" }, undefined],
  ];
  // 樣本要涵蓋 POSITIONS 的每一個職位：加了新職位卻沒補樣本，這裡會紅，提醒要確認麵包屑與選舉頁的錨點
  assertEquals(new Set(samples.map(([r]) => r.electionType)), new Set(POSITIONS.map((p) => p.type)));
  for (const [rec, group] of samples) {
    assertEquals(anchorOf(candidacyCrumbs(rec, E2022, NOW)), sectionAnchor(rec.electionType!, group), rec.electionType);
  }
});

Deno.test("選舉頁真的把 id 掛在區塊上（不然麵包屑連到的錨點不存在、瀏覽器靜靜地不捲動）", () => {
  const page = Deno.readTextFileSync(new URL("../pages/ElectionPage.vue", import.meta.url));
  const chips = Deno.readTextFileSync(new URL("../pages/election/ChipFilteredGroups.vue", import.meta.url));
  // 這一層與下一層各一組模板，每組有卡片與分組兩種區塊，共四處
  assertEquals(page.split(':id="section.anchor"').length - 1, 4);
  assertStringIncludes(page, "sectionAnchor(spec.type)");
  assertStringIncludes(page, "sectionAnchor(spec.type, g.label)");
  assertStringIncludes(chips, ':id="group.anchor"');
  // 麵包屑的連結用到的縣市頁網址，跟選舉頁的縣市頁是同一個函式
  assertEquals(electionRegionPath(2026, "金門縣"), `/election/2026/${enc("金門縣")}`);
});

// ── 政見頁的「政見 PK」連結（2026-10-06）──

Deno.test("政見 PK 連結：議員到縣市頁的 PK 頁籤，帶職位與選舉區；組名就是 PK 分組算出來的那一組", () => {
  const rec: CrumbRecord = { electionId: 2026, electionType: "縣市議員", region: "台北市", subRegion: "第08選舉區" };
  const link = pkLinkFor(rec, E2026, NOW);
  assertEquals(link?.path, `/election/2026/${enc("台北市")}`, "去掉頁內錨點，PK 是頁籤不是區塊");
  assertEquals(link?.query, { view: "comparison", type: "縣市議員", district: "第08選舉區" });
  assertEquals(pkGroups([{ id: 1, name: "甲", ...rec }], "縣市議員")[0].label, link?.query.district);
});

Deno.test("政見 PK 連結：縣市長 district＝縣市；村里長到鄉鎮頁、district＝里", () => {
  assertEquals(pkLinkFor({ electionId: 2026, electionType: "縣市長", region: "金門縣" }, E2026, NOW)?.query, { view: "comparison", type: "縣市長", district: "金門縣" });
  const chief = pkLinkFor({ electionId: 2022, electionType: "村里長", region: "金門縣", subRegion: "金城鎮", village: "東門里" }, E2022, NOW);
  assertEquals(chief?.path, electionTownshipPath(2022, "金門縣", "金城鎮"));
  assertEquals(chief?.query, { view: "comparison", type: "村里長", district: "東門里" });
});

Deno.test("政見 PK 連結：不知道是哪一場（選區待補）、目標頁定不出來（里長缺鄉鎮）就不給", () => {
  assertEquals(pkLinkFor({ electionId: 2026, electionType: "縣市議員", region: "台北市", subRegion: "大安區" }, E2026, NOW), null);
  assertEquals(pkLinkFor({ electionId: 2022, electionType: "村里長", region: "金門縣", village: "東門里" }, E2022, NOW), null);
  assertEquals(pkLinkFor({ electionId: 2026, region: "金門縣" }, E2026, NOW), null);
});
