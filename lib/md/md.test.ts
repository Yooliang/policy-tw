/**
 * Markdown 檢視（docs/PLAN-markdown-views.md）：組字、路由、矩陣與頁面的一致、對外文件的一致。
 *
 * 守的幾件事：
 *   1. 每份 .md 開頭的中繼資料欄位固定（缺的填 null）、一行聲明「原始出處的權利歸原發布者」
 *   2. 人物排序＝姓名筆畫（跟網頁「姓名筆畫」同一個比較）、政見依提出日期再依 id，輸出穩定
 *   3. 分類、縣市×分類只收最新一屆在選候選人（退選、沒參選的現任、村里長都不收）名下、屬於這一屆的競選承諾（維護者 10-07：範圍由人改為政見；
 *      任內政見、別屆的承諾不收，落選者保留標「未當選」），數字直接按 category 算；0 筆寫「資料庫目前沒有收錄」；每一條政見要嘛在資料集、要嘛在 index.json 的 unassigned
 *   4. 矩陣的格子數字＝對應 .md 的筆數、總數＝各格加總（同一個算法，buildAll 裡直接擋）；機器可讀索引每個檔案帶同一批的 generated_at
 *   5. 網址解析：臺→台 301、簡稱→全名 301、分類的常見說法→分類全名 301、舊三屆 key→年份 301、認不出來 404、查詢式 302
 *   6. llms.txt 列的連結全部真的認得；firebase 的轉址不擋 HTML 頁；快取表只開 SELECT
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import type { Election, Policy, Politician, PoliticianElectionData } from "../../types.ts";
import { TAIWAN_COUNTIES } from "../election-regions.ts";
import { CATEGORIES } from "../data-query.ts";
import {
  FORMAT_VERSION, NO_SOURCE, STATEMENT, compareByName, comparePolicies, frontMatter, latestTime, policyBullet, renderPage, taipeiDate, taipeiIso, truncate, yamlScalar,
} from "./format.ts";
import { renderPoliticianMd } from "./politician.ts";
import { buildRegionPage } from "./region.ts";
import { buildCategoryPage, buildRegionCategoryPage, categoryCount, type ListContext } from "./lists.ts";
import { CHANGELOG_SCOPE_BY_POLICY, MATRIX_PATH, buildAll, regionCandidatesKey, type Corpus } from "./dataset.ts";
import { buildIndexPage, buildNotFoundPage, listingLines } from "./index-page.ts";
import { latestPath, matchMarkdownRoute, resolveDataQuery } from "./route.ts";
import { NATIONAL, latestLocalElection, scopeOf, scopePeople } from "./scope.ts";
import { SCOPE_VERSION, UNASSIGNED_REASONS, isPledge, partitionPolicies } from "./pledge.ts";
import { pledgeCounts } from "../pledge-origin.ts";

// ───────── 假資料 ─────────

const E2026: Election = { id: 2026, electionKey: "2026-11-28_local", name: "115年地方公職人員選舉", shortName: "2026 九合一", startDate: "2026-11-28", endDate: "2026-11-28", electionDate: "2026-11-28", types: ["縣市長", "縣市議員"] as never };
const E2022: Election = { id: 2022, electionKey: "2022-11-26_local", name: "111年地方公職人員選舉", shortName: "2022 九合一", startDate: "2022-11-26", endDate: "2022-11-26", electionDate: "2022-11-26", types: ["縣市長", "縣市議員"] as never };
const E2024: Election = { id: 2024, electionKey: "2024-01-13_national", name: "113年立委選舉", shortName: "2024", startDate: "2024-01-13", endDate: "2024-01-13", electionDate: "2024-01-13", types: ["總統副總統", "立法委員"] as never };
const TODAY = "2026-10-07";
const NOW = Date.parse("2026-10-07T10:42:11+08:00");

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

function rec(over: Partial<PoliticianElectionData> = {}): PoliticianElectionData {
  return { electionId: 2026, position: "", electionType: "縣市議員", region: "台南市", subRegion: "第01選舉區", candidacyStatus: "filed", ...over };
}
function person(name: string, over: Partial<Politician> = {}): Politician {
  return { id: uuid(), name, party: "無黨籍", position: "", region: "台南市", elections: [rec()], offices: [], ...over };
}
function policy(p: Politician, title: string, over: Partial<Policy> = {}): Policy {
  return {
    id: uuid(), politicianId: p.id, electionId: 2026, title, description: `${title}的說明`, category: "社會福利", status: "Campaign Pledge" as never,
    proposedDate: "2026-09-01", lastUpdated: "2026-09-10", updatedAt: "2026-09-10T08:00:00+00:00", progress: 0, tags: [], logs: [],
    stanceSupport: 0, stanceOppose: 0, stancePriority: 0, sourceUrl: "https://example.com/a", sources: [{ url: "https://example.com/a", role: "primary" }], ...over,
  };
}

const 王 = person("王大明", { party: "民主進步黨" });
const 李 = person("李小花");
const 陳 = person("陳大文", { party: "中國國民黨", elections: [rec({ electionType: "縣市長", subRegion: undefined })] });
const 無政見 = person("趙無事");
const 退選 = person("錢退選", { elections: [rec({ candidacyStatus: "withdrawn" })] });
const 台北 = person("孫北市", { region: "台北市", elections: [rec({ region: "台北市", subRegion: "第02選舉區" })] });
const 現任 = person("周現任", { elections: [rec({ electionId: 2022, candidacyStatus: "elected", electionDate: "2022-11-26" })], offices: [{ electionId: 2022, electionDate: "2022-11-26", electionType: "縣市議員", region: "台南市", subRegion: "第03選舉區" }] });
const 里長 = person("吳里長", { elections: [rec({ electionType: "村里長", subRegion: "北區", village: "東門里" })] });

const ALL_PEOPLE = [王, 李, 陳, 無政見, 退選, 台北, 現任, 里長];
const POLICIES: Policy[] = [
  policy(王, "托育補助加碼", { description: "增加育兒津貼與托嬰名額", category: "社會福利", proposedDate: "2026-09-02" }),
  policy(王, "新闢捷運線", { category: "交通建設", proposedDate: "2026-09-05" }),
  policy(王, "無日期的政見", { category: "其他", proposedDate: null }),
  policy(李, "擴大公共托育", { category: "社會福利" }),
  policy(陳, "增設停車場", { category: "交通建設", sourceUrl: undefined, sources: undefined }),
  policy(退選, "退選者的政見", { category: "交通建設" }),
  policy(台北, "台北捷運延伸", { category: "交通建設" }),
  policy(現任, "現任的長照", { category: "社會福利", electionId: 2022 }),
  policy(里長, "里長的路燈", { category: "交通建設" }),
];
const CTX: ListContext = { election: E2026, segment: "2026", scoped: scopePeople(ALL_PEOPLE, E2026, TODAY), policies: POLICIES };
const fakeSha = (page: { title: string; body: string[] }) => `sha-${page.title}-${page.body.length}`;

// ───────── 固定中繼資料與格式 ─────────

Deno.test("front matter：欄位固定、順序固定；缺的填 null；網址 percent-encoded（解碼後的路徑也行）", () => {
  const fm = frontMatter({ title: "標題", path: "/data/2026/台南市/交通建設.md", htmlPath: null, generatedAt: NOW, dataAsOf: null, scope: "範圍" });
  const keys = fm.split("\n").slice(1, -1).map((l) => l.split(":")[0]);
  assertEquals(keys, ["title", "source", "url", "html_url", "generated_at", "data_as_of", "license", "license_url", "cite", "scope", "notice", "format_version"]);
  assertStringIncludes(fm, "url: https://xn--2lw665d.tw/data/2026/%E5%8F%B0%E5%8D%97%E5%B8%82/%E4%BA%A4%E9%80%9A%E5%BB%BA%E8%A8%AD.md\n");
  assertStringIncludes(fm, "html_url: null");
  assertStringIncludes(fm, "data_as_of: null");
  assertStringIncludes(fm, "generated_at: 2026-10-07T10:42:11+08:00");
  assertStringIncludes(fm, `format_version: ${FORMAT_VERSION}`);
  assertStringIncludes(fm, "license: \"CC BY 4.0\"");
  assert(!/資料更新/.test(fm), "沒有 data_as_of 就不寫（資料更新：…）");
  const encoded = frontMatter({ title: "t", path: "/data/2026/%E5%8F%B0.md", htmlPath: null, generatedAt: NOW, dataAsOf: null, scope: "s" });
  assertStringIncludes(encoded, "url: https://xn--2lw665d.tw/data/2026/%E5%8F%B0.md\n", "已編碼的不重複編碼");
});

Deno.test("每份文件：一行聲明講原始出處的權利歸原發布者", () => {
  assertStringIncludes(STATEMENT, "原始出處的權利歸原發布者");
  const md = renderPage({ title: "T", htmlPath: null, dataAsOf: null, scope: "s", preface: [], body: ["內文"], rowCount: 0 }, "/data/2026/index.md", NOW);
  assertStringIncludes(md, `> ${STATEMENT}`);
  assert(md.endsWith("內文\n"));
  assert(md.startsWith("---\n"));
});

Deno.test("YAML 純量：安全字元直接寫，其餘用 JSON 雙引號；數字、null", () => {
  assertEquals(yamlScalar("https://xn--2lw665d.tw/a%20b.md"), "https://xn--2lw665d.tw/a%20b.md");
  assertEquals(yamlScalar("台南市 2026"), "\"台南市 2026\"");
  assertEquals(yamlScalar("a: b"), "\"a: b\"");
  assertEquals(yamlScalar(null), "null");
  assertEquals(yamlScalar(1), "1");
});

Deno.test("時間：台北時間 +08:00；日期原樣；取最大值", () => {
  assertEquals(taipeiIso(Date.parse("2026-10-07T02:42:11Z")), "2026-10-07T10:42:11+08:00");
  assertEquals(taipeiDate("2026-10-06T20:00:00+00:00"), "2026-10-07");
  assertEquals(taipeiDate("2026-10-06"), "2026-10-06");
  assertEquals(taipeiDate(null), null);
  assertEquals(latestTime(["2026-09-01", "2026-09-10T08:00:00+00:00", null]), "2026-09-10T16:00:00+08:00");
  assertEquals(latestTime([null, undefined]), null);
});

Deno.test("截斷照字算、壓成一行", () => {
  assertEquals(truncate("一二三四五六\n七八", 4), "一二三四…");
  assertEquals(truncate("短", 10), "短");
  assertEquals(truncate(null, 10), "");
});

Deno.test("人物排序＝姓名筆畫（同網頁，先字數再筆畫），並列依 id；政見依提出日期新的在前、沒日期的最後、再依 id", () => {
  const sorted = [{ name: "陳大文", id: "b" }, { name: "李安", id: "c" }, { name: "李安", id: "a" }, { name: "王大明", id: "d" }].sort(compareByName);
  assertEquals(sorted.map((p) => p.id), ["a", "c", "d", "b"]); // 兩字在前；同名依 id；三字依筆畫（王 4 畫 < 陳 11 畫）
  const ps = [{ id: "2", proposedDate: null }, { id: "1", proposedDate: "2026-01-01" }, { id: "3", proposedDate: "2026-05-01" }, { id: "0", proposedDate: "2026-05-01" }].sort(comparePolicies);
  assertEquals(ps.map((p) => p.id), ["0", "3", "1", "2"]);
});

Deno.test("政見一行：類別、狀態、日期、出處；沒有出處寫「出處待補」；競選承諾不印進度", () => {
  const lines = policyBullet(POLICIES[0], { descMax: 50 });
  assertStringIncludes(lines[0], "〈托育補助加碼〉｜社會福利｜競選承諾｜提出 2026-09-02｜更新 2026-09-10");
  assert(!lines[0].includes("進度"));
  assertStringIncludes(lines.join("\n"), "出處：https://example.com/a");
  assertStringIncludes(policyBullet(POLICIES[4], { descMax: 0 }).join("\n"), `出處：${NO_SOURCE}`);
  assertStringIncludes(policyBullet(policy(王, "進行中的", { status: "In Progress" as never, progress: 40 }), { descMax: 0 })[0], "進行中｜進度 40%");
});

// ───────── 人物 ─────────

Deno.test("人物 .md：基本資料、參選紀錄、政見依屆別分組；未標屆別放最後", () => {
  const md = renderPoliticianMd({
    politician: 王, policies: POLICIES.filter((p) => p.politicianId === 王.id).concat(policy(王, "舊屆政見", { electionId: 2022 }), policy(王, "沒屆別", { electionId: undefined })),
    elections: [E2022, E2024, E2026], today: TODAY, generatedAt: NOW,
  });
  assertStringIncludes(md, "title: \"王大明（民主進步黨）的政見與參選紀錄\"");
  assertStringIncludes(md, "html_url: https://xn--2lw665d.tw/politician/" + 王.id);
  assertStringIncludes(md, "- 2026 台南市議員（115年地方公職人員選舉）：已登記");
  const i2026 = md.indexOf("### 2026 115年地方公職人員選舉");
  const i2022 = md.indexOf("### 2022 111年地方公職人員選舉");
  const iNone = md.indexOf("### 未標屆別");
  assert(i2026 > 0 && i2022 > i2026 && iNone > i2022, "屆別新的在前，沒屆別的最後");
  assert(md.indexOf("新闢捷運線") < md.indexOf("托育補助加碼") && md.indexOf("托育補助加碼") < md.indexOf("無日期的政見"));
  assertStringIncludes(md, "- 三要素：數值目標：未調查｜達成期限：未調查｜財源：未調查");
});

Deno.test("人物 .md：沒有政見、沒有參選紀錄也要有明確的一句，不是空白", () => {
  const md = renderPoliticianMd({ politician: person("空空", { elections: [] }), policies: [], elections: [E2026], today: TODAY, generatedAt: NOW });
  assertStringIncludes(md, "資料庫目前沒有收錄參選紀錄");
  assertStringIncludes(md, "資料庫目前沒有收錄這位人物的政見");
  assertStringIncludes(md, "data_as_of: null");
});

Deno.test("人物 .md：現任公職只來自任期（沒有任期就不寫）", () => {
  assertStringIncludes(renderPoliticianMd({ politician: 現任, policies: [], elections: [E2022, E2026], today: TODAY, generatedAt: NOW }), "- 現任公職：台南市議員");
  assert(!renderPoliticianMd({ politician: 李, policies: [], elections: [E2026], today: TODAY, generatedAt: NOW }).includes("現任公職"));
});

// ───────── 縣市 ─────────

Deno.test("縣市 .md：退選的不算、依職位與選舉區分組、沒有政見的一行列名字、筆數與標題一致", () => {
  const page = buildRegionPage({ election: E2026, segment: "2026", region: "台南市", candidates: [王, 李, 陳, 無政見, 退選], policies: POLICIES, today: TODAY });
  const md = renderPage(page, "/election/2026/台南市.md", NOW);
  assertEquals(page.rowCount, 5); // 王 3 ＋ 李 1 ＋ 陳 1（退選者的不算）
  assertStringIncludes(page.scope, "共 3 位有政見的候選人、5 筆政見（候選人 4 位）");
  assert(!md.includes("錢退選"), "退選的人不列");
  assertStringIncludes(md, "## 縣市長（候選人 1 位，有政見 1 位、政見 1 筆）");
  assertStringIncludes(md, "## 縣市議員（候選人 3 位，有政見 2 位、政見 4 筆）");
  assertStringIncludes(md, "### 第01選舉區");
  assertStringIncludes(md, "尚無政見資料（1 位）：趙無事（無黨籍）");
  assert(md.indexOf("## 縣市長") < md.indexOf("## 縣市議員"), "職位順序照職位表");
  assert(md.indexOf("王大明") < md.indexOf("李小花"));
  assertStringIncludes(md, "html_url: https://xn--2lw665d.tw/election/2026/%E5%8F%B0%E5%8D%97%E5%B8%82\n");
});

Deno.test("縣市 .md：沒有候選人也有明確的一句", () => {
  const page = buildRegionPage({ election: E2026, segment: "2026", region: "連江縣", candidates: [], policies: [], today: TODAY });
  assertStringIncludes(page.body.join("\n"), "資料庫目前沒有收錄這一屆這個縣市的候選人");
});

// ───────── 收錄範圍、分類、縣市×分類 ─────────

Deno.test("收錄的人：最新一屆在選候選人（縣市頁那一層與下一層的職位）；退選、沒參選的現任、村里長都不收；各歸一個縣市", () => {
  assertEquals(CTX.scoped.map((s) => s.politician.name).sort(), ["孫北市", "李小花", "王大明", "趙無事", "陳大文"].sort());
  assertEquals(scopeOf(退選, E2026, TODAY), null);
  assertEquals(scopeOf(現任, E2026, TODAY), null, "現任但這一屆沒參選的不算（維護者：只算該屆參選人）");
  assertEquals(scopeOf(里長, E2026, TODAY), null, "村里長不在縣市頁那一層，不收");
  assertEquals(scopeOf(台北, E2026, TODAY)?.region, "台北市");
  assertEquals(scopeOf(person("全國", { elections: [rec({ region: "全國" })] }), E2026, TODAY)?.region, NATIONAL);
  assertEquals(scopeOf(王, E2026, TODAY)?.label, "2026 台南市議員・已登記");
});

Deno.test("最新一屆＝投票日最新、而且選縣市長與縣市議員的那一場（不從 id 推）", () => {
  assertEquals(latestLocalElection([E2022, E2024, E2026])?.id, 2026);
  assertEquals(latestLocalElection([E2022, E2024])?.id, 2022);
  assertEquals(latestLocalElection([E2024]), undefined);
});

Deno.test("分類 .md：依縣市分組（照網站縣市順序）、數字直接按 category 算、連到縣市×分類", () => {
  const page = buildCategoryPage("交通建設", CTX);
  const md = renderPage(page, "/data/2026/交通建設.md", NOW);
  assertEquals(page.rowCount, 3); // 王「新闢捷運線」、陳「增設停車場」、台北「台北捷運延伸」（退選、里長的不算）
  assertStringIncludes(md, "## 台北市（1 位、1 筆）");
  assertStringIncludes(md, "## 台南市（2 位、2 筆）");
  assert(md.indexOf("## 台北市") < md.indexOf("## 台南市"), "六都順序：台北、新北、桃園、台中、台南、高雄");
  assertStringIncludes(md, "https://xn--2lw665d.tw/data/2026/%E5%8F%B0%E5%8D%97%E5%B8%82/%E4%BA%A4%E9%80%9A%E5%BB%BA%E8%A8%AD.md");
  assertStringIncludes(md, "html_url: null");
  assert(!md.includes("關鍵字"), "沒有「依關鍵字比對」那一行了（維護者 10-07：直接用既有分類）");
});

Deno.test("縣市×分類 .md；0 筆寫「資料庫目前沒有收錄」；格子數字＝頁面筆數", () => {
  const page = buildRegionCategoryPage("台南市", "社會福利", CTX);
  assertEquals(page.rowCount, 2); // 王「托育補助加碼」、李「擴大公共托育」（現任的「現任的長照」不算）
  assertEquals(categoryCount("台南市", "社會福利", CTX), 2);
  const empty = buildRegionCategoryPage("台北市", "社會福利", CTX);
  assertEquals(empty.rowCount, 0);
  assertStringIncludes(empty.body.join("\n"), "資料庫目前沒有收錄符合的政見");
  assertStringIncludes(page.scope, "縣市：台南市；分類：社會福利");
});

// ───────── 預產、索引與矩陣 ─────────

function corpus(): Corpus {
  const regionCandidates = new Map();
  regionCandidates.set(regionCandidatesKey(2026, "台南市"), { candidates: [王, 李, 陳, 無政見, 退選], truncated: false });
  return { elections: [E2022, E2024, E2026], people: ALL_PEOPLE, policies: POLICIES, regionCandidates, today: TODAY };
}

Deno.test("預產：頁面清單完整、路徑唯一；矩陣格子與頁面筆數一致、總數＝各格加總", () => {
  const { pages, json, matrix } = buildAll(corpus(), { generatedAt: NOW, sha: fakeSha });
  assert(matrix);
  const paths = pages.map((p) => p.path);
  assertEquals(new Set(paths).size, paths.length, "路徑不重複");
  assertEquals(pages.filter((p) => p.type === "category").length, 19);
  assertEquals(pages.filter((p) => p.type === "region_category").length, 22 * 19);
  assert(paths.includes("/data/2026/index.md"));
  assert(paths.includes("/election/2026/台南市.md"));
  assert(paths.includes("/data/2026/交通建設.md"));
  assert(paths.includes("/data/2026/台南市/交通建設.md"));
  assertEquals(json.map((j) => j.path), ["/data/2026/index.json"]);
  assertEquals(matrix.regions.length, 22);
  assertEquals(matrix.categories, [...CATEGORIES]);
  assertEquals(matrix.election.segment, "2026");
  let sum = 0;
  for (const r of matrix.regions) {
    for (const c of CATEGORIES) {
      const page = pages.find((p) => p.path === `/data/2026/${r}/${c}.md`)!;
      assertEquals(matrix.counts[r][c], page.page.rowCount, `${r} ${c}`);
      sum += matrix.counts[r][c];
    }
  }
  assertEquals(matrix.total, sum);
  assertEquals(matrix.counts["台南市"]["社會福利"], 2);
  assertEquals(matrix.counts["台北市"]["交通建設"], 1);
  assertEquals(matrix.regionTotals["台南市"], 5);
  assertEquals(matrix.regionTotals["台北市"], 1);
  assertEquals(matrix.categoryTotals["交通建設"], 3);
  assertEquals(matrix.categoryTotals["其他"], 1);
  for (const c of CATEGORIES) assertEquals(matrix.categoryTotals[c], Object.values(matrix.counts).reduce((a, r) => a + r[c], 0), `${c} 的列尾總數＝各縣市加總`);
  assertEquals(matrix.total, 6);
});

Deno.test("縣市頁與矩陣是同一批人：縣市頁的政見筆數＝矩陣該縣市的總數；RPC 撈不到（region_id 空）的候選人也併進縣市頁", () => {
  // 候選人名單（RPC）只給「趙無事」一個人：王、李、陳、台北都是靠「有政見＋參選紀錄的縣市」併進來的
  const c = corpus();
  c.regionCandidates = new Map([[regionCandidatesKey(2026, "台南市"), { candidates: [無政見], truncated: false }]]);
  const { pages, matrix } = buildAll(c, { generatedAt: NOW, sha: fakeSha });
  const tainan = pages.find((p) => p.path === "/election/2026/台南市.md")!;
  const text = tainan.page.body.join("\n");
  assertStringIncludes(text, "王大明");
  assertStringIncludes(text, "陳大文");
  for (const region of matrix!.regions) {
    const p = pages.find((x) => x.type === "region" && x.path.startsWith("/election/2026/") && x.region === region);
    assertEquals(p?.page.rowCount ?? 0, matrix!.regionTotals[region], `${region}：縣市頁筆數要等於矩陣的縣市總數`);
  }
});

Deno.test("機器可讀索引：每個檔案的網址、類型、縣市、分類、筆數、產生時間、內容雜湊；同一批的 generated_at 都一樣", () => {
  const { pages, json } = buildAll(corpus(), { generatedAt: NOW, sha: fakeSha });
  const idx = JSON.parse(json[0].body);
  assertEquals(idx.generated_at, "2026-10-07T10:42:11+08:00");
  assertEquals(idx.format_version, FORMAT_VERSION);
  assertEquals(idx.url, "https://xn--2lw665d.tw/data/2026/index.json");
  assertEquals(idx.index_md, "https://xn--2lw665d.tw/data/2026/index.md");
  assertEquals(idx.license, "CC BY 4.0");
  assertEquals(idx.total_policies, 6);
  assertEquals(idx.files.length, 2 + 19 + 22 * 19, "有候選人的縣市（台南、台北）＋19 分類＋418 縣市×分類");
  for (const f of idx.files) {
    assertEquals(Object.keys(f).sort(), ["category", "count", "generated_at", "region", "sha", "type", "url"]);
    assertEquals(f.generated_at, idx.generated_at);
    assert(["region", "category", "region_category"].includes(f.type));
  }
  const cell = idx.files.find((f: { url: string }) => f.url === "https://xn--2lw665d.tw/data/2026/%E5%8F%B0%E5%8D%97%E5%B8%82/%E7%A4%BE%E6%9C%83%E7%A6%8F%E5%88%A9.md");
  assertEquals(cell.type, "region_category");
  assertEquals(cell.region, "台南市");
  assertEquals(cell.category, "社會福利");
  assertEquals(cell.count, 2);
  assertEquals(cell.sha, fakeSha(pages.find((p) => p.path === "/data/2026/台南市/社會福利.md")!.page));
  const region = idx.files.find((f: { type: string; region: string }) => f.type === "region" && f.region === "台南市");
  assertEquals(region.url, "https://xn--2lw665d.tw/data/2026/%E5%8F%B0%E5%8D%97%E5%B8%82.md");
  assertEquals(region.count, 5);
  assertEquals(region.category, null);
  const cat = idx.files.find((f: { type: string; category: string }) => f.type === "category" && f.category === "交通建設");
  assertEquals(cat.region, null);
  assertEquals(cat.count, 3);
});

Deno.test("預產：沒有最新一屆定期選舉就不產矩陣、分類與索引（不拿別的選舉頂替）", () => {
  const c = corpus();
  c.elections = [E2024];
  const { pages, json, matrix } = buildAll(c, { generatedAt: NOW, sha: fakeSha });
  assertEquals(matrix, null);
  assertEquals(json.length, 0);
  assertEquals(pages.length, 0);
  assertEquals(MATRIX_PATH, "_matrix");
});

// ───────── 網址解析 ─────────

const enc = encodeURIComponent;
const r = (path: string, qs = "") => matchMarkdownRoute(path, new URLSearchParams(qs));

Deno.test("路由：人物", () => {
  assertEquals(r("/politician/0000b296-7ae8-4184-b704-c69d44cb696a.md"), { kind: "politician", id: "0000b296-7ae8-4184-b704-c69d44cb696a" });
  assertEquals(r("/politician/abc.md")?.kind, "notfound");
  assertEquals(r("/politician/0000b296-7ae8-4184-b704-c69d44cb696a"), null, "HTML 頁不是這裡處理的");
});

Deno.test("路由：縣市（某屆）；臺→台 301、簡稱→全名 301、舊三屆 key→年份 301", () => {
  assertEquals(r(`/election/2026/${enc("台南市")}.md`), { kind: "cache", key: "/election/2026/台南市.md", path: "/election/2026/台南市.md", format: "md" });
  assertEquals(r(`/election/2026/${enc("臺南市")}.md`), { kind: "redirect", status: 301, to: `/election/2026/${enc("台南市")}.md` });
  assertEquals(r(`/election/2026/${enc("台南")}.md`), { kind: "redirect", status: 301, to: `/election/2026/${enc("台南市")}.md` });
  assertEquals(r(`/election/2026-11-28_local/${enc("台南市")}.md`), { kind: "redirect", status: 301, to: `/election/2026/${enc("台南市")}.md` });
  assertEquals(r(`/election/2022-12-18_rerun_10020/${enc("嘉義市")}.md`)?.kind, "cache", "新增的選舉用 key，原樣");
  assertEquals(r(`/election/2026/${enc("火星市")}.md`)?.kind, "notfound");
  assertEquals(r("/election/2026.md")?.kind, "notfound");
  assertEquals(r(`/election/2026/${enc("台南市")}/${enc("北區")}.md`)?.kind, "notfound", "鄉鎮沒有 Markdown 版");
  assertEquals(r(`/election/2026/${enc("台南市")}`), null, "縣市的 HTML 頁不是這裡處理的");
  assertEquals(r("/election/2026/matrix"), null);
});

Deno.test("路由：/category/<分類>.md → 最新一屆；常見說法 301 到分類全名", () => {
  assertEquals(r(`/category/${enc("交通建設")}.md`), { kind: "category-latest", category: "交通建設" });
  assertEquals(r(`/category/${enc("育兒")}.md`), { kind: "redirect", status: 301, to: `/category/${enc("社會福利")}.md` });
  assertEquals(r(`/category/${enc("不存在")}.md`)?.kind, "notfound");
});

Deno.test("路由：/data/<屆>/… 三種切法與索引", () => {
  // 縣市（全部分類）：讀縣市頁那一列，網址用請求的
  assertEquals(r(`/data/2026/${enc("台南市")}.md`), { kind: "cache", key: "/election/2026/台南市.md", path: "/data/2026/台南市.md", format: "md" });
  // 分類（全部縣市）
  assertEquals(r(`/data/2026/${enc("交通建設")}.md`), { kind: "cache", key: "/data/2026/交通建設.md", path: "/data/2026/交通建設.md", format: "md" });
  // 縣市×分類
  assertEquals(r(`/data/2026/${enc("台南市")}/${enc("交通建設")}.md`), { kind: "cache", key: "/data/2026/台南市/交通建設.md", path: "/data/2026/台南市/交通建設.md", format: "md" });
  // 索引（人看、程式看）
  assertEquals(r("/data/2026/index.md"), { kind: "cache", key: "/data/2026/index.md", path: "/data/2026/index.md", format: "md" });
  assertEquals(r("/data/2026/index.json"), { kind: "cache", key: "/data/2026/index.json", path: "/data/2026/index.json", format: "json" });
  // 正式寫法：臺→台、簡稱→全名、常見說法→分類全名、舊三屆 key→年份
  assertEquals(r(`/data/2026/${enc("臺南市")}/${enc("交通建設")}.md`), { kind: "redirect", status: 301, to: `/data/2026/${enc("台南市")}/${enc("交通建設")}.md` });
  assertEquals(r(`/data/2026/${enc("台南市")}/${enc("育兒")}.md`), { kind: "redirect", status: 301, to: `/data/2026/${enc("台南市")}/${enc("社會福利")}.md` });
  assertEquals(r(`/data/2026-11-28_local/${enc("台南市")}/${enc("交通建設")}.md`), { kind: "redirect", status: 301, to: `/data/2026/${enc("台南市")}/${enc("交通建設")}.md` });
  assertEquals(r(`/data/2026/${enc("火星市")}/${enc("交通建設")}.md`)?.kind, "notfound");
  assertEquals(r(`/data/2026/${enc("台南市")}/${enc("不知道的詞")}.md`)?.kind, "notfound");
  assertEquals(r(`/data/2026/${enc("不知道的詞")}.md`)?.kind, "notfound");
  assertEquals(r("/data/2026/a/b/c.md")?.kind, "notfound");
  assertEquals(r("/data/2026/index.json/x.md")?.kind, "notfound");
});

Deno.test("路由：最新一屆的短網址（舊規劃網址）轉到 /data/<屆>/…，屆別由 Worker 查", () => {
  assertEquals(r(`/data/${enc("台南市")}.md`), { kind: "latest", status: 301, target: "election", tail: ["台南市.md"] });
  assertEquals(r(`/data/${enc("台南市")}/${enc("交通建設")}.md`), { kind: "latest", status: 301, target: "data", tail: ["台南市", "交通建設.md"] });
  assertEquals(r(`/data/${enc("台南市")}/${enc("育兒")}.md`), { kind: "latest", status: 301, target: "data", tail: ["台南市", "社會福利.md"] });
  assertEquals(r("/data/index.md"), { kind: "latest", status: 301, target: "data", tail: ["index.md"] });
  assertEquals(r("/data/index.json"), { kind: "latest", status: 301, target: "data", tail: ["index.json"] });
  assertEquals(r(`/data/${enc("臺南市")}.md`), { kind: "redirect", status: 301, to: `/data/${enc("台南市")}.md` });
  assertEquals(r(`/data/${enc("台南市")}/${enc("亂寫")}.md`)?.kind, "notfound");
  assertEquals(latestPath("data", "2026", ["台南市", "交通建設.md"]), `/data/2026/${enc("台南市")}/${enc("交通建設")}.md`);
  assertEquals(latestPath("election", "2026", ["台南市.md"]), `/election/2026/${enc("台南市")}.md`);
});

Deno.test("路由：沒帶 .md 補上（301）", () => {
  assertEquals(r(`/data/2026/${enc("台南市")}/${enc("交通建設")}`), { kind: "redirect", status: 301, to: `/data/2026/${enc("台南市")}/${enc("交通建設")}.md` });
  assertEquals(r(`/data/${enc("台南市")}`), { kind: "redirect", status: 301, to: `/data/${enc("台南市")}.md` });
});

Deno.test("路由：/data 沒有查詢＝矩陣頁；帶查詢＝302 到路徑式；認不出來 404", () => {
  assertEquals(r("/data"), { kind: "data-matrix" });
  assertEquals(r("/data/"), { kind: "data-matrix" });
  const ask: ReturnType<typeof r> = { kind: "latest", status: 302, target: "data", tail: ["台南市", "社會福利.md"] };
  assertEquals(r("/data", "q=台南 育兒"), ask);
  assertEquals(r("/data/search", "q=台南 育兒"), ask);
  assertEquals(r("/data", "city=臺南市&topic=托嬰"), ask);
  assertEquals(r("/data", "q=火星人 吃飯")?.kind, "notfound");
  assertEquals(r("/data/search")?.kind, "notfound");
});

Deno.test("查詢式：縣市＋分類、只有縣市、只有分類、多縣市、多分類", () => {
  assertEquals(resolveDataQuery("台南 交通建設"), { kind: "latest", status: 302, target: "data", tail: ["台南市", "交通建設.md"] });
  assertEquals(resolveDataQuery("北市 捷運"), { kind: "latest", status: 302, target: "data", tail: ["台北市", "交通建設.md"] });
  assertEquals(resolveDataQuery("台南"), { kind: "latest", status: 302, target: "election", tail: ["台南市.md"] });
  assertEquals(resolveDataQuery("交通建設"), { kind: "redirect", status: 302, to: `/category/${enc("交通建設")}.md` });
  assertEquals(resolveDataQuery("長照"), { kind: "redirect", status: 302, to: `/category/${enc("社會福利")}.md` });
  assertEquals(resolveDataQuery("台南 教育文化"), { kind: "latest", status: 302, target: "data", tail: ["台南市", "教育文化.md"] });
  assertEquals(resolveDataQuery("台南 台北 育兒").kind, "notfound");
  assertEquals(resolveDataQuery("台南 育兒 捷運").kind, "notfound");
  assertEquals(resolveDataQuery("").kind, "notfound");
});

Deno.test("路由：壞的百分比編碼不炸，是 404 或不處理", () => {
  const x = r("/politician/%E0%A4%A.md");
  assert(x === null || x.kind === "notfound");
});

Deno.test("認不出來的 404 Markdown：說沒認出什麼、列出 22 縣市與 19 分類（含查詢常見說法）", () => {
  const md = renderPage(buildNotFoundPage("「火星」"), "/data/x.md", NOW);
  assertStringIncludes(md, "沒認出來：「火星」");
  for (const region of TAIWAN_COUNTIES) assertStringIncludes(md, `- ${region}：`);
  for (const c of CATEGORIES) assertStringIncludes(md, `- ${c}：`);
  assertStringIncludes(md, "查詢常見說法：育兒、托育");
});

Deno.test("索引頁：概況、JSON 索引與矩陣的連結", () => {
  const built = buildAll(corpus(), { generatedAt: NOW, sha: fakeSha });
  const md = renderPage(buildIndexPage({ ctx: CTX, matrix: built.matrix!, dataAsOf: null }), "/data/2026/index.md", NOW);
  assertStringIncludes(md, "https://xn--2lw665d.tw/election/2026/matrix");
  assertStringIncludes(md, "https://xn--2lw665d.tw/data/2026/index.json");
  assertStringIncludes(md, `資料庫目前收錄的政見 ${POLICIES.length} 筆；2026 屆競選承諾 6 筆（本索引的範圍）`);
});

// ───────── 對外文件 ─────────

Deno.test("llms.txt：Markdown 入口的連結全部真的認得，清單跟索引頁同一份，指向 index.json／index.md", async () => {
  const txt = await Deno.readTextFile(new URL("../../public/llms.txt", import.meta.url));
  for (const line of listingLines().filter((l) => l.startsWith("- "))) assert(txt.includes(line), `llms.txt 少了索引頁的這一行：${line}`);
  const urls = [...txt.matchAll(/https:\/\/xn--2lw665d\.tw(\/[^\s`)<>，；。、—]*\.(?:md|json))/g)].map((m) => m[1]).filter((u) => u !== "/skill.md");
  assert(urls.length >= 22 + 19, "至少 22 縣市＋19 分類");
  for (const u of urls) {
    const route = matchMarkdownRoute(u);
    assert(route && route.kind !== "notfound", `llms.txt 列的 ${u} 路由認不得`);
  }
  assertStringIncludes(txt, "https://xn--2lw665d.tw/data/2026/index.json");
  assertStringIncludes(txt, "https://xn--2lw665d.tw/data/2026/index.md");
  assertStringIncludes(txt, "原始出處的權利歸原發布者");
  assertStringIncludes(txt, "ETag");
  assert(!/politician\/[^\s]*\.md/.test(txt), "維護者 10-07：人物的 .md 不列進 llms.txt");
});

Deno.test("firebase.json：policy-tw.web.app 的 .md、/data 301 到正見.tw；HTML 頁的 rewrite 不受影響", async () => {
  const cfg = JSON.parse(await Deno.readTextFile(new URL("../../firebase.json", import.meta.url)));
  const redirects = cfg.hosting.redirects as Array<{ source?: string; regex?: string; destination: string; type: number }>;
  const rules = redirects.filter((x) => x.destination.startsWith("https://xn--2lw665d.tw"));
  assertEquals(rules.length, 5);
  const regexes = rules.filter((x) => x.regex).map((x) => new RegExp(x.regex!));
  const hit = (p: string) => regexes.some((re) => re.test(p));
  assert(hit("/politician/0000b296-7ae8-4184-b704-c69d44cb696a.md"));
  assert(hit(`/election/2026/${enc("台南市")}.md`));
  assert(hit(`/category/${enc("交通建設")}.md`));
  assert(!hit("/politician/0000b296-7ae8-4184-b704-c69d44cb696a"));
  assert(!hit(`/election/2026/${enc("台南市")}`));
  assert(!hit("/election/2026/matrix"));
  assert(!hit("/skill.md"), "/skill.md 是 web.app 上的靜態檔，不轉");
  assert(rules.every((x) => x.type === 301));
  assert(rules.some((x) => x.source === "/data") && rules.some((x) => x.source === "/data/:rest*"), "/data/** 含 index.json 都轉");
  assertEquals("/politician/abc.md".match(regexes[0])![1], "abc.md");
});

Deno.test("data_md_cache：只開 SELECT 給 anon、沒有任何寫入政策；暫存表 anon 碰不到；欄位是 Worker 與排程腳本用的那幾個", async () => {
  const sql = await Deno.readTextFile(new URL("../../supabase/migrations/20261007180000_data_md_cache.sql", import.meta.url));
  assertStringIncludes(sql, "ENABLE ROW LEVEL SECURITY");
  assertStringIncludes(sql, "FOR SELECT USING (true)");
  assert(!/FOR\s+(INSERT|UPDATE|DELETE|ALL)/i.test(sql), "不得有寫入政策（寫入只經排程 workflow 的管理權杖）");
  assert(!/GRANT\s+(INSERT|UPDATE|DELETE|ALL)/i.test(sql), "不得把寫入權限給 anon／authenticated");
  assertStringIncludes(sql, "GRANT SELECT ON data_md_cache TO anon");
  assertStringIncludes(sql, "REVOKE ALL ON data_md_staging FROM anon, authenticated");
  assert(!/GRANT[^;]*data_md_staging/i.test(sql), "暫存表不給任何人");
  for (const col of ["path", "body", "meta", "row_count", "content_sha", "generated_at", "changed_at"]) assert(new RegExp(`\\n\\s+${col}\\s`).test(sql), `少了欄位 ${col}`);
  const script = await Deno.readTextFile(new URL("../../scripts/build-data-md.ts", import.meta.url));
  for (const col of ["path", "body", "meta", "row_count", "content_sha", "generated_at", "changed_at"]) assert(script.includes(col), `排程腳本沒用到 ${col}`);
  assertStringIncludes(script, "99-publish.sql", "一批一個交易換新");
  assertStringIncludes(script, "BEGIN;");
  assertStringIncludes(script, "COMMIT;");
  const worker = await Deno.readTextFile(new URL("../../cloudflare/ssr-worker.js", import.meta.url));
  assert(worker.includes("select=body,meta,generated_at,changed_at,content_sha,row_count"));
});

Deno.test("預產排程：每小時、用 CLI 管理權杖寫入，不碰 service_role；merge 後接在 CI 成功之後跑", async () => {
  const yml = await Deno.readTextFile(new URL("../../.github/workflows/data-md.yml", import.meta.url));
  assert(/cron:\s*'\d+ \* \* \* \*'/.test(yml), "每小時一次");
  assertStringIncludes(yml, "workflow_run");
  assertStringIncludes(yml, "SUPABASE_ACCESS_TOKEN");
  assertStringIncludes(yml, "supabase db query --linked");
  assert(!/secrets\.[A-Z_]*SERVICE_ROLE/i.test(yml), "不得用 service_role 金鑰");
});

Deno.test("政見矩陣頁要預渲染（內容頁可收錄，不能是 app.html 空殼）：路由、快照、建置清單、頁面本身都接好；不加 noindex", async () => {
  const read = (rel: string) => Deno.readTextFile(new URL(`../../${rel}`, import.meta.url));
  const router = await read("router/index.ts");
  assert(/path: '\/election\/:electionId\/matrix',\s*name: 'election-matrix'/.test(router), "路由名稱要是 election-matrix（page-data 的 case 靠它）");
  const pageData = await read("lib/ssg/page-data.ts");
  assert(pageData.includes("case 'election-matrix':") && pageData.includes("policyMatrix: full.policyMatrix"), "頁面快照要帶 policyMatrix");
  const serverData = await read("lib/ssg/server-data.ts");
  assert(serverData.includes("full.policyMatrix.election.segment}/matrix"), "建置要把矩陣頁放進預渲染清單（網站地圖也跟著有）");
  assert(serverData.includes("loadPolicyMatrix") && serverData.includes("data_md_cache"), "建置端讀預產快取表的 _matrix");
  assert(serverData.includes("isMissingRelation"), "表還沒建（migration 剛上）不能擋住整站建置");
  const page = await read("pages/PolicyMatrix.vue");
  assert(!/noindexs*:/.test(page), "矩陣頁可收錄");
  assert(page.includes("policyMatrix") && page.includes("ref<Matrix | null>(policyMatrix.value)"), "起手用快照的資料（HTML 裡才有數字）");
  // 表頭與格子是真連結（爬蟲看得到 .md 的網址），不是只有 click 的 button
  for (const needle of [":href=\"pickAll().path\"", ":href=\"pickRegion(r).path\"", ":href=\"pickCategory(c).path\"", ":href=\"pickCell(r, c).path\""]) assert(page.includes(needle), `矩陣頁少了真連結 ${needle}`);
  assert(page.includes("政見矩陣") && page.includes("pageTitle"), "標題是「<屆> 九合一政見矩陣」");
  const store = await read("composables/useSupabase.ts");
  assert(store.includes("policyMatrix.value = snapshot.policyMatrix ?? null"), "一頁一頁套快照，前一頁的矩陣不該留到下一頁");
});

// ───────── 範圍由「人」改為「政見」（維護者 2026-10-07；docs/PLAN-term-progress.md 3.1、3.4） ─────────

const VOTED = "2026-12-01"; // 投完票之後（落選者標「未當選」）

/** 範圍測試用的一組人與政見：每一種「在或不在資料集」的情形各一筆 */
function scopeCorpus() {
  const 甲 = person("甲現任連任", { elections: [rec({ electionType: "縣市長", subRegion: undefined })] });
  const 乙 = person("乙落選者", { elections: [rec({ candidacyStatus: "not_elected" })] });
  const 丙 = person("丙退選者", { elections: [rec({ candidacyStatus: "withdrawn" })] });
  const 丁 = person("丁沒參選的現任", { elections: [rec({ electionId: 2022, candidacyStatus: "elected", electionDate: "2022-11-26" })] });
  const policies: Policy[] = [
    policy(甲, "A 本屆競選承諾", { category: "交通建設" }), // 進資料集
    policy(甲, "E origin 是 pledge、status 已是推動中", { category: "交通建設", status: "In Progress" as never, origin: "pledge", progress: 30 }), // 擇一成立即算 → 進資料集
    policy(甲, "B 本屆（2026）屆別的任內政見", { category: "交通建設", status: "Proposed" as never }), // term_policy（2026）
    policy(甲, "C 2022 任內推動中", { category: "社會福利", status: "In Progress" as never, electionId: 2022 }), // term_policy（2022）
    policy(甲, "C2 2022 任內已實現", { category: "社會福利", status: "Achieved" as never, electionId: 2022 }), // term_policy（2022）
    policy(甲, "D 2022 競選承諾", { category: "社會福利", electionId: 2022 }), // other_election_pledge
    policy(甲, "F 沒屆別的承諾", { category: "其他", electionId: null as never }), // no_election
    policy(甲, "F2 沒屆別的任內政見", { category: "其他", status: "In Progress" as never, electionId: null as never }), // no_election（沒屆別先於任內）
    policy(甲, "G 類別對不上", { category: "不存在的類別" }), // category_not_listed
    policy(乙, "H 落選者的承諾", { category: "社會福利" }), // 進資料集，標未當選
    policy(丙, "I 退選者的承諾", { category: "社會福利" }), // owner_not_in_scope
    policy(丁, "J 沒參選的現任的 2026 承諾", { category: "社會福利" }), // owner_not_in_scope
  ];
  const regionCandidates = new Map();
  regionCandidates.set(regionCandidatesKey(2026, "台南市"), { candidates: [甲, 乙, 丙, 丁], truncated: false });
  const c: Corpus = { elections: [E2022, E2024, E2026], people: [甲, 乙, 丙, 丁], policies, regionCandidates, today: VOTED };
  return { c, policies, 甲, 乙 };
}

