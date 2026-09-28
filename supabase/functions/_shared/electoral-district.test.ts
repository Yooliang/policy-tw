import { assertEquals } from "jsr:@std/assert";
import { normalizeDistrict } from "./electoral-district.ts";

Deno.test("normalizeDistrict：阿拉伯數字，含個位數補零", () => {
  assertEquals(normalizeDistrict("第4選區"), { region: null, district: "第04選舉區" });
  assertEquals(normalizeDistrict("第4選舉區"), { region: null, district: "第04選舉區" });
});

Deno.test("normalizeDistrict：阿拉伯數字已經是兩位數／有多餘空白", () => {
  assertEquals(normalizeDistrict("第 04 選舉區"), { region: null, district: "第04選舉區" });
  assertEquals(normalizeDistrict("第04選舉區"), { region: null, district: "第04選舉區" });
});

Deno.test("normalizeDistrict：中文數字，個位數", () => {
  assertEquals(normalizeDistrict("第四選區"), { region: null, district: "第04選舉區" });
  assertEquals(normalizeDistrict("第九選舉區"), { region: null, district: "第09選舉區" });
});

Deno.test("normalizeDistrict：中文數字，十幾、整十、二十幾、三十幾", () => {
  assertEquals(normalizeDistrict("第十選舉區"), { region: null, district: "第10選舉區" });
  assertEquals(normalizeDistrict("第十一選舉區"), { region: null, district: "第11選舉區" });
  assertEquals(normalizeDistrict("第二十選舉區"), { region: null, district: "第20選舉區" });
  assertEquals(normalizeDistrict("第二十一選舉區"), { region: null, district: "第21選舉區" });
  assertEquals(normalizeDistrict("第三十選舉區"), { region: null, district: "第30選舉區" });
  assertEquals(normalizeDistrict("第三十九選舉區"), { region: null, district: "第39選舉區" });
});

Deno.test("normalizeDistrict：帶縣市字首，含臺/台混用", () => {
  assertEquals(normalizeDistrict("新北市第4選舉區"), { region: "新北市", district: "第04選舉區" });
  assertEquals(normalizeDistrict("臺中市第4選舉區"), { region: "台中市", district: "第04選舉區" });
});

Deno.test("normalizeDistrict：帶括號補充說明的鄉鎮區名，不影響解析", () => {
  assertEquals(normalizeDistrict("臺北市第6選區(大安文山)議員候選人"), {
    region: "台北市",
    district: "第06選舉區",
  });
  assertEquals(normalizeDistrict("台北市第六選舉區（大安、文山）"), {
    region: "台北市",
    district: "第06選舉區",
  });
  assertEquals(normalizeDistrict("第八選舉區（樹林、鶯歌、土城、三峽）"), {
    region: null,
    district: "第08選舉區",
  });
});

Deno.test("normalizeDistrict：縣市＋議員候選人字樣夾在中間", () => {
  assertEquals(normalizeDistrict("新竹市議員第1選舉區候選人"), { region: "新竹市", district: "第01選舉區" });
  assertEquals(normalizeDistrict("新竹市議員第7選舉區候選人"), { region: "新竹市", district: "第07選舉區" });
});

Deno.test("normalizeDistrict：找不到「第…選(舉)?區」樣式回傳 null", () => {
  assertEquals(normalizeDistrict("縣市議員候選人"), null);
  assertEquals(normalizeDistrict("縣市議員候選人（山地原住民）"), null);
  assertEquals(normalizeDistrict(""), null);
});

Deno.test("normalizeDistrict：第0選區不是合法選區，回傳 null", () => {
  assertEquals(normalizeDistrict("第0選舉區"), null);
});
