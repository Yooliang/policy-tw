/**
 * 政黨一覽與各黨頁（#346）。守的是：
 *   1. 一覽只列有人的政黨、依名稱筆畫排（不依人數）；無黨籍不列；簡稱、異寫、臺／台都歸到同一黨
 *   2. 各黨頁：現職只來自任期（落選者不進現職），首長與民代分開；歷屆參選人每一屆、每一種職位，依職位與地區排、不依當選與否
 *   3. 鄉鎮層級的職位補上縣市；改名有前身／改名為；名冊外的政黨講查無
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { membersByParty, partyList, partyPage, placeLabel } from "./party-pages.ts";
import { buildPartyIndex, type PartyRegistry } from "./parties.ts";
import type { Election, Politician } from "../types.ts";

const seed: PartyRegistry = JSON.parse(await Deno.readTextFile(new URL("./party-seed.json", import.meta.url)));
const ELECTIONS: Election[] = [
  { id: 2022, name: "2022 地方公職人員選舉", shortName: "2022 地方", startDate: "", endDate: "", electionDate: "2022-11-26", types: [] },
  { id: 2026, name: "2026 地方公職人員選舉", shortName: "2026 地方", startDate: "", endDate: "", electionDate: "2026-11-28", types: [] },
];
const TODAY = "2026-10-06";
const P = (p: Partial<Politician> & { id: string; name: string; party: string }): Politician => ({ position: "", region: "", ...p }) as Politician;

const people: Politician[] = [
  P({ id: "1", name: "甲", party: "中國國民黨", offices: [{ electionId: 2022, electionType: "縣市長", region: "台中市" }],
    elections: [{ electionId: 2022, position: "", region: "台中市", electionType: "縣市長", candidacyStatus: "elected" }] }),
  P({ id: "2", name: "乙", party: "國民黨", elections: [{ electionId: 2022, position: "", region: "台中市", electionType: "縣市議員", candidacyStatus: "not_elected" }] }),
  P({ id: "3", name: "丙", party: "中國國民黨", offices: [{ electionId: 2022, electionType: "鄉鎮市長", region: "屏東縣", subRegion: "東港鎮" }],
    elections: [
      { electionId: 2022, position: "", region: "屏東縣", subRegion: "東港鎮", electionType: "鄉鎮市長", candidacyStatus: "elected" },
      { electionId: 2026, position: "", region: "屏東縣", electionType: "縣市長", candidacyStatus: "filed" },
    ] }),
  P({ id: "4", name: "丁", party: "中國國民黨", offices: [{ electionId: 2022, electionType: "縣市議員", region: "台中市" }],
    elections: [{ electionId: 2022, position: "", region: "台中市", electionType: "縣市議員", candidacyStatus: "elected" }] }),
  P({ id: "5", name: "戊", party: "無黨籍及未經政黨推薦", elections: [{ electionId: 2022, position: "", region: "台中市", electionType: "村里長" }] }),
  P({ id: "6", name: "己", party: "臺灣基進黨" }),
  P({ id: "7", name: "庚", party: "台灣團結聯盟" }),
  P({ id: "8", name: "辛", party: "中國國民黨", mergedInto: "1" }),
  P({ id: "9", name: "壬", party: "不存在的黨" }),
  // 名稱筆畫最少（人 2 畫）、人數最少：依名稱排在最前，依人數會排最後
  P({ id: "10", name: "子", party: "人民最大黨" }),
];

Deno.test("membersByParty：簡稱、異寫、臺／台歸同一黨；無黨籍、對不到的、已合併的不歸任何黨", () => {
  const m = membersByParty(people, buildPartyIndex(seed));
  assertEquals(m.get(1)!.map((p) => p.id), ["1", "2", "3", "4"]);
  assertEquals(m.get(303)!.map((p) => p.id), ["6"]);
  assertEquals([...m.values()].flat().some((p) => ["5", "8", "9"].includes(p.id)), false);
});

Deno.test("一覽：只列有人的政黨，依名稱筆畫排、不依人數；改名的舊名列出、指得到新名", () => {
  const list = partyList(people, seed);
  assertEquals(list.map((p) => p.name).sort(), ["人民最大黨", "中國國民黨", "台灣基進", "台灣團結聯盟"].sort());
  assertEquals(list[0].name, "人民最大黨", "人數最少、名稱筆畫最少的排第一");
  const collator = new Intl.Collator("zh-Hant-TW");
  assertEquals(list.map((p) => p.name), [...list.map((p) => p.name)].sort(collator.compare), "依名稱筆畫，不是依人數（國民黨 4 位不會排第一）");
  const tsu = list.find((p) => p.name === "台灣團結聯盟")!;
  assertEquals(tsu.moiNo, null);
  assertEquals(tsu.successor, { id: 95, name: "台聯黨" });
});

Deno.test("各黨頁：現職只來自任期、首長與民代分開；落選者不進現職；歷屆參選人每屆每種職位", () => {
  const page = partyPage(1, people, seed, ELECTIONS, TODAY)!;
  assertEquals(page.party.name, "中國國民黨");
  assertEquals(page.party.shortName, "國民黨");
  assertEquals(page.heads.map((g) => [g.label, g.people.map((p) => `${p.name}:${p.what}`)]), [
    ["縣市長", ["甲:台中市長"]],
    ["鄉鎮市長", ["丙:屏東縣東港鎮長"]],
  ]);
  assertEquals(page.councils.map((g) => [g.label, g.people.map((p) => p.name)]), [["縣市議員", ["丁"]]], "乙落選，不在現職");
  assertEquals(page.elections.map((e) => e.electionId), [2026, 2022], "新到舊，照投票日");
  const y2022 = page.elections.find((e) => e.electionId === 2022)!;
  assertEquals(y2022.groups.map((g) => g.label), ["縣市長", "縣市議員", "鄉鎮市長"], "照職位位階，不照人數");
  const council = y2022.groups.find((g) => g.label === "縣市議員")!;
  assertEquals(council.people.map((p) => `${p.name}:${p.status}`).sort(), ["乙:落選", "丁:當選"].sort());
  assertEquals(page.elections[0].groups[0].people[0], { id: "3", name: "丙", what: "屏東縣長", status: "已登記" });
  assertEquals(partyPage(303, people, seed, ELECTIONS, TODAY)!.elections, [], "沒有參選紀錄就是空的");
  assertEquals(partyPage(16, people, seed, ELECTIONS, TODAY), null, "沒有人的政黨沒有頁面");
  assertEquals(partyPage(999999, people, seed, ELECTIONS, TODAY), null);
  // 投完票、結果還沒補上的：講「結果待補」，不講登記階段的字
  const pending = partyPage(1, [P({ id: "x", name: "癸", party: "國民黨", elections: [{ electionId: 2022, position: "", region: "台中市", electionType: "村里長", subRegion: "北區", village: "賴村里", candidacyStatus: "filed" }] })], seed, ELECTIONS, TODAY)!;
  assertEquals(pending.elections[0].groups[0].people[0], { id: "x", name: "癸", what: "台中市北區賴村里長", status: "結果待補" });
});

Deno.test("placeLabel：鄉鎮層級補縣市，縣市層級不重複", () => {
  assertEquals(placeLabel({ electionType: "村里長", region: "高雄市", subRegion: "橋頭區", village: "新莊里" }), "高雄市橋頭區新莊里長");
  assertEquals(placeLabel({ electionType: "鄉鎮市民代表", region: "彰化縣", subRegion: "麥寮鄉" }), "彰化縣麥寮鄉民代表");
  assertEquals(placeLabel({ electionType: "縣市議員", region: "台中市" }), "台中市議員");
  assertEquals(placeLabel({ electionType: "立法委員", region: "全國" }), "不分區立委");
  assertEquals(placeLabel({ electionType: "縣市長", region: "全國" }), "縣市長", "地區還沒補的不組出「全國長」");
  assert(placeLabel({ electionType: "鄉鎮市長", region: "", subRegion: "東港鎮" }) === "東港鎮長", "沒有縣市就不補");
});
