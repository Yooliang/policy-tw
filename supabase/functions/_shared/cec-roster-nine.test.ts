// 2026-10-08：中選會 115 年候選人登記彙總表九份（web.cec.gov.tw/central/article/64709）全部解析得出來
//
// 村里長、鄉鎮市長、區長、各種代表的版面沒有「選舉區」欄（地名是「縣市鄉鎮」或「縣市鄉鎮 村里」），
// 名字還常被空白拆開（族語姓名）、黨名被換行拆開。fixtures 是 cecRosterText（unpdf 0.12.1 mergePages）對正式網址抽出來的原文
// （注意：不是 pdftotext 的輸出——不加 -enc UTF-8 會整段變空白，姓名全掉）；
// 期望人數是每份 PDF 裡「登記日期」的個數——一列一位，日期數就是候選人數，解析出的人數必須逐份相等。
import { assert, assertEquals } from "jsr:@std/assert@1";
import { CEC_ROSTER_URL_RE, checkBatch, parseRoster, type RosterRow } from "./cec-roster.ts";

const NINE = [
  { file: "cec-roster-2026-municipal-mayor.txt", label: "直轄市長", expected: 23 },
  { file: "cec-roster-2026-municipal-council.txt", label: "直轄市議員", expected: 610 },
  { file: "cec-roster-2026-county-mayor.txt", label: "縣市長", expected: 58 },
  { file: "cec-roster-2026-county-council.txt", label: "縣市議員", expected: 892 },
  { file: "cec-roster-2026-indigenous-chief.txt", label: "直轄市山地原住民區長", expected: 16 },
  { file: "cec-roster-2026-indigenous-rep.txt", label: "直轄市山地原住民區民代表", expected: 94 },
  { file: "cec-roster-2026-township-mayor.txt", label: "鄉鎮市長", expected: 465 },
  { file: "cec-roster-2026-township-rep.txt", label: "鄉鎮市民代表", expected: 3437 },
  { file: "cec-roster-2026-village.txt", label: "村里長", expected: 14100 },
] as const;
const readFixture = (f: string) => Deno.readTextFile(new URL(`./fixtures/${f}`, import.meta.url));
const parsed = new Map<string, RosterRow[]>();
for (const n of NINE) parsed.set(n.file, parseRoster(await readFixture(n.file)));
const rowsOf = (file: string) => parsed.get(file)!;

Deno.test("九份登記彙總表：解析出的人數等於 PDF 的登記日期列數（一列一位），合計 19,695", async () => {
  let total = 0;
  for (const n of NINE) {
    const text = await readFixture(n.file);
    const dates = (text.match(/\d{3}\/\d{2}\/\d{2}/g) ?? []).length;
    assertEquals(dates, n.expected, `${n.label}：fixture 的日期數跟已知的列數不一樣（fixture 被動過？）`);
    assertEquals(rowsOf(n.file).length, dates, `${n.label}：解析 ${rowsOf(n.file).length} 位，PDF 有 ${dates} 列`);
    total += dates;
  }
  assertEquals(total, 19695);
  assertEquals(rowsOf("cec-roster-2026-township-mayor.txt").length, 465);
  assertEquals(rowsOf("cec-roster-2026-village.txt").length, 14100);
});

Deno.test("九份：每一列都認得出縣市與政黨；姓名欄在 PDF 裡本來就是空的才會沒有姓名（21 列，罕用字抽不出來）", () => {
  let nameless = 0;
  for (const n of NINE) {
    for (const r of rowsOf(n.file)) {
      assert(r.region, `${n.label}：有一列認不出縣市 ${JSON.stringify(r)}`);
      assert(r.party, `${n.label}：有一列沒有政黨 ${JSON.stringify(r)}`);
      if (!r.name) nameless++;
    }
  }
  assertEquals(nameless, 21);
});