Deno.test("競選承諾：origin 是 pledge 或 status 是 Campaign Pledge，兩者擇一成立即算；其餘（推動中、已實現、提出）是任內政見", () => {
  assertEquals(isPledge({ status: "Campaign Pledge" as never, origin: null }), true);
  assertEquals(isPledge({ status: "In Progress" as never, origin: "pledge" }), true, "origin 成立、status 已是進度也算");
  assertEquals(isPledge({ status: "Campaign Pledge" as never, origin: "policy_address" }), true, "status 成立、origin 標別的也算（過渡期擇一）");
  assertEquals(isPledge({ status: "Proposed" as never, origin: null }), false);
  assertEquals(isPledge({ status: "Achieved" as never, origin: "assembly" }), false);
  assertEquals(pledgeCounts([{ status: "Campaign Pledge" as never }, { status: "Proposed" as never }, { status: "In Progress" as never, origin: "pledge" }]), { pledge: 2, term: 1 });
  assertEquals(pledgeCounts([]), { pledge: 0, term: 0 });
});

Deno.test("範圍：只收本屆、屬於本屆的競選承諾（擁有人在選）；落選者保留；任內政見、別屆承諾、退選者的不收", () => {
  const { c, policies } = scopeCorpus();
  const { pages, matrix, json } = buildAll(c, { generatedAt: NOW, sha: fakeSha });
  assert(matrix);
  const textOf = (path: string) => pages.find((p) => p.path === path)!.page.body.join("\n");
  const traffic = textOf("/data/2026/交通建設.md");
  assertStringIncludes(traffic, "A 本屆競選承諾");
  assertStringIncludes(traffic, "E origin 是 pledge、status 已是推動中");
  for (const out of ["B 本屆（2026）屆別的任內政見", "D 2022 競選承諾", "C 2022 任內推動中"]) assert(!traffic.includes(out), `${out} 不該在 2026 交通建設`);
  const welfare = textOf("/data/2026/社會福利.md");
  assertStringIncludes(welfare, "H 落選者的承諾");
  for (const out of ["C 2022 任內推動中", "C2 2022 任內已實現", "D 2022 競選承諾", "I 退選者的承諾", "J 沒參選的現任的 2026 承諾"]) assert(!welfare.includes(out), `${out} 不該在 2026 社會福利`);
  // 縣市頁（/election/2026/<縣市>.md ＝ /data/2026/<縣市>.md）同口徑：一樣沒有任內政見、別屆承諾
  const region = pages.find((p) => p.path === "/election/2026/台南市.md")!;
  const regionText = region.page.body.join("\n");
  assertStringIncludes(regionText, "H 落選者的承諾");
  for (const out of ["B 本屆（2026）屆別的任內政見", "C 2022 任內推動中", "D 2022 競選承諾", "F 沒屆別的承諾", "I 退選者的承諾"]) assert(!regionText.includes(out), `${out} 不該在縣市頁`);
  // 資料集 3 筆：A、E（交通建設）＋H（社會福利）；G（類別對不上）在縣市頁但不在分類與矩陣
  assertEquals(matrix.total, 3);
  assertEquals(matrix.regionTotals["台南市"], 3);
  assertEquals(region.page.rowCount, 4, "縣市頁多的那一筆是類別對不上的 G：它在 unassigned.category_not_listed，不在分類與矩陣");
  const idx = JSON.parse(json[0].body);
  assertEquals(idx.total_policies, 3);
  assertEquals(policies.length, 12);
});

