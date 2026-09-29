import { assertEquals } from "jsr:@std/assert@1";
import { sourcesForTask, verifySourceQuery, type VerificationSource } from "./verification-sources.ts";

// 2026-09-29：苗栗縣議員 candidacy 一小時 28 張「無法判斷」——驗證者不知道中選會登記彙總表已經在網路上
const base = { kind: "cec", party: null, detail_url_pattern: null, access: "pdf", quality_note: "", how_to: "", last_checked: null, status: "ok" };
const sources = [
  { ...base, id: 1, name: "六都登記彙總表", regions: ["台北市"], election_types: ["縣市議員"], provides: ["candidacy", "roster"], list_url: "https://web.cec.gov.tw/api/file/a.pdf", sort: 5 },
  { ...base, id: 2, name: "16 縣市登記彙總表", regions: ["苗栗縣"], election_types: ["縣市議員"], provides: ["candidacy", "roster"], list_url: "https://web.cec.gov.tw/api/file/b.pdf", sort: 5 },
  { ...base, id: 3, name: "政黨頁", kind: "party", regions: null, election_types: null, provides: ["photo", "policy"], list_url: "https://x", sort: 10 },
] as unknown as VerificationSource[];

Deno.test("驗證 candidacy：附上該縣市的中選會登記彙總表", () => {
  const q = verifySourceQuery("candidacy", { region: "苗栗縣", election_type: "縣市議員", election_id: 2026 });
  const hints = sourcesForTask(sources, q!);
  assertEquals(hints[0]?.url, "https://web.cec.gov.tw/api/file/b.pdf");
  assertEquals(hints.some((h) => h.url === "https://web.cec.gov.tw/api/file/a.pdf"), false, "別的縣市的名冊不要附");
});

Deno.test("驗證項目：payload 沒縣市就用人物的；更正類不附", () => {
  assertEquals(verifySourceQuery("candidacy", { election_type: "縣市議員" }, { region: "苗栗縣" })?.region, "苗栗縣");
  assertEquals(verifySourceQuery("correction", { region: "苗栗縣" }), null);
});
