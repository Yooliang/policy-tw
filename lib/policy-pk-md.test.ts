/**
 * PK 詳情（2026-10-20 回報：標題「第01選舉區：並排比較 8 位」，詳情卻列出全台南市的議員）。
 * 守的是：詳情的內容就是標題那張比較表（同一個 CompareMatrix），不會多出表外的人；選區寫法不同（第1／第01）視為同一區。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { compareMatrix, districtKey, inSubRegionScope, pkGroups, sameDistrict, type ComparePerson } from "./policy-compare.ts";
import { buildPkMdPage, renderPkMd, type PkMdPerson } from "./policy-pk-md.ts";
import type { Policy } from "../types.ts";

const person = (id: string, name: string, over: Partial<PkMdPerson> = {}): PkMdPerson => ({ id, name, electionType: "縣市議員", region: "台南市", ...over });
function policy(id: string, politicianId: string, category: string): Policy {
  return {
    id, politicianId, electionId: 2026, title: `政見${id}`, description: "", category, status: "Campaign Pledge" as Policy["status"],
    proposedDate: null, lastUpdated: "2026-09-01", progress: 0, tags: [], logs: [], stanceSupport: 0, stanceOppose: 0, stancePriority: 0,
  };
}

// 台南市議員：第01選舉區 8 位（其中一位資料寫成「第1選舉區」）、第02選舉區 3 位
const district1 = Array.from({ length: 8 }, (_, i) => person(`a${i}`, `甲${i}`, { subRegion: i === 7 ? "第1選舉區" : "第01選舉區", candNo: i + 1 }));
const district2 = Array.from({ length: 3 }, (_, i) => person(`b${i}`, `乙${i}`, { subRegion: "第02選舉區", candNo: i + 1 }));
const everyone: ComparePerson[] = [...district1, ...district2];
const policies = [...district1, ...district2].map((p, i) => policy(`p${i}`, String(p.id), "交通建設"));

Deno.test("districtKey／sameDistrict：第1、第01、區名前綴都認得；不同區、空字串不相等", () => {
  assertEquals(districtKey("第1選舉區"), "第01選舉區");
  assertEquals(districtKey(" 第01選舉區 "), "第01選舉區");
  assertEquals(districtKey("那瑪夏區第1選舉區"), "那瑪夏區第01選舉區");
  assertEquals(districtKey("台南市第3選區"), "台南市第03選區");
  assert(sameDistrict("第1選舉區", "第01選舉區"));
  assert(!sameDistrict("第01選舉區", "第02選舉區"));
  assert(!sameDistrict("第11選舉區", "第01選舉區"));
  assert(!sameDistrict("", ""));
  assert(!sameDistrict(undefined, "第01選舉區"));
});

Deno.test("pkGroups：第1選舉區與第01選舉區併成同一組，組名用正式寫法", () => {
  const groups = pkGroups(everyone, "縣市議員");
  assertEquals(groups.map((g) => [g.label, g.people.length]), [["第01選舉區", 8], ["第02選舉區", 3]]);
});

Deno.test("inSubRegionScope：議員比對應表查到的選舉區（寫法不同也算同區），查不到不篩；其他職位交給 inTownship", () => {
  const council = (electoralDistrict?: string) => ({ isCouncilor: true, electoralDistrict, inTownship: () => false });
  assert(inSubRegionScope("第1選舉區", council("第01選舉區")));
  assert(inSubRegionScope("第01選舉區", council("第01選舉區")));
  assert(!inSubRegionScope("第02選舉區", council("第01選舉區")));
  assert(inSubRegionScope("第02選舉區", council(undefined)), "對應表查不到時不篩");
  const rep = { isCouncilor: false, inTownship: (s: string | undefined) => s?.startsWith("大林鎮") ?? false };
  assert(inSubRegionScope("大林鎮第01選舉區", rep));
  assert(!inSubRegionScope("民雄鄉第01選舉區", rep));
});

Deno.test("PK 詳情：只列標題那張表的人，第01選舉區 8 位，不含第02選舉區與其他縣市", () => {
  const group = pkGroups(everyone, "縣市議員")[0];
  const matrix = compareMatrix(group.people, policies, 2026, ["交通建設"]);
  const input = { title: "縣市議員・第01選舉區", region: "台南市", year: 2026, electionName: "九合一", matrix, htmlPath: "/election/2026/台南市" };
  const page = buildPkMdPage(input);
  assertEquals(matrix.columns.length, 8);
  assert(page.body.includes("- 並排比較 8 位參選人、政見 8 筆"));
  const headings = page.body.filter((l) => l.startsWith("## ") && l !== "## 概況");
  assertEquals(headings.length, matrix.columns.length, "詳情的人數＝標題的人數");
  assert(headings.every((h) => h.includes("甲")), "每一位都是第01選舉區的人");
  assertEquals(page.rowCount, 8);
  assert(!page.body.join("\n").includes("乙"), "第02選舉區的人不出現");
  const text = renderPkMd(input, Date.UTC(2026, 9, 20));
  assert(text.includes("台南市 縣市議員・第01選舉區 政見 PK"));
  assert(!text.includes("乙0"));
});

Deno.test("PK 詳情：勾選子集時，詳情跟著表走（人數與標題一致）", () => {
  const group = pkGroups(everyone, "縣市議員")[0];
  const matrix = compareMatrix(group.people.slice(0, 3), policies, 2026, ["交通建設"]);
  const page = buildPkMdPage({ title: "縣市議員・第01選舉區", region: "台南市", year: 2026, matrix, htmlPath: "/election/2026/台南市" });
  assertEquals(page.body.filter((l) => l.startsWith("## ") && l !== "## 概況").length, 3);
  assert(page.scope.includes("並排 3 位"));
});

Deno.test("PK 詳情：沒政見的人照列、標示尚無政見", () => {
  const matrix = compareMatrix(district1.slice(0, 2), [policy("x", "a0", "交通建設")], 2026, ["交通建設"]);
  const page = buildPkMdPage({ title: "縣市議員・第01選舉區", region: "台南市", year: 2026, matrix, htmlPath: "/election/2026/台南市" });
  assert(page.body.includes("- 這一場選舉尚無政見資料"));
});

Deno.test("PK 詳情是現場組的、沒有網址：path 空字串，MdDrawer 對空 path 不畫「另開視窗」", () => {
  const page = Deno.readTextFileSync(new URL("../pages/ElectionPage.vue", import.meta.url));
  const drawer = Deno.readTextFileSync(new URL("../components/MdDrawer.vue", import.meta.url));
  assert(/id: `pk:[^\n]*\n\s*path: '',/.test(page), "PK 詳情的 pick 要是 path: ''");
  assert(/<a v-if="pick\.path" :href="pick\.path"/.test(drawer), "MdDrawer 的另開視窗連結要 v-if pick.path");
});
