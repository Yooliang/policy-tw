import { assertEquals } from "jsr:@std/assert";
import { comparePerson, comparePersonName } from "./person-name.ts";

Deno.test("不先比字數：三字名「王小明」排在兩字名「歐陽」前面", () => {
  assertEquals(["歐陽", "王小明"].sort(comparePersonName), ["王小明", "歐陽"]);
});

Deno.test("單姓與複姓照第一字筆畫混排，不分兩組", () => {
  assertEquals(["歐陽修", "張三", "司馬光", "王五"].sort(comparePersonName), ["王五", "司馬光", "張三", "歐陽修"]);
});

Deno.test("同姓不同名：第一字相同再比後面的字", () => {
  assertEquals(["王偉", "王大明", "王一"].sort(comparePersonName), ["王一", "王大明", "王偉"]);
});

Deno.test("筆畫少的姓在前：丁 < 王 < 張", () => {
  assertEquals(["張", "王", "丁"].sort(comparePersonName), ["丁", "王", "張"]);
});

Deno.test("同名同姓依 id 穩定", () => {
  const list = [{ name: "李安", id: "b" }, { name: "李安", id: "a" }];
  assertEquals(list.sort(comparePerson).map((p) => p.id), ["a", "b"]);
});
