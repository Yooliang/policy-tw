import { assert, assertEquals } from "jsr:@std/assert@1";
import { APPOINTED_EMPTY_TEXT, isAppointedDistrict } from "./appointed-district.ts";

const base = { isSpecialMunicipality: true, indigenousDistricts: ["烏來區"], repKeys: ["65000010"], countyCode: "65", townCode: null, sameName: (a: string, b: string) => a === b };

Deno.test("直轄市一般區派任：大安區灰、烏來區不灰、縣市層級不灰、一般縣不灰", () => {
  assert(isAppointedDistrict({ ...base, sub: "大安區", indigenousDistricts: [], repKeys: [] }));
  assert(!isAppointedDistrict({ ...base, sub: "烏來區" }));
  assert(!isAppointedDistrict({ ...base, sub: "All" }));
  assert(!isAppointedDistrict({ ...base, sub: "大安區", isSpecialMunicipality: false }));
  assert(!isAppointedDistrict({ ...base, sub: "大安區", indigenousDistricts: [], repKeys: ["63000010"], townCode: "63000010" }));
  assertEquals(APPOINTED_EMPTY_TEXT, "市政府派任，無此類選舉");
});

Deno.test("ElectionPage 用 isAppointedDistrict 讓兩個分頁變灰（手機分頁條與桌面層級清單）", () => {
  const page = Deno.readTextFileSync(new URL("../pages/ElectionPage.vue", import.meta.url));
  assert(page.includes("isAppointedDistrict(") && page.includes("APPOINTED_EMPTY_TEXT"));
  assert(/dim: appointedTabs\.value\.has\(t\)/.test(page));
});