Deno.test("範圍：落選者的承諾標「未當選」（不寫「落選」）", () => {
  const { c } = scopeCorpus();
  const { pages } = buildAll(c, { generatedAt: NOW, sha: fakeSha });
  const welfare = pages.find((p) => p.path === "/data/2026/社會福利.md")!.page.body.join("\n");
  assertStringIncludes(welfare, "2026 台南市議員・未當選");
  assert(!welfare.includes("・落選"));
  const regionText = pages.find((p) => p.path === "/election/2026/台南市.md")!.page.body.join("\n");
  assertStringIncludes(regionText, "未當選");
  assert(!regionText.includes("・落選"));
  assertEquals(scopeOf(person("x", { elections: [rec({ candidacyStatus: "not_elected" })] }), E2026, VOTED)?.label, "2026 台南市議員・未當選");
  assertEquals(scopeOf(person("y", { elections: [rec({ candidacyStatus: "elected" })] }), E2026, VOTED)?.label, "2026 台南市議員・當選");
});

Deno.test("不變式：每一條政見要嘛在資料集、要嘛在 unassigned（依原因），兩邊加起來剛好是全部；矩陣＝分類檔＝index.json 筆數一致", () => {
  const { c, policies } = scopeCorpus();
  const { pages, matrix, json } = buildAll(c, { generatedAt: NOW, sha: fakeSha });
  assert(matrix);
  const idx = JSON.parse(json[0].body);
  const inCategoryPages = pages.filter((p) => p.type === "category").reduce((n, p) => n + p.page.rowCount, 0);
  assertEquals(inCategoryPages + idx.unassigned.total, policies.length, "分類檔的筆數＋unassigned＝全部政見");
  assertEquals(matrix.total, inCategoryPages, "矩陣總數＝分類檔筆數加總");
  assertEquals(idx.total_policies, matrix.total);
  const cells = pages.filter((p) => p.type === "region_category").reduce((n, p) => n + p.page.rowCount, 0);
  assertEquals(cells, matrix.total, "縣市×分類的筆數加總＝矩陣總數");
  // 原因分類：每個原因的筆數與人工清點相符，互斥、沒有重複算
  assertEquals(idx.unassigned.reasons, { no_election: 2, term_policy: 3, other_election_pledge: 1, owner_not_in_scope: 2, category_not_listed: 1 });
  assertEquals(idx.unassigned.total, 9);
  assertEquals(idx.unassigned.term_policy_by_election, { "2022": 2, "2026": 1 }, "任內政見依屆別：2022 兩筆、2026 屆別（被放錯位置）一筆");
  assertEquals(idx.unassigned.other_election_pledge_by_election, { "2022": 1 }, "別屆的競選承諾依屆別");
  assertEquals(Object.keys(idx.unassigned.labels).sort(), [...UNASSIGNED_REASONS].sort());
  // 同一份分法直接對輸入驗：assigned ＋ unassigned ＝ 輸入，且 assigned 沒有重複
  const part = partitionPolicies({ election: E2026, policies, scopedIds: new Set(scopePeople(c.people, E2026, VOTED).map((s) => s.politician.id)), elections: c.elections });
  assertEquals(part.assigned.length + part.unassigned.total, policies.length);
  assertEquals(new Set(part.assigned.map((p) => p.id)).size, part.assigned.length);
});

