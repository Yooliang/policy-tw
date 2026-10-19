import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { comparisonMarkdown, escapeCell } from "./comparison-markdown.ts";

const base = {
  title: "縣市長", year: 2026, region: "嘉義縣", pageUrl: "https://xn--example/election/2026?view=comparison&type=縣市長",
  dataDate: "2026-10-18",
  candidates: [{ candNo: 2, name: "王二", party: "甲黨" }, { candNo: 1, name: "張三", party: "乙黨" }],
  rows: [{ label: "交通建設", cells: ["**捷運**", "公車"] }],
};

Deno.test("表頭有號次、姓名、政黨，標題有年份與地區", () => {
  const md = comparisonMarkdown(base);
  assertStringIncludes(md, "# 2026 年 嘉義縣 縣市長：政見並排比較");
  assertStringIncludes(md, "| 類別 | 2號 王二（甲黨） | 1號 張三（乙黨） |");
  assertStringIncludes(md, "| --- | --- | --- |");
  assertStringIncludes(md, "| 交通建設 | **捷運** | 公車 |");
});

Deno.test("沒有號次不印號，沒有政黨不印括號", () => {
  const md = comparisonMarkdown({ ...base, candidates: [{ name: "王二" }, { candNo: null, name: "張三", party: " " }], rows: [] });
  assertStringIncludes(md, "| 類別 | 王二 | 張三 |");
});

Deno.test("儲存格的 | 跳脫、換行變 <br>", () => {
  assertEquals(escapeCell("a|b\nc\r\nd"), "a\\|b<br>c<br>d");
  const md = comparisonMarkdown({ ...base, rows: [{ label: "A|B", cells: ["x|y\nz", "ok"] }] });
  assertStringIncludes(md, "| A\\|B | x\\|y<br>z | ok |");
});

Deno.test("空格子、缺的格子、空白字串都寫「—」", () => {
  assertEquals(escapeCell(""), "—");
  assertEquals(escapeCell("  \n "), "—");
  assertEquals(escapeCell(null), "—");
  const md = comparisonMarkdown({ ...base, rows: [{ label: "社福", cells: [""] }] });
  assertStringIncludes(md, "| 社福 | — | — |");
});

Deno.test("結尾有出處網址、資料日期與 CC BY 4.0", () => {
  const md = comparisonMarkdown(base);
  assertStringIncludes(md, `資料來源：正見（正見.tw）${base.pageUrl} （資料更新：2026-10-18）`);
  assertStringIncludes(md, "CC BY 4.0");
  assertStringIncludes(md, "https://creativecommons.org/licenses/by/4.0/");
  assert(md.endsWith("\n"));
});

Deno.test("沒有資料日期就不印更新括號；標題已含職位不重複", () => {
  const md = comparisonMarkdown({ ...base, dataDate: null, title: "縣市議員・第08選舉區", office: "縣市議員" });
  assert(!md.includes("資料更新"));
  assertStringIncludes(md, "# 2026 年 嘉義縣 縣市議員・第08選舉區：政見並排比較");
});
