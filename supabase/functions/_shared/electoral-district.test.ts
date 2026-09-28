import { assertEquals } from "jsr:@std/assert";
import { isCouncilAboriginalDistrict, normalizeCandidacyDistrictField, normalizeDistrict } from "./electoral-district.ts";

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

// ── normalizeCandidacyDistrictField：交件時統一縣市議員候選人的選區寫法 ──────────────

Deno.test("normalizeCandidacyDistrictField：election_type 不是縣市議員就不動 electoral_district", () => {
  const p: Record<string, unknown> = { election_type: "縣市長", electoral_district: "第4選區" };
  normalizeCandidacyDistrictField(p);
  assertEquals(p.electoral_district, "第4選區");
});

Deno.test("normalizeCandidacyDistrictField：有給 electoral_district 就正規化寫回去", () => {
  const p: Record<string, unknown> = { election_type: "縣市議員", electoral_district: "第4選區" };
  normalizeCandidacyDistrictField(p);
  assertEquals(p.electoral_district, "第04選舉區");
});

Deno.test("normalizeCandidacyDistrictField：electoral_district 正規化不出來就原樣留著", () => {
  const p: Record<string, unknown> = { election_type: "縣市議員", electoral_district: "山地原住民" };
  normalizeCandidacyDistrictField(p);
  assertEquals(p.electoral_district, "山地原住民");
});

Deno.test("normalizeCandidacyDistrictField：沒給 electoral_district，從 position 抽出來填，position 原樣保留", () => {
  const p: Record<string, unknown> = { election_type: "縣市議員", position: "台北市議員第6選舉區候選人" };
  normalizeCandidacyDistrictField(p);
  assertEquals(p.electoral_district, "第06選舉區");
  assertEquals(p.position, "台北市議員第6選舉區候選人");
});

Deno.test("normalizeCandidacyDistrictField：沒給 electoral_district、position 也抽不出來就不動", () => {
  const p: Record<string, unknown> = { election_type: "縣市議員", position: "縣市議員候選人" };
  normalizeCandidacyDistrictField(p);
  assertEquals(p.electoral_district, undefined);
});

Deno.test("normalizeCandidacyDistrictField：有給 electoral_district 時不會去看 position（electoral_district 優先）", () => {
  const p: Record<string, unknown> = { election_type: "縣市議員", electoral_district: "第2選舉區", position: "台北市議員第6選舉區候選人" };
  normalizeCandidacyDistrictField(p);
  assertEquals(p.electoral_district, "第02選舉區");
});

// ── isCouncilAboriginalDistrict：原住民保留議席常數 ──────────────

Deno.test("isCouncilAboriginalDistrict：已查證的縣市與號碼回 true", () => {
  assertEquals(isCouncilAboriginalDistrict("台北市", "第07選舉區"), true);
  assertEquals(isCouncilAboriginalDistrict("台北市", "第08選舉區"), true);
  assertEquals(isCouncilAboriginalDistrict("彰化縣", "第09選舉區"), true, "既有的平地原住民席次");
  assertEquals(isCouncilAboriginalDistrict("彰化縣", "第10選舉區"), true, "2026 新增的山地原住民席次");
  assertEquals(isCouncilAboriginalDistrict("雲林縣", "第07選舉區"), true);
  assertEquals(isCouncilAboriginalDistrict("雲林縣", "第08選舉區"), true);
});

Deno.test("isCouncilAboriginalDistrict：一般選區號碼回 false", () => {
  assertEquals(isCouncilAboriginalDistrict("台北市", "第06選舉區"), false);
});

Deno.test("isCouncilAboriginalDistrict：沒有列在常數裡的縣市回 false（不是說它沒有保留議席，是還沒查證）", () => {
  assertEquals(isCouncilAboriginalDistrict("屏東縣", "第09選舉區"), false);
});
