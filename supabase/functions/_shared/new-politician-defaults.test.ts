import { assertEquals } from "jsr:@std/assert@1";
import { newPoliticianDefaults } from "./candidate-import.ts";

Deno.test("沒帶 position／region：從 current_position 與 bio 的縣市推（5835103a 張愉婕）", () => {
  assertEquals(
    newPoliticianDefaults({ current_position: "縣市議員候選人", bio: "彰化縣第4選舉區縣市議員候選人（中國國民黨）。" }),
    { position: "縣市議員候選人", region: "彰化縣" },
  );
});

Deno.test("有 election_type 就組「○○候選人」；臺→台", () => {
  assertEquals(
    newPoliticianDefaults({ election_type: "縣市議員", bio: "臺南市某某" }),
    { position: "縣市議員候選人", region: "台南市" },
  );
});

Deno.test("交件有帶的原樣用；推不出來回 null，不塞假值", () => {
  assertEquals(newPoliticianDefaults({ position: "市長", region: "高雄市", bio: "彰化縣" }), { position: "市長", region: "高雄市" });
  assertEquals(newPoliticianDefaults({}), { position: null, region: null });
});
