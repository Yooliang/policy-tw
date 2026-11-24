import { assertEquals } from "jsr:@std/assert@1";
import { COLLAPSE_CHAR_THRESHOLD, needsCollapse, segmentText, splitParagraphs } from "./rich-text.ts";

Deno.test("segmentText：網址變成只顯示網域的連結，href 保留原址，括號與標點不吃進網址", () => {
  assertEquals(segmentText("依報導（https://news.ltn.com.tw/news/politics/breakingnews/5561200）所載"), [
    { type: "text", text: "依報導（" },
    { type: "link", href: "https://news.ltn.com.tw/news/politics/breakingnews/5561200", label: "news.ltn.com.tw" },
    { type: "text", text: "）所載" },
  ]);
  assertEquals(segmentText("見 https://www.cna.com.tw/a/1, 與 http://eebulletin.cec.gov.tw/x.pdf。"), [
    { type: "text", text: "見 " },
    { type: "link", href: "https://www.cna.com.tw/a/1", label: "cna.com.tw" },
    { type: "text", text: ", 與 " },
    { type: "link", href: "http://eebulletin.cec.gov.tw/x.pdf", label: "eebulletin.cec.gov.tw" },
    { type: "text", text: "。" },
  ]);
  assertEquals(segmentText("沒有網址"), [{ type: "text", text: "沒有網址" }]);
  assertEquals(segmentText(null), []);
});

Deno.test("splitParagraphs：依中文序號、數字括號序號與換行分段", () => {
  assertEquals(splitParagraphs("總結如下。一、第一點內容。二、第二點內容；三、第三點"), ["總結如下。", "一、第一點內容。", "二、第二點內容；", "三、第三點"]);
  assertEquals(splitParagraphs("說明：1)甲項。2)乙項。(3)丙項"), ["說明：", "1)甲項。", "2)乙項。", "(3)丙項"]);
  assertEquals(splitParagraphs("第一行\r\n\r\n第二行\n第三行"), ["第一行", "第二行", "第三行"]);
});

Deno.test("splitParagraphs：沒有序號的句子不亂切，空值回空陣列", () => {
  assertEquals(splitParagraphs("共 2) 個項目與一、二個例子"), ["共 2) 個項目與一、二個例子"]);
  assertEquals(splitParagraphs("單純一段話，沒有序號。"), ["單純一段話，沒有序號。"]);
  assertEquals(splitParagraphs(""), []);
  assertEquals(splitParagraphs(undefined), []);
});

Deno.test("needsCollapse：以畫面字數為準，剛好門檻不收、超過才收，網址只算網域", () => {
  assertEquals(needsCollapse("字".repeat(COLLAPSE_CHAR_THRESHOLD)), false);
  assertEquals(needsCollapse("字".repeat(COLLAPSE_CHAR_THRESHOLD + 1)), true);
  assertEquals(needsCollapse("字".repeat(COLLAPSE_CHAR_THRESHOLD - 30) + " https://news.ltn.com.tw/" + "a".repeat(200)), false);
  assertEquals(needsCollapse(null), false);
});
