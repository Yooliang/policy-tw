// 內政部地方公職人員名單解析（2026-09-24）：用實際頁面前兩位當樣本
import { assert, assertEquals } from "jsr:@std/assert@1";
import { moiNorm, parseMoiList } from "./moi-officials.ts";

Deno.test("解析內政部名單：姓名、縣市、機關、職稱、黨籍、照片、詳細頁", async () => {
  const html = await Deno.readTextFile(new URL("./fixtures/moi-list-sample.html", import.meta.url));
  const rows = parseMoiList(html, "KND0001");
  assert(rows.length >= 2, `至少兩位，實際 ${rows.length}`);
  const first = rows[0];
  assertEquals(first.name, "戴錫欽");
  assertEquals(first.region, "臺北市");
  assertEquals(first.region_norm, "台北市");
  assertEquals(first.org, "臺北市議會");
  assertEquals(first.title, "議長");
  assertEquals(first.party, "中國國民黨");
  assert(first.photo_url?.startsWith("https://ws.moi.gov.tw/"), "照片網址");
  assert(first.detail_url?.includes("_PARENT_ID=ER11112AA00029"), "詳細頁");
  assertEquals(first.id, "ER11112AA00029");
});

Deno.test("姓名正規化跟 SQL 的 moi_norm 一致：去全形空白、臺→台", () => {
  assertEquals(moiNorm("戴　錫欽"), "戴錫欽");
  assertEquals(moiNorm("臺北市"), "台北市");
  assertEquals(moiNorm(""), null);
});
