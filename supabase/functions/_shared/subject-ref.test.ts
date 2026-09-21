import { assertEquals } from "jsr:@std/assert@1";
import { subjectRef, subjectNamesOf } from "./system-one.ts";

// 2026-09-22 candlefish 第二次探測：candidacy 的 payload 只有 politician_id，judge 每一頁都判「主角名字不在文本裡」。
Deno.test("candidacy 只有 politician_id → 去 politicians 查姓名", () => {
  assertEquals(subjectRef({ politician_id: "p1", election_id: 2026, candidate_status: "withdrawn" }), { table: "politicians", id: "p1" });
});
Deno.test("correction 用 target_table／target_id；不是人物或政見的表回 null", () => {
  assertEquals(subjectRef({ target_table: "policies", target_id: "x1", changes: {} }), { table: "policies", id: "x1" });
  assertEquals(subjectRef({ target_table: "elections", target_id: "2026" }), null);
});
Deno.test("payload 已經有名字就不查", () => {
  assertEquals(subjectRef({ name: "林國春", politician_id: "p1" }), null);
});
Deno.test("policy_progress 只有 policy_id → 標題＋提出者姓名都算主角", async () => {
  const rows: Record<string, Record<string, unknown>> = { "policies:x1": { title: "捷運延伸", politician_id: "p9" }, "politicians:p9": { name: "謝衣鳯" } };
  const fake = { from: (t: string) => ({ select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: () => Promise.resolve({ data: rows[`${t}:${id}`] ?? null }) }) }) }) };
  assertEquals(await subjectNamesOf(fake, { policy_id: "x1", status: "in_progress" }), ["捷運延伸", "謝衣鳯"]);
  assertEquals(await subjectNamesOf(fake, { politician_id: "p9" }), ["謝衣鳯"]);
  assertEquals(await subjectNamesOf(fake, { politician_id: "nope" }), []);
});
