/**
 * 正見.tw Worker 的縣市頁／鄉鎮頁網址規則（region-path.js）。
 *
 * 守三件事：
 *   1. 舊網址（?region=、?sub=）一律 301 到路徑版，一次到底、其他參數不丟——舊連結不能壞（2026-10-05 常設裁決）。
 *   2. 中文網址 → web.app 上的 ASCII 檔案路徑；已經是 ASCII 的不碰（不然會轉兩次）。
 *   3. postbuild 從檔案路徑算回來的對外網址，要跟站內連結、canonical 是同一個字串——不然網站地圖列的網址打不開。
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  fromHex,
  legacyRegionRedirect,
  regionFilePath,
  regionPublicPathOfFile,
  regionUpstreamPath,
  toHex,
  townshipFilePath,
} from "./region-path.js";

const enc = encodeURIComponent;
const q = (s: string) => new URLSearchParams(s);
/** 301 的目標，解碼後比對比較好讀 */
const redirect = (path: string, search: string) => {
  const to = legacyRegionRedirect(path, q(search));
  return to === null ? null : decodeURIComponent(to);
};

Deno.test("縣市頁上的 ?sub=鄉鎮 → 鄉鎮頁（301）", () => {
  assertEquals(redirect(`/election/2022/${enc("嘉義縣")}`, `sub=${enc("大林鎮")}`), "/election/2022/嘉義縣/大林鎮");
  // 直轄市的區、原住民區
  assertEquals(redirect(`/election/2022/${enc("高雄市")}`, `sub=${enc("三民區")}`), "/election/2022/高雄市/三民區");
  assertEquals(redirect(`/election/2022/${enc("高雄市")}`, `sub=${enc("那瑪夏區")}`), "/election/2022/高雄市/那瑪夏區");
  // 尾斜線也收
  assertEquals(redirect(`/election/2022/${enc("嘉義縣")}/`, `sub=${enc("大林鎮")}`), "/election/2022/嘉義縣/大林鎮");
});

Deno.test("目標網址是 percent-encoded，跟站內連結同一種寫法", () => {
  assertEquals(
    legacyRegionRedirect(`/election/2022/${enc("嘉義縣")}`, q(`sub=${enc("大林鎮")}`)),
    `/election/2022/${enc("嘉義縣")}/${enc("大林鎮")}`,
  );
});

Deno.test("村里、頁籤等其他參數照帶，sub 拿掉", () => {
  assertEquals(
    redirect(`/election/2022/${enc("嘉義縣")}`, `sub=${enc("大林鎮")}&village=${enc("中坑里")}&view=pledges`),
    "/election/2022/嘉義縣/大林鎮?village=中坑里&view=pledges",
  );
});

Deno.test("更舊的 ?region=&sub= 一次轉到鄉鎮頁，不先轉縣市頁", () => {
  assertEquals(redirect("/election/2022", `region=${enc("嘉義縣")}&sub=${enc("大林鎮")}`), "/election/2022/嘉義縣/大林鎮");
  assertEquals(
    redirect("/election/2026/", `region=${enc("台北市")}&sub=${enc("信義區")}&view=comparison&type=${enc("縣市議員")}`),
    "/election/2026/台北市/信義區?view=comparison&type=縣市議員",
  );
});

Deno.test("只有 ?region= 照舊轉縣市頁（2026-09-30 的規則不變）", () => {
  assertEquals(redirect("/election/2026", `region=${enc("台北市")}`), "/election/2026/台北市");
  assertEquals(redirect("/election/2026", `region=${enc("台北市")}&view=pledges`), "/election/2026/台北市?view=pledges");
});

Deno.test("sub 不像鄉鎮名就不放進路徑：縣市頁上不轉，?region= 照轉縣市、sub 留在 query", () => {
  for (const sub of ["All", "", "第01選舉區", "abc", "大林", "那瑪夏區第01選舉區"]) {
    assertEquals(redirect(`/election/2022/${enc("嘉義縣")}`, `sub=${enc(sub)}`), null, sub);
  }
  assertEquals(redirect("/election/2022", `region=${enc("嘉義縣")}&sub=All`), "/election/2022/嘉義縣?sub=All");
});

