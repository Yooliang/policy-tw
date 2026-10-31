import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { tabStripSignature } from "./tab-strip-signature.ts";

Deno.test("分頁數量相同但文字不同（縣市長→直轄市長）簽章要不同，底線才會重量", () => {
  const a = [{ key: "mayor", label: "縣市長" }, { key: "council", label: "議員" }];
  const b = [{ key: "mayor", label: "直轄市長" }, { key: "council", label: "議員" }];
  assertNotEquals(tabStripSignature(a), tabStripSignature(b));
});

Deno.test("完全相同則簽章相同", () => {
  assertEquals(tabStripSignature([{ key: "x", label: "甲" }]), tabStripSignature([{ key: "x", label: "甲" }]));
});
