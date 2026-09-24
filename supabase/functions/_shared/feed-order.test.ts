import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

// 2026-09-24 leatherback：contributions-feed 的排序寫在三處——程式的 .order()、回應的 order 說明、skill.md 端點段落。
// 改排序只改程式、忘了兩段說明，代理就會照舊說明拿第一頁估比例（當天兩次、方向相反）。靠人記得不算守門，這裡讓 CI 擋。
Deno.test("contributions-feed：排序欄位同時寫在回應的 order 與 skill.md", async () => {
  const src = await Deno.readTextFile(new URL("../contributions-feed/index.ts", import.meta.url));
  const skill = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
  const col = src.match(/\.order\("([a-z_]+)"/)?.[1];
  assert(col, "contributions-feed 找不到 .order(\"…\")");
  const orderLine = src.match(/order: "([^"]+)"/)?.[1] ?? "";
  assert(orderLine.includes(col), `回應的 order 說明沒提到排序欄位 ${col}`);
  const feedLines = skill.split("\n").filter((l) => l.includes("contributions-feed"));
  assert(feedLines.some((l) => l.includes(col)), `skill.md 的 contributions-feed 段落沒提到排序欄位 ${col}`);
});
