import { assertEquals } from "jsr:@std/assert@1";
import { validateBoostFilter, validateBoostLabel } from "./boost-filter.ts";

// 2026-09-22 插隊：端點無金鑰，條件只能是固定詞彙；這組守著「不認得的鍵一律擋」
Deno.test("六都 2026：regions＋election_id 過；kinds 預設不寫", () => {
  const r = validateBoostFilter({ regions: ["台北市", "新北市", "桃園市", "台中市", "台南市", "高雄市"], election_id: 2026 });
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.filter, { regions: ["台北市", "新北市", "桃園市", "台中市", "台南市", "高雄市"], election_id: 2026 });
});
Deno.test("缺照片：missing_avatar:true 過、false 等於沒條件", () => {
  assertEquals(validateBoostFilter({ missing_avatar: true }).ok, true);
  assertEquals(validateBoostFilter({ missing_avatar: false }).ok, false);
});
Deno.test("不認得的鍵、自由文字、空物件都擋", () => {
  assertEquals(validateBoostFilter({ sql: "1=1" }).ok, false);
  assertEquals(validateBoostFilter({}).ok, false);
  assertEquals(validateBoostFilter("regions").ok, false);
  assertEquals(validateBoostFilter({ kinds: ["task", "everything"] }).ok, false);
  assertEquals(validateBoostFilter({ election_id: "2026" }).ok, false);
  assertEquals(validateBoostFilter({ politician_ids: ["not-a-uuid"] }).ok, false);
});
Deno.test("label 必填、有上限", () => {
  assertEquals(validateBoostLabel("").ok, false);
  assertEquals(validateBoostLabel("x".repeat(61)).ok, false);
  const r = validateBoostLabel("  六都 2026  ");
  assertEquals(r.ok && r.label, "六都 2026");
});
