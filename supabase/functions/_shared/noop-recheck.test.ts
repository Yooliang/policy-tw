import { assert, assertEquals } from "jsr:@std/assert";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { retireIfNoOp } from "./noop-sweep.ts";

// 2026-09-23 W-Policy：45190c4b 只有 election_id 一欄且已跟現值相同，卻照常派出來——前一筆更正剛套用、
// 10 分鐘一次的掃地機還沒跑到。派工當下再比一次收掉這種時間差。
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function seed() {
  return {
    contributions: [
      { id: C1, contribution_type: "correction", status: "pending", payload: { target_table: "policies", target_id: P1, changes: [{ field: "election_id", correct_value: 2024 }] } },
      { id: C2, contribution_type: "correction", status: "pending", payload: { target_table: "policies", target_id: P1, changes: [{ field: "election_id", correct_value: 2024 }, { field: "proposed_date", correct_value: "2024-03-01" }] } },
    ],
    policies: [{ id: P1, election_id: 2024, proposed_date: "2023-01-01" }],
  };
}

Deno.test("派工當下：每欄都已跟現值相同 → 退池、回 true", async () => {
  const fake = createFakeSupabase(seed());
  assertEquals(await retireIfNoOp(fake.client, C1), true);
  const row = fake.db.contributions.find((c) => c.id === C1)!;
  assertEquals(row.status, "superseded");
  assert(String(row.review_notes).includes("election_id"));
});

Deno.test("派工當下：部分欄位相同 → 不動、回 false", async () => {
  const fake = createFakeSupabase(seed());
  assertEquals(await retireIfNoOp(fake.client, C2), false);
  assertEquals(fake.db.contributions.find((c) => c.id === C2)!.status, "pending");
});

Deno.test("不是 pending 的 correction → false，不碰", async () => {
  const s = seed();
  s.contributions[0].status = "verified";
  const fake = createFakeSupabase(s);
  assertEquals(await retireIfNoOp(fake.client, C1), false);
  assertEquals(await retireIfNoOp(fake.client, "not-there"), false);
});

Deno.test("/next 派驗證前真的有呼叫重比（守門）", async () => {
  const src = await Deno.readTextFile(new URL("../next/index.ts", import.meta.url));
  assert(src.includes("retireIfNoOp("), "next/index.ts 要在排頭是 correction 時呼叫 retireIfNoOp");
});
