import { assertEquals } from "jsr:@std/assert@1";
import { hostOf, shortUrlsIn } from "./url.ts";

Deno.test("hostOf：只留網域、去 www；解析不出來就原樣", () => {
  assertEquals(hostOf("https://www.cec.gov.tw/central/cms/115"), "cec.gov.tw");
  assertEquals(hostOf("https://news.ltn.com.tw/news/politics/breakingnews/5561200"), "news.ltn.com.tw");
  assertEquals(hostOf("cec.gov.tw 選舉公報"), "cec.gov.tw 選舉公報");
});

// 2026-09-19：內文也會出現網址，統一過濾
Deno.test("shortUrlsIn：內文裡的網址縮成網域，其餘文字不動；中文標點與括號不會被吃進網址", () => {
  assertEquals(shortUrlsIn("依自由時報報導（https://news.ltn.com.tw/news/politics/breakingnews/5561200）所載"), "依自由時報報導（news.ltn.com.tw）所載");
  assertEquals(shortUrlsIn("來源：https://www.cna.com.tw/news/aipl/202601210171 與 http://web.cec.gov.tw/x.pdf。"), "來源：cna.com.tw 與 web.cec.gov.tw。");
  assertEquals(shortUrlsIn("沒有網址的句子"), "沒有網址的句子");
  assertEquals(shortUrlsIn(null), "");
});
