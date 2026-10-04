// 鄉鎮市長／代表／村里長／原住民區長、區民代表的參選紀錄指到 regions（2026-10-04）
import { assertEquals } from "jsr:@std/assert@1";
import { LOCAL_ELECTION_TYPES, localRegionKey } from "./apply-contribution.ts";
import { ELECTION_TYPES } from "./contribution-schema.ts";

Deno.test("五種地方選舉都是協議認得的 election_type", () => {
  for (const t of LOCAL_ELECTION_TYPES) assertEquals((ELECTION_TYPES as readonly string[]).includes(t), true, t);
});

Deno.test("鄉鎮市長：縣市＋鄉鎮市區，村里留空", () => {
  assertEquals(localRegionKey("鄉鎮市長", { region: "屏東縣", sub_region: "東港鎮" }), { region: "屏東縣", sub_region: "東港鎮", village: null });
});

Deno.test("村里長：一定要有村里，沒有就不指", () => {
  assertEquals(localRegionKey("村里長", { region: "新北市", sub_region: "板橋區", village: "留侯里" }), { region: "新北市", sub_region: "板橋區", village: "留侯里" });
  assertEquals(localRegionKey("村里長", { region: "新北市", sub_region: "板橋區" }), null);
});

Deno.test("縣市議員不走這條（另有 districtRegionPatch）；選舉區字樣不當鄉鎮", () => {
  assertEquals(localRegionKey("縣市議員", { region: "台中市", sub_region: "西屯區" }), null);
  assertEquals(localRegionKey("鄉鎮市民代表", { region: "彰化縣", sub_region: "第01選舉區" }), null);
  assertEquals(localRegionKey("鄉鎮市長", { region: "彰化縣" }), null);
});
