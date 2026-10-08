import { assert, assertEquals } from "jsr:@std/assert@1";
import { isJpDate, isPrefectureCode, JP_DATE_MAX_YEAR, JP_DATE_MIN_YEAR, lgCodeValid, lgPrefCode } from "./lg-code.ts";
import { isJpOfficialSource, jpSourceKind } from "./source-kind.ts";

// SQL 版（policy_jp.lg_code_valid／lg_pref_code／source_kind_for_url）的逐一對齊在 policy-jp-apply.test.ts（PGlite）；這裡是純函式的行為

Deno.test("lgCodeValid：真的團體碼（北海道・札幌市・渋谷区・一宮市・長野県・小諸市・沖縄県）都過", () => {
  for (const c of ["010006", "011002", "131130", "232033", "200000", "202088", "470007"]) assert(lgCodeValid(c), c);
});

Deno.test("lgCodeValid：檢查碼錯、長度不對、非數字、非字串都不過", () => {
  for (const c of ["010007", "232034", "131131", "01000", "0100060", "01000a", "０１０００６", " 010006", "", "abcdef"]) assert(!lgCodeValid(c), JSON.stringify(c));
  for (const c of [10006, null, undefined, {}, ["010006"]]) assert(!lgCodeValid(c), String(c));
});

Deno.test("lgCodeValid：每個真碼只有一個檢查碼是對的（0～9 試一遍）", () => {
  for (const base of ["01000", "23203", "13113", "20208"]) {
    const valid = Array.from({ length: 10 }, (_, d) => `${base}${d}`).filter(lgCodeValid);
    assertEquals(valid.length, 1, base);
  }
});

Deno.test("lgPrefCode：前 2 碼＋000＋檢查碼；都道府県自己是自己的縣市碼；格式不對回 null", () => {
  assertEquals(lgPrefCode("232033"), "230006");
  assertEquals(lgPrefCode("011002"), "010006");
  assertEquals(lgPrefCode("131130"), "130001");
  assertEquals(lgPrefCode("230006"), "230006");
  assertEquals(lgPrefCode("200000"), "200000");
  for (const c of ["", "23203", "2320333", "23203x"]) assertEquals(lgPrefCode(c), null, c);
  for (let p = 1; p <= 47; p++) {
    const pref = lgPrefCode(`${String(p).padStart(2, "0")}1000`)!;
    assert(lgCodeValid(pref) && isPrefectureCode(pref), pref);
  }
});

Deno.test("isPrefectureCode：第 3～5 碼是 000", () => {
  assert(isPrefectureCode("230006") && isPrefectureCode("010006"));
  assert(!isPrefectureCode("232033") && !isPrefectureCode("011002"));
});

Deno.test("isJpDate：形狀、真的有這一天、年份 1947～2100（含邊界）", () => {
  assertEquals([JP_DATE_MIN_YEAR, JP_DATE_MAX_YEAR], [1947, 2100]);
  for (const ok of ["1947-01-01", "1947-12-31", "2027-01-24", "2028-02-29", "2100-01-01", "2100-12-31"]) assert(isJpDate(ok), ok);
  for (const bad of ["0000-01-01", "0001-01-01", "1946-12-31", "2101-01-01", "9999-12-31", "2027-02-30", "2027-02-29", "2027-13-01", "2027-00-10", "2027/01/24", "2027-1-24", "", "令和9年", 20270124, null, undefined]) {
    assert(!isJpDate(bad), String(bad));
  }
  assert(!isJpDate("2100-02-29"), "2100 年不是閏年");
});

Deno.test("jpSourceKind：統計／公的／その他（総務省は regional_stat のとき統計）", () => {
  assertEquals(jpSourceKind("https://www.e-stat.go.jp/x"), "statistics");
  assertEquals(jpSourceKind("https://dashboard.e-stat.go.jp/"), "statistics");
  assertEquals(jpSourceKind("https://www.stat.go.jp/data/"), "statistics");
  assertEquals(jpSourceKind("https://www.soumu.go.jp/denshijiti/code.html"), "official");
  assertEquals(jpSourceKind("https://www.soumu.go.jp/denshijiti/code.html", "local_government"), "official");
  assertEquals(jpSourceKind("https://www.soumu.go.jp/iken/kessan_jokyo_2.html", "regional_stat"), "statistics");
  assertEquals(jpSourceKind("https://www.pref.aichi.lg.jp/"), "official");
  assertEquals(jpSourceKind("https://www.city.ichinomiya.aichi.jp/"), "official");
  assertEquals(jpSourceKind("https://www.town.togo.aichi.jp/"), "official");
  assertEquals(jpSourceKind("https://www.vill.toyone.aichi.jp/"), "official");
  assertEquals(jpSourceKind("https://www.kantei.go.jp/"), "official");
  for (const u of ["https://ja.wikipedia.org/wiki/x", "https://www.asahi.com/a", "https://twitter.com/city_x", "https://evil-stat.go.jp.example.com/", "ftp://www.soumu.go.jp/", "not a url", ""]) {
    assertEquals(jpSourceKind(u, "regional_stat"), "other", u);
    assert(!isJpOfficialSource(u, "regional_stat"), u);
  }
  assertEquals(jpSourceKind("HTTPS://WWW.E-STAT.GO.JP/a"), "statistics", "大文字でも同じ");
  assertEquals(jpSourceKind("https://www.soumu.go.jp:8443/a", "regional_stat"), "statistics", "ポートは無視");
  assert(isJpOfficialSource("https://www.e-stat.go.jp/x") && isJpOfficialSource("https://www.city.ichinomiya.aichi.jp/"));
});
