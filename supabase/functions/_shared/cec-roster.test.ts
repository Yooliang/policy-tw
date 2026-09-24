// 中選會登記名冊逐位核對（2026-09-24）：用實際的直轄市議員名冊（unpdf 抽出的文字）與 wang.shihchieh 交的台中市 181 筆
import { assert, assertEquals } from "jsr:@std/assert@1";
import { CEC_ROSTER_URL_RE, checkBatch, parseRoster } from "./cec-roster.ts";

const text = await Deno.readTextFile(new URL("./fixtures/cec-roster-2026-municipal-council.txt", import.meta.url));
const batch = (JSON.parse(await Deno.readTextFile(new URL("./fixtures/roster-batch-taichung.json", import.meta.url))) as Array<{ name: string; party: string; region: string }>)
  .map((b, i) => ({ id: `c${i}`, ...b }));

// 實際案例：wang.shihchieh 當成「台中市議員」交的 181 位，名冊上 90 位是台中、86 位是台南、3 位是高雄，2 位找不到。
// 逐筆投票擋不住這種錯（驗證者打開同一份名冊，名字確實在上面）——這正是逐位核對的價值。
Deno.test("整批核對：抓出被標錯縣市的 89 位（86 台南、3 高雄），2 位找不到，政黨不符 0 位", () => {
  const rows = parseRoster(text);
  assert(rows.length > 500, `名冊應解析出 500 位以上，實際 ${rows.length}`);
  const r = checkBatch(rows, batch);
  assertEquals(r.passed.length, 90);
  assertEquals(r.failed.filter((f) => f.reason.includes("台南市")).length, 86);
  assertEquals(r.failed.filter((f) => f.reason.includes("高雄市")).length, 3);
  assertEquals(r.failed.filter((f) => f.reason.includes("找不到")).length, 2);
  assertEquals(r.failed.filter((f) => f.reason.includes("政黨")).length, 0);
});

Deno.test("政黨或縣市寫錯的會被抓出來", () => {
  const rows = parseRoster(text);
  const one = batch.find((b) => b.party === "民主進步黨")!;
  const wrongParty = checkBatch(rows, [{ id: "x", name: one.name, party: "中國國民黨", region: one.region }]);
  assertEquals(wrongParty.passed.length, 0);
  const wrongRegion = checkBatch(rows, [{ id: "y", name: one.name, party: one.party, region: "新竹縣" }]);
  assertEquals(wrongRegion.passed.length, 0);
});

Deno.test("只收中選會名冊網址", () => {
  assert(CEC_ROSTER_URL_RE.test("https://web.cec.gov.tw/api/file/ccd7e51a-5fd0-4ea0-a81b-a120cd550c9c.pdf"));
  assert(!CEC_ROSTER_URL_RE.test("https://example.com/a.pdf"));
});

// 縣市議員名冊格式不同（09-24 嘉義縣）：日期 選舉區 姓名 性別 政黨 受理機關——性別與「某某選舉委員會」不能當成姓名
Deno.test("縣市議員名冊（多性別、受理機關欄）也解析得出來，姓名配對政黨正確", async () => {
  const t2 = await Deno.readTextFile(new URL("./fixtures/cec-roster-2026-chiayi-county.txt", import.meta.url));
  const rows = parseRoster(t2);
  assert(rows.length >= 50, `嘉義縣名冊 53 人，實際解析 ${rows.length}`);
  const r = checkBatch(rows, [
    { id: "a", name: "江佩曄", party: "民主進步黨", region: "嘉義縣" },
    { id: "b", name: "詹琬蓁", party: "中國國民黨", region: "嘉義縣" },
    { id: "c", name: "賴瓊如", party: "無黨籍", region: "嘉義縣" },
    { id: "d", name: "江佩曄", party: "中國國民黨", region: "嘉義縣" },
  ]);
  assertEquals(r.passed.sort(), ["a", "b", "c"]);
  assertEquals(r.failed.map((f) => f.id), ["d"]);
});

// 宜蘭縣名冊（09-24）：選舉區被換行拆成「第1選舉 區」，多出生年月日與學歷兩欄
Deno.test("宜蘭縣格式（選舉區拆行、出生年月日、學歷）也解析得出來", async () => {
  const t3 = await Deno.readTextFile(new URL("./fixtures/cec-roster-2026-yilan-county.txt", import.meta.url));
  const rows = parseRoster(t3);
  assert(rows.length >= 50, `宜蘭縣名冊約 60 人，實際解析 ${rows.length}`);
  const r = checkBatch(rows, [
    { id: "a", name: "林麗", party: "民主進步黨", region: "宜蘭縣" },
    { id: "b", name: "劉仲書", party: "時代力量", region: "宜蘭縣" },
    { id: "c", name: "黃光佑", party: "無黨籍", region: "宜蘭縣" },
    { id: "d", name: "林岳賢", party: "民主進步黨", region: "宜蘭縣" },
  ]);
  assertEquals(r.passed.sort(), ["a", "b", "c"]);
  assertEquals(r.failed.map((f) => f.id), ["d"]);
});
