import { assertEquals } from "jsr:@std/assert@1";
import { classifyWard } from "./ward-classification.ts";

Deno.test("縣轄鄉鎮市一律是 rural，不管有沒有原住民區候選人", () => {
  assertEquals(classifyWard({ isSpecialMunicipality: false, hasIndigenousRace: false }), "rural");
  assertEquals(classifyWard({ isSpecialMunicipality: false, hasIndigenousRace: true }), "rural");
});

Deno.test("直轄市的區：有原住民區長／代表候選人就是 indigenous", () => {
  assertEquals(classifyWard({ isSpecialMunicipality: true, hasIndigenousRace: true }), "indigenous");
});

Deno.test("直轄市的區：沒有原住民區長／代表候選人就是 plain（官派）", () => {
  assertEquals(classifyWard({ isSpecialMunicipality: true, hasIndigenousRace: false }), "plain");
});
