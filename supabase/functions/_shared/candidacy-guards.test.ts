import { assertEquals } from "jsr:@std/assert@1";
import { dateInUrl, reasonNamesTarget, registrationEvidenceOk } from "./candidacy-guards.ts";

// 2026-10-01：reason 寫陳瑩、target_id 填成陳見賢那筆，通過投票，陳見賢被改成已登記
Deno.test("更正參選紀錄：reason 要寫出被改的人名", () => {
  assertEquals(reasonNamesTarget("打開中選會登記彙總表，確認陳瑩在臺東縣候選人名單上", "陳見賢"), false);
  assertEquals(reasonNamesTarget("中選會登記彙總表有陳瑩，臺東縣，民主進步黨", "陳瑩"), true);
  assertEquals(reasonNamesTarget("名冊上寫 瓦力司．比尤", "瓦力司‧比尤"), true, "原住民名的間隔點寫法不同也算");
  assertEquals(reasonNamesTarget("任何理由", "林"), true, "單字名不檢查");
});

// 2026-10-01：拿政黨 4 月的造勢新聞把陳琬惠改成 confirmed，但 9/4 截止時她沒登記
Deno.test("登記截止後標已登記：要中選會來源或截止後的報導", () => {
  const today = "2026-10-01";
  assertEquals(registrationEvidenceOk(["https://www.tpp.org.tw/newsdetail/4556"], 2026, today), false, "政黨新聞稿、網址沒日期");
  assertEquals(registrationEvidenceOk(["https://web.cec.gov.tw/api/file/370f3bbf.pdf"], 2026, today), true);
  assertEquals(registrationEvidenceOk(["https://www.cna.com.tw/news/aipl/202609045002.aspx"], 2026, today), true, "中央社截止日當天的名單");
  assertEquals(registrationEvidenceOk(["https://www.ettoday.net/news/20260415/1.htm"], 2026, today), false, "截止前的報導");
  assertEquals(registrationEvidenceOk(["https://x.example/a"], 2026, "2026-08-01"), true, "還沒截止不擋");
  assertEquals(registrationEvidenceOk(["https://x.example/a"], 2022, today), true, "沒登記截止日的屆別不擋");
});

Deno.test("網址裡的日期", () => {
  assertEquals(dateInUrl("https://www.cna.com.tw/news/aipl/202609045002.aspx"), "2026-09-04");
  assertEquals(dateInUrl("https://x.tw/2026/9/15/abc"), "2026-09-15");
  assertEquals(dateInUrl("https://news.ltn.com.tw/news/politics/breakingnews/5499400"), null);
});