Deno.test("內政部鄉鎮名的各種長相都認得（2～4 字、臺、鄉鎮市區）", () => {
  for (const town of ["東區", "北區", "大林鎮", "臺西鄉", "霧臺鄉", "臺東市", "阿里山鄉", "太麻里鄉", "那瑪夏區", "三地門鄉"]) {
    assertEquals(redirect(`/election/2022/${enc("嘉義縣")}`, `sub=${enc(town)}`), `/election/2022/嘉義縣/${town}`, town);
  }
});

Deno.test("不是縣市的、已經是鄉鎮頁的、沒帶 sub 的都不轉", () => {
  assertEquals(redirect(`/election/2022/${enc("嘉義縣")}`, ""), null);
  assertEquals(redirect(`/election/2022/${enc("嘉義縣")}/${enc("大林鎮")}`, `sub=${enc("民雄鄉")}`), null);
  assertEquals(redirect(`/election/2022/${enc("某某")}`, `sub=${enc("大林鎮")}`), null);
  assertEquals(redirect("/election/2022", `sub=${enc("大林鎮")}`), null);
  assertEquals(redirect("/election/2022", `region=All&sub=${enc("大林鎮")}`), null);
  assertEquals(redirect(`/politician/${enc("嘉義縣")}`, `sub=${enc("大林鎮")}`), null);
  // 壞掉的 percent-encoding 不丟例外
  assertEquals(redirect("/election/2022/%E5%98", `sub=${enc("大林鎮")}`), null);
});

Deno.test("中文鄉鎮頁 → web.app 上的 ASCII 檔案路徑（在縣市頁目錄底下）", () => {
  assertEquals(
    regionUpstreamPath(`/election/2022/${enc("嘉義縣")}/${enc("大林鎮")}`),
    `/election/2022/_r/${toHex("嘉義縣")}/${toHex("大林鎮")}`,
  );
  assertEquals(regionUpstreamPath(`/election/2022/${enc("嘉義縣")}/${enc("大林鎮")}/`), townshipFilePath(2022, "嘉義縣", "大林鎮"));
  assertEquals(townshipFilePath(2022, "嘉義縣", "大林鎮").startsWith(`${regionFilePath(2022, "嘉義縣")}/`), true);
});

Deno.test("縣市頁的對應不變", () => {
  assertEquals(regionUpstreamPath(`/election/2026/${enc("台北市")}`), `/election/2026/_r/${toHex("台北市")}`);
  assertEquals(regionUpstreamPath("/election/2026"), null);
});

Deno.test("已經是 ASCII 的路徑不再轉（不然 _r 會被轉兩次）", () => {
  assertEquals(regionUpstreamPath(`/election/2022/_r/${toHex("嘉義縣")}`), null);
  assertEquals(regionUpstreamPath(`/election/2022/_r/${toHex("嘉義縣")}/${toHex("大林鎮")}`), null);
  assertEquals(regionUpstreamPath(`/election/2022/${enc("嘉義縣")}/abc`), null);
  assertEquals(regionUpstreamPath("/election/2022/%E5%98/%E5%A4"), null);
});

Deno.test("檔案路徑算回對外網址：跟站內連結同一個字串（網站地圖、canonical 比對用）", () => {
  assertEquals(
    regionPublicPathOfFile(townshipFilePath(2022, "嘉義縣", "大林鎮")),
    `/election/2022/${enc("嘉義縣")}/${enc("大林鎮")}`,
  );
  assertEquals(regionPublicPathOfFile(regionFilePath(2026, "台北市")), `/election/2026/${enc("台北市")}`);
  assertEquals(regionPublicPathOfFile("/election/2022"), null);
  assertEquals(regionPublicPathOfFile("/politician/abc"), null);
});

Deno.test("一路走一圈：舊網址 301 → 新網址 → ASCII 檔案 → 算回同一個新網址", () => {
  for (const [county, town] of [["嘉義縣", "大林鎮"], ["高雄市", "那瑪夏區"], ["高雄市", "三民區"], ["台東縣", "臺東市"], ["連江縣", "南竿鄉"]]) {
    const moved = legacyRegionRedirect(`/election/2022/${enc(county)}`, q(`sub=${enc(town)}`))!;
    const file = regionUpstreamPath(moved)!;
    assertEquals(regionPublicPathOfFile(file), moved, `${county}${town}`);
    assertEquals(fromHex(toHex(town)), town);
  }
});
