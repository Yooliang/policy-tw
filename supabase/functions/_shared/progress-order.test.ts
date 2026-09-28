import { assertEquals } from "jsr:@std/assert@1";
import { applyContribution, isOlderEvent } from "./apply-contribution.ts";

// 2026-09-28：先交「10 月已完成」、後補「3 月開始推動」會讓政見現況倒退成推動中。比現況舊的事件只進時間軸。
Deno.test("isOlderEvent：嚴格早於現況日期才算舊；現況沒日期當成新的", () => {
  assertEquals(isOlderEvent("2026-03-01", "2026-10-01"), true);
  assertEquals(isOlderEvent("2026-10-01", "2026-10-01"), false);
  assertEquals(isOlderEvent("2026-11-01", "2026-10-01"), false);
  assertEquals(isOlderEvent("2026-03-01", null), false);
});

const POLICY = "a96cc098-3a4a-455b-ac87-40bc471467f6";
function fake(lastUpdated: string) {
  const updates: Array<Record<string, unknown>> = [];
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const db = {
    from: (table: string) => ({
      select: (_c: string) => ({
        eq: (_k: string, _v: unknown) => ({ maybeSingle: async () => ({ data: { status: "Achieved", progress: 100, last_updated: lastUpdated, removed_at: null }, error: null }) }),
      }),
      update: (patch: Record<string, unknown>) => { updates.push(patch); return { eq: async () => ({ error: null }) }; },
      insert: (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return { select: () => ({ maybeSingle: async () => ({ data: { id: 1, ...row }, error: null }) }), error: null };
      },
    }),
  };
  return { db, updates, inserts };
}
const row = (date: string) => ({
  id: "c-1", contribution_type: "policy_progress" as const, source_urls: ["https://news.example/1"], note: null, agent_name: "tester", contributor_url: null,
  payload: { policy_id: POLICY, status: "In Progress", date, note: "三月議會通過預算，工程開始推動" },
});

Deno.test("比現況舊的進度：只進時間軸，不動目前狀態", async () => {
  const { db, updates, inserts } = fake("2026-10-01");
  const out = await applyContribution(db, row("2026-03-01"));
  assertEquals(out.status, "applied");
  assertEquals(updates.filter((u) => "status" in u).length, 0, "目前狀態不應被改");
  assertEquals(inserts.some((i) => i.table === "tracking_logs"), true, "時間軸要記");
});

Deno.test("比現況新的進度：照常更新目前狀態", async () => {
  const { db, updates } = fake("2026-03-01");
  await applyContribution(db, row("2026-10-01"));
  assertEquals(updates.some((u) => u.status === "In Progress"), true);
});