Deno.test("村里長：沒有選舉區欄，地名是「鄉鎮市區＋村里」；22 縣市都有", () => {
  const rows = rowsOf("cec-roster-2026-village.txt");
  assertEquals(rows.filter((r) => r.district).length, 0);
  // 地名都在；其中 6 列 PDF 自己的村里欄是空的（罕用字抽不出來），只剩「大安區」「安南區」這樣的鄉鎮市區
  assert(rows.every((r) => /[區鄉鎮市]/.test(r.place ?? "")));
  assertEquals(rows.filter((r) => /[里村]/.test(r.place ?? "")).length, rows.length - 6);
  assertEquals(rows[0], { name: "周政諭", party: "中國國民黨", region: "台北市", district: null, place: "松山區莊敬里" });
  assertEquals(new Set(rows.map((r) => r.region)).size, 22);
});

Deno.test("鄉鎮市長：地名是縣市＋鄉鎮市，沒有選舉區；族語姓名只留中文", () => {
  const rows = rowsOf("cec-roster-2026-township-mayor.txt");
  assertEquals(rows.filter((r) => r.district).length, 0);
  assertEquals(rows[0], { name: "李貞秀", party: "無", region: "新竹縣", district: null, place: "竹北市" });
  assert(rows.some((r) => r.place === "三地門鄉" && r.name === "車牧勒薩以‧拉勒格安"), "族語姓名只留中文部分、拼音略過");
});

Deno.test("鄉鎮市民代表、區民代表：有選舉區，鄉鎮與選舉區分開記", () => {
  const rep = rowsOf("cec-roster-2026-township-rep.txt");
  assertEquals(rep[0], { name: "張美珠", party: "無", region: "新竹縣", district: "第01選舉區", place: "竹北市" });
  // 金門等「某某鄉鎮選舉區」不編號：選舉區看不出來（null），但鄉鎮要在
  const kinmen = rep.find((r) => r.name === "鄭天才")!;
  assertEquals([kinmen.region, kinmen.district, kinmen.place], ["金門縣", null, "金城鎮"]);
  const ind = rowsOf("cec-roster-2026-indigenous-rep.txt");
  assertEquals(ind[0], { name: "高建章", party: "無", region: "新北市", district: "第01選舉區", place: "烏來區" });
  assertEquals(ind.filter((r) => r.district).length, 94);
});

Deno.test("區長：族語姓名只留中文、被空白拆開的姓名接回來", () => {
  const rows = rowsOf("cec-roster-2026-indigenous-chief.txt");
  assertEquals(rows.map((r) => r.name).slice(11, 15), ["杜司偉", "陳德福", "張志誠", "伊斯坦大·貝雅夫·正福"]);
});

Deno.test("姓名裡有「年」不會被當成頁首吃掉（謝昌年），也不會讓那一列整個少掉", () => {
  const r = rowsOf("cec-roster-2026-county-council.txt").find((x) => x.name === "謝昌年");
  assertEquals([r?.region, r?.district, r?.party], ["苗栗縣", "第02選舉區", "無"]);
});

Deno.test("換頁重印的欄名「推薦之政黨」（以黨結尾）不會被當成政黨、也不會黏進上一位的姓名", () => {
  for (const n of NINE) {
    for (const r of rowsOf(n.file)) {
      assert(r.party !== "推薦之政黨" && !r.name.includes("推薦之政黨"), `${n.label}：欄名被當成資料 ${JSON.stringify(r)}`);
    }
  }
});

Deno.test("黨名被換行拆開（小民參政歐巴桑 聯盟、天宙和平統一家 庭黨、中國國家社會 主義勞工黨）：政黨接回完整、姓名不被多吃", () => {
  const all = NINE.flatMap((n) => rowsOf(n.file));
  const byName = (name: string) => all.find((r) => r.name === name);
  assertEquals(byName("李惠暄")?.party, "小民參政歐巴桑聯盟");
  assertEquals(byName("林聖峰")?.party, "天宙和平統一家庭黨");
  assertEquals(byName("梁志宇")?.party, "中國國家社會主義勞工黨");
  assertEquals(byName("吳建智咖啡哥")?.party, "親民黨"); // 姓名被拆成兩塊、黨名是完整的
});

