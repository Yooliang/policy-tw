import { assertEquals } from "jsr:@std/assert@1";
import {
  DEFAULT_TASK_SOURCE_NEED,
  matchSources,
  needsForTask,
  queryVerificationSources,
  sortSources,
  sourceMatches,
  sourcesForTask,
  sourcesToMarkdown,
  type VerificationSource,
} from "./verification-sources.ts";

function src(overrides: Partial<VerificationSource>): VerificationSource {
  return {
    id: 1,
    name: "測試來源",
    kind: "party",
    party: null,
    regions: null,
    election_types: null,
    provides: ["photo"],
    list_url: "https://example.com/list",
    detail_url_pattern: null,
    access: "html",
    quality_note: null,
    how_to: null,
    last_checked: "2026-09-28",
    status: "ok",
    sort: 10,
    ...overrides,
  };
}

Deno.test("party 為 null 代表不分政黨，任何 query 都符合", () => {
  const s = src({ party: null });
  assertEquals(sourceMatches(s, { party: "台灣民眾黨" }), true);
  assertEquals(sourceMatches(s, {}), true);
});

Deno.test("party 有指定值時，query 的政黨要相符才算", () => {
  const s = src({ party: "台灣民眾黨" });
  assertEquals(sourceMatches(s, { party: "台灣民眾黨" }), true);
  assertEquals(sourceMatches(s, { party: "民主進步黨" }), false);
  // 沒指定政黨查詢時不篩掉
  assertEquals(sourceMatches(s, {}), true);
});

Deno.test("regions 為 null 代表全國；有指定要 query 的縣市在陣列裡才符合", () => {
  const national = src({ regions: null });
  assertEquals(sourceMatches(national, { region: "台北市" }), true);

  const sixCities = src({ regions: ["台北市", "新北市"] });
  assertEquals(sourceMatches(sixCities, { region: "台北市" }), true);
  assertEquals(sourceMatches(sixCities, { region: "屏東縣" }), false);
  // 沒指定縣市時不篩掉
  assertEquals(sourceMatches(sixCities, {}), true);
});

Deno.test("election_types 同 regions 的邏輯", () => {
  const s = src({ election_types: ["縣市議員"] });
  assertEquals(sourceMatches(s, { electionType: "縣市議員" }), true);
  assertEquals(sourceMatches(s, { electionType: "縣市長" }), false);
  assertEquals(sourceMatches(s, {}), true);
});

Deno.test("need 沒給就全部符合；有給要跟 provides 有交集", () => {
  const s = src({ provides: ["photo", "education"] });
  assertEquals(sourceMatches(s, {}), true);
  assertEquals(sourceMatches(s, { need: [] }), true);
  assertEquals(sourceMatches(s, { need: ["education"] }), true);
  assertEquals(sourceMatches(s, { need: ["policy"] }), false);
  assertEquals(sourceMatches(s, { need: ["policy", "education"] }), true);
});

Deno.test("matchSources：多筆一起篩，四個條件都要過", () => {
  const a = src({ id: 1, party: "台灣民眾黨", regions: null, provides: ["photo"] });
  const b = src({ id: 2, party: "民主進步黨", regions: ["台北市"], provides: ["district"] });
  const c = src({ id: 3, party: null, regions: null, provides: ["policy"] });
  const out = matchSources([a, b, c], { party: "台灣民眾黨", need: ["photo", "policy"] });
  assertEquals(out.map((s) => s.id), [1, 3]);
});

Deno.test("sortSources：status=down 一律排最後，其餘照 sort 遞增", () => {
  const a = src({ id: 1, sort: 30, status: "ok" });
  const b = src({ id: 2, sort: 10, status: "down" });
  const c = src({ id: 3, sort: 20, status: "ok" });
  const sorted = sortSources([a, b, c]);
  assertEquals(sorted.map((s) => s.id), [3, 1, 2]);
});

Deno.test("queryVerificationSources：篩選後一樣套用排序（down 最後）", () => {
  const a = src({ id: 1, sort: 5, status: "down", provides: ["photo"] });
  const b = src({ id: 2, sort: 1, status: "ok", provides: ["photo"] });
  const out = queryVerificationSources([a, b], { need: ["photo"] });
  assertEquals(out.map((s) => s.id), [2, 1]);
});

Deno.test("needsForTask：登記過的任務型別回對應清單，沒登記過的回預設值", () => {
  assertEquals(needsForTask("profile_gap"), ["photo", "education", "experience", "birth_year"]);
  assertEquals(needsForTask("policy_missing"), ["policy"]);
  assertEquals(needsForTask("roster_check"), ["candidacy", "district", "roster"]);
  assertEquals(needsForTask("某種手動任務"), DEFAULT_TASK_SOURCE_NEED);
});

Deno.test("sourcesForTask：最多回 limit 筆，形狀是給代理看的精簡版", () => {
  const rows = Array.from({ length: 10 }, (_, i) => src({ id: i, sort: i, name: `來源 ${i}`, provides: ["policy"] }));
  const out = sourcesForTask(rows, { need: ["policy"] });
  assertEquals(out.length, 6);
  assertEquals(Object.keys(out[0]).sort(), ["how_to", "name", "provides", "quality_note", "url"]);
});

Deno.test("sourcesForTask：有 detail_url_pattern 就給它，沒有才退回 list_url", () => {
  const withDetail = src({ id: 1, name: "有個人頁的來源", list_url: "https://a.example/list", detail_url_pattern: "https://a.example/detail?id=<id>" });
  const withoutDetail = src({ id: 2, name: "只有列表頁的來源", list_url: "https://b.example/list", detail_url_pattern: null });
  const out = sourcesForTask([withDetail, withoutDetail], {});
  assertEquals(out.find((s) => s.name === withDetail.name)?.url, "https://a.example/detail?id=<id>");
  assertEquals(out.find((s) => s.name === withoutDetail.name)?.url, "https://b.example/list");
});

Deno.test("sourcesForTask：撈不到（空清單）就回空陣列，不噴錯", () => {
  assertEquals(sourcesForTask([], { party: "隨便" }), []);
});

Deno.test("sourcesToMarkdown：依 kind 分組，內容含中文欄位標籤", () => {
  const party = src({ id: 1, kind: "party", name: "甲政黨候選人頁", party: "甲政黨", provides: ["photo", "policy"] });
  const cec = src({ id: 2, kind: "cec", name: "中選會 API", party: null, provides: ["birth_year"] });
  const md = sourcesToMarkdown([party, cec]);
  assertEquals(md.includes("## 政黨"), true);
  assertEquals(md.includes("## 中選會"), true);
  assertEquals(md.includes("甲政黨候選人頁"), true);
  assertEquals(md.includes("照片"), true);
  assertEquals(md.includes("出生年"), true);
});

Deno.test("sourcesToMarkdown：status=down 的來源要標示打不開", () => {
  const down = src({ id: 1, name: "壞掉的來源", status: "down" });
  const md = sourcesToMarkdown([down]);
  assertEquals(md.includes("壞掉的來源（目前打不開）"), true);
});