Deno.test("buildAll 自己擋：資料集與 unassigned 對不起來（算法不一致）就丟錯，不產出「看起來完整、其實漏了」的快取", () => {
  // 分類檔算的筆數（lists.ts 的 hits）與分範圍算的筆數（pledge.ts 的 partitionPolicies）是兩處各算一次；buildAll 比對它們，不一致就丟錯
  const src = Deno.readTextFileSync(new URL("./dataset.ts", import.meta.url));
  assertStringIncludes(src, "分類頁筆數");
  assertStringIncludes(src, "資料集與 unassigned 加起來不等於全部政見");
  assertStringIncludes(src, "partitionPolicies(");
});

Deno.test("index.json：新增 kind、scope、overlaps、unassigned、changelog；既有欄位名一個不動", () => {
  const { pages, json } = buildAll(corpus(), { generatedAt: NOW, sha: fakeSha });
  const idx = JSON.parse(json[0].body);
  for (const k of ["format_version", "source", "index_md", "url", "election", "generated_at", "data_as_of", "license", "license_url", "total_policies", "files"]) assert(k in idx, `既有欄位 ${k} 不能少`);
  assertEquals(idx.kind, "pledge");
  assertEquals(idx.scope.kind, "pledge");
  assertEquals(idx.scope.election, "2026");
  assertEquals(idx.scope.version, SCOPE_VERSION);
  assertEquals(idx.overlaps, {});
  assertEquals(idx.changelog, ["2026-10-07 範圍由人改為政見"]);
  assertEquals(idx.changelog[0], CHANGELOG_SCOPE_BY_POLICY);
  assertEquals(typeof idx.unassigned.total, "number");
  assertEquals(Object.keys(idx.unassigned.reasons).sort(), [...UNASSIGNED_REASONS].sort());
  // 檔頭標題：2026 屆（九合一）競選承諾（不再是「在選候選人名下的政見」）
  const scopes = pages.map((p) => p.page.scope);
  for (const s of scopes.filter((x) => x.startsWith("2026 屆"))) assertStringIncludes(s, "競選承諾");
  assert(!scopes.some((s) => s.includes("在選候選人名下的政見")), "舊的範圍說法不再出現");
  assertStringIncludes(pages.find((p) => p.path === "/data/2026/交通建設.md")!.page.scope, "2026 屆（115年地方公職人員選舉）競選承諾；分類：交通建設");
});