Deno.test("整批核對：鄉鎮市長、村里長也能逐位核（姓名／縣市／政黨），縣市或政黨寫錯會被抓出來", () => {
  const r = checkBatch([...rowsOf("cec-roster-2026-township-mayor.txt"), ...rowsOf("cec-roster-2026-village.txt")], [
    { id: "m1", name: "邱臣遠", party: "台灣民眾黨", region: "新竹縣" },
    { id: "v1", name: "周政諭", party: "中國國民黨", region: "臺北市" },
    { id: "m2", name: "邱臣遠", party: "中國國民黨", region: "新竹縣" },
    { id: "m3", name: "邱臣遠", party: "台灣民眾黨", region: "苗栗縣" },
  ]);
  assertEquals(r.passed.sort(), ["m1", "v1"]);
  assertEquals(r.failed.map((f) => f.id).sort(), ["m2", "m3"]);
});

Deno.test("舊版面（日期在前、選舉區在後、性別、出生年月日、學歷）仍走逐欄配對，人數不變", async () => {
  // 嘉義縣：日期 選舉區 姓名 性別 政黨 受理機關；宜蘭縣：選舉區 日期 姓名 性別 出生年月日 政黨 學歷
  assertEquals(parseRoster(await readFixture("cec-roster-2026-chiayi-county.txt")).length, 53);
  assertEquals(parseRoster(await readFixture("cec-roster-2026-yilan-county.txt")).length, 59);
});

// ── 查證來源：九份名冊都要登錄（verification_sources），任務與驗證都是靠它附名冊網址 ──
// 鄉鎮市長、鄉鎮市民代表、區長、區民代表、村里長五份由 20261008111000 登錄；regions 必須等於那份 PDF 裡真的有人的縣市
Deno.test("查證來源 migration：五份名冊的選舉別、縣市、選舉區欄、網址都跟 PDF 解析結果一致", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20261008111000_cec_roster_sources_rest.sql", import.meta.url));
  const CASES = [
    { file: "cec-roster-2026-township-mayor.txt", name: "中選會 2026 鄉鎮市長候選人登記彙總表", type: "鄉鎮市長", url: "a7b4f3d3-dad3-4e61-9036-2cd21cf29d92" },
    { file: "cec-roster-2026-township-rep.txt", name: "中選會 2026 鄉鎮市民代表候選人登記彙總表", type: "鄉鎮市民代表", url: "437a9da7-eaa7-47b9-9571-789eeb48ed18" },
    { file: "cec-roster-2026-indigenous-chief.txt", name: "中選會 2026 直轄市山地原住民區長候選人登記彙總表", type: "直轄市山地原住民區長", url: "1278f66e-1d15-4ecf-aeeb-9ea5cba61f00" },
    { file: "cec-roster-2026-indigenous-rep.txt", name: "中選會 2026 直轄市山地原住民區民代表候選人登記彙總表", type: "直轄市山地原住民區民代表", url: "f3b665f2-6f0b-485f-a1eb-17d152849317" },
    { file: "cec-roster-2026-village.txt", name: "中選會 2026 村里長候選人登記彙總表", type: "村里長", url: "f1abbda2-229b-4a02-8dfb-58beb3ceca61" },
  ];
  const list = (s: string) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const c of CASES) {
    const at = sql.indexOf(`'${c.name}', 'cec', NULL,`);
    assert(at >= 0, `${c.name}：migration 沒有這一列`);
    const m = /ARRAY\[([^\]]*)\],\s*ARRAY\[([^\]]*)\],\s*ARRAY\[([^\]]*)\],\s*'(https:[^']+)'/.exec(sql.slice(at));
    assert(m, `${c.name}：讀不出 regions／election_types／provides／list_url`);
    const [regions, types, provides, url] = [list(m[1]), list(m[2]), list(m[3]), m[4]];
    const rows = rowsOf(c.file);
    assertEquals([...regions].sort(), [...new Set(rows.map((r) => r.region!))].sort(), `${c.name}：regions 要等於 PDF 裡有人的縣市`);
    assertEquals(types, [c.type]);
    assertEquals(url, `https://web.cec.gov.tw/api/file/${c.url}.pdf`);
    assert(CEC_ROSTER_URL_RE.test(url));
    assert(provides.includes("roster") && provides.includes("candidacy"));
    // 有選舉區欄的（代表）才宣稱 district；村里長、各種首長沒有
    assertEquals(provides.includes("district"), rows.some((r) => r.district), `${c.name}：provides 的 district 要跟版面一致`);
  }
});
