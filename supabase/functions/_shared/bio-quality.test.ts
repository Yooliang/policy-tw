/**
 * 人物簡介品質判定（#975）。
 *   a. 真實壞例子（查證過程寫進 bio）命中；三個好例子不命中
 *   b. 各類規則各有代表句；問題清單附句子（截 100 字）
 *   c. bioOf：politician 取 bio、correction 取改 bio 那一項、其他型別不判
 *   d. precheck 的票：supported 的來源核對 ＋ 壞簡介 → not_supported；好簡介不動；Jev 說 not_intro 過門檻才算
 *   e. 接線：precheck 真的用到啟發式（拿掉就紅）
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { applyBioVerdict, BIO_QUESTION, bioJudgePrompt, bioOf, bioProblems, bioQuestion, bioVerdict } from "./bio-quality.ts";
import { aggregateFieldVerdicts } from "./system-one.ts";

const BAD = "新北市新店區香坡里第 5 屆里長選舉候選人。我用 pdftotext -bbox-layout 核過該列的里名，中選會候選人查詢 API 查其姓名回 0 筆。115 年選舉公報尚未發布，公開來源未載其出生年、學歷與照片，故這三項留空不填。";
const GOOD = [
  "新北市新店區香坡里第 5 屆里長選舉候選人（1 號，無黨籍），115 年 9 月 3 日完成候選人登記。",
  "現任台中市議員，曾任台中市政府專員、立法委員助理。",
  "無黨籍，曾任○○里長兩屆",
];

Deno.test("a. 真實壞例子命中、好例子不命中", () => {
  const p = bioProblems(BAD);
  assert(p.length >= 2, `壞例子要多句命中（${p.length}）`);
  for (const g of GOOD) assertEquals(bioProblems(g), [], g);
  assertEquals(bioProblems(""), []);
});

Deno.test("b. 各類規則各有代表句；句子截 100 字", () => {
  for (const s of [
    "資料取自 PyMuPDF 抽字", "用 curl 抓過", "來源是 JSON 檔", "檔名 3f9a8c7d1b2e4f60aa11.pdf",
    "搜尋了多個網站", "搜了一下", "第 3 頁有寫", "查詢結果為空", "該列回 0 筆", "學歷查無", "出生年未載", "照片留空", "學歷不填",
    "公報尚未發布故不填", "此為驗證者要看的任務", "politician_id 對不上", "依交件內容",
  ]) assert(bioProblems(s).length > 0, s);
  const long = `我用工具查過${"很長的敘述".repeat(30)}`;
  const [one] = bioProblems(long);
  assert(one.includes("…") && one.length < 160, one);
});

Deno.test("c. bioOf：politician、correction 改 bio、其他不判", () => {
  assertEquals(bioOf("politician", { name: "甲", bio: "現任議員" }), "現任議員");
  assertEquals(bioOf("politician", { name: "甲" }), null);
  assertEquals(bioOf("correction", { changes: [{ field: "party", correct_value: "無黨籍" }, { field: "bio", correct_value: "曾任里長" }] }), "曾任里長");
  assertEquals(bioOf("correction", { field: "bio", correct_value: "曾任里長" }), "曾任里長");
  assertEquals(bioOf("correction", { changes: [{ field: "party", correct_value: "x" }] }), null);
  assertEquals(bioOf("policy", { bio: "x" }), null);
});

const supportedVote = () => {
  const claim = { name: "甲", party: "無黨籍" };
  const answers = { "field:name": { choice: "confirmed", probabilities: { confirmed: 0.99 } }, "field:party": { choice: "confirmed", probabilities: { confirmed: 0.99 } } };
  const agg = aggregateFieldVerdicts("politician", claim, answers as never);
  return { choice: agg.choice as string, probability: agg.probability };
};

Deno.test("d. 壞簡介把 supported 的票改成 not_supported；好簡介不動", () => {
  const base = supportedVote();
  assertEquals(base.choice, "supported");
  const bad = applyBioVerdict(base, bioVerdict(BAD));
  assertEquals([bad.choice, bad.probability], ["not_supported", 1]);
  assertEquals(applyBioVerdict(base, bioVerdict(GOOD[0])), base);
  assertEquals(applyBioVerdict(base, bioVerdict(null)), base);
});

Deno.test("d. Jev 的判定：not_intro 過門檻才算，intro 與低機率不動", () => {
  const ok = bioVerdict(GOOD[0], { choice: "not_intro", probabilities: { not_intro: 0.97 } });
  assertEquals([ok?.choice, ok?.source], ["not_supported", "jev"]);
  assertEquals(bioVerdict(GOOD[0], { choice: "not_intro", probabilities: { not_intro: 0.8 } }), null);
  assertEquals(bioVerdict(GOOD[0], { choice: "intro", probabilities: { intro: 0.99 } }), null);
  assertEquals(bioVerdict(GOOD[0], undefined), null);
  const q = bioQuestion();
  assertEquals(Object.keys(q.criteria).sort(), ["intro", "not_intro"]);
  assert(q.instructions === bioJudgePrompt() && bioJudgePrompt().includes("我怎麼查"));
});

Deno.test("e. 接線：precheck 先跑啟發式、再把 Jev 的題目併進同一次呼叫（還原驗證：拿掉就紅）", async () => {
  const src = await Deno.readTextFile(new URL("../system-one/index.ts", import.meta.url));
  assert(src.includes("bioVerdict(bio)"), "precheck 要先用啟發式判簡介");
  assert(src.includes("[BIO_QUESTION]: bioQuestion()"), "沒命中時要問 Jev");
  assert(src.includes("applyBioVerdict(vote"), "Jev 的判定要併進票");
  // 啟發式本身被拿掉（永遠不命中）時，壞例子就不再是 not_supported
  const neutered = (bio: string) => (bio ? null : null);
  assertEquals(applyBioVerdict(supportedVote(), neutered(BAD)).choice, "supported");
  assertEquals(applyBioVerdict(supportedVote(), bioVerdict(BAD)).choice, "not_supported");
});