Deno.test("預產快取：範圍版本算進內容雜湊，改範圍上線後第一次排程整批作廢重建", async () => {
  const script = await Deno.readTextFile(new URL("../../scripts/build-data-md.ts", import.meta.url));
  assertStringIncludes(script, "SCOPE_VERSION");
  assert(/const sha = \(o: unknown\) => createHash\('sha256'\)\.update\(JSON\.stringify\(\{ scope: SCOPE_VERSION, o \}\)\)/.test(script), "sha 要把 SCOPE_VERSION 算進去，每一列的雜湊才會跟舊範圍的不同");
  assert(SCOPE_VERSION >= 2, "改範圍就加版本號（這次是 2）");
});

Deno.test("首頁：只放筆數、不放比例；追蹤中政見拆成「競選承諾」「任內政見」兩個數字；舊的達成率與寫死的數字都不在", async () => {
  const home = await Deno.readTextFile(new URL("../../pages/Home.vue", import.meta.url));
  const from = home.indexOf("data-testid=\"home-stats\"");
  const to = home.indexOf("熱門議題稽核分佈");
  assert(from > 0 && to > from, "找得到首頁統計區");
  const stats = home.slice(from, to);
  assertStringIncludes(stats, "data-stat=\"pledge-policies\"");
  assertStringIncludes(stats, "data-stat=\"term-policies\"");
  assertStringIncludes(stats, "競選承諾");
  assertStringIncludes(stats, "任內政見");
  assert(!stats.includes("追蹤中政見"), "「追蹤中政見」已拆成兩個數字");
  assert(!stats.includes("達成率") && !stats.includes("executed-rate"), "首頁不放達成率");
  assert(!/%/.test(stats), "首頁統計區沒有任何百分比");
  assert(!home.includes("executedAchievementRate"), "達成率的計算也一併拿掉");
  assert(!/\b964\b/.test(home), "舊建置快照的 964 不能寫死在首頁");
  assertStringIncludes(home, "pledgeCounts(policies.value)");
  assertStringIncludes(home, "from '../lib/pledge-origin'");
});

Deno.test("矩陣頁：只放筆數，不放比例", async () => {
  const page = await Deno.readTextFile(new URL("../../pages/PolicyMatrix.vue", import.meta.url));
  // 只看畫面（<template>），不含底下的 <style>（抽屜裡 .md 預覽的 CSS 有 100% 這種寬度）
  const tpl = page.slice(page.indexOf("<template>"), page.lastIndexOf("</template>"));
  assert(!/%|比例|達成率|占比|佔比/.test(tpl), "矩陣頁的畫面沒有百分比或比例");
});
