import { assert, assertEquals } from "jsr:@std/assert@1";
import { PROTOCOL_URL, PROTOCOL_VERSION } from "./protocol.ts";

// /next 每次回 protocol_version，協議要求代理版本不符就重讀 skill.md（2026-09-18）。
// 這個機制只有在「兩個地方的版本一致」時才有意義（#492 起檔尾不再寫版號）：
//   - _shared/protocol.ts 的常數（/next 回的那個，唯一真相）
//   - public/skill.md 檔頭的版本（代理讀到的那份）
// 常數比 skill.md 新 → 代理被無限叫去重讀，讀到的還是舊的，永遠不會相符。
// 常數比 skill.md 舊 → 協議改了也沒人被通知，這個機制等於不存在。

async function skillMd(): Promise<string> {
  return await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
}

Deno.test("協議版本：/next 回的版本（常數）與 skill.md 檔頭一致，檔尾不重複版號", async () => {
  const md = await skillMd();
  const head = md.match(/\*\*版本\*\*：([0-9]+\.[0-9]+\.[0-9]+)/)?.[1];
  assert(head, "skill.md 找不到檔頭的版本號");
  assertEquals(head, PROTOCOL_VERSION, "skill.md 檔頭的版本跟 /next 回的不一致");
  // 版號只放檔頭一處（#492）：檔尾再出現版號行＝多一個會跟別人撞衝突、又要記得同步的地方
  assert(!/\*協議版本 \d+\.\d+\.\d+/.test(md), "skill.md 檔尾不要再寫版號（只寫檔頭）");
  assertEquals((md.match(/\*\*版本\*\*：\d+\.\d+\.\d+/g) ?? []).length, 1, "「**版本**：x.y.z」只能出現一次");
});

Deno.test("協議有寫明：版本不符要重讀 skill.md，而且說得出要去哪裡讀", async () => {
  const md = await skillMd();
  assert(md.includes("protocol_version"), "skill.md 沒提到 protocol_version，代理不知道要比對什麼");
  assert(md.includes("重新讀一次"), "skill.md 沒說版本不一樣時要重讀");
  assert(md.includes(PROTOCOL_URL), `skill.md 要寫出協議網址 ${PROTOCOL_URL}`);
});

Deno.test("/next 三種回應都帶 protocol_version：它放在共用的 base 裡", async () => {
  const src = await Deno.readTextFile(new URL("../next/index.ts", import.meta.url));
  // base 裡有 ${VERIFY_TASK_RATIO} 這種樣板字串，不能用「遇到第一個 } 就停」的抓法
  const base = src.match(/const base = \{[\s\S]*?\};/)?.[0] ?? "";
  assert(base.includes("total_pending"), "沒抓到 /next 的共用 base，抓法可能壞了");
  assert(base.includes("protocol_version"), "/next 的共用 base 少了 protocol_version，會有回應漏帶");
  const kinds = [...src.matchAll(/kind: "(verify|task|none)"/g)].map((m) => m[1]);
  for (const k of ["verify", "task", "none"]) assert(kinds.includes(k), `找不到 kind=${k} 的回應，回應種類可能改過了`);
});
