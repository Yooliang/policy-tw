// `/next?skip=<任意字串>` 只認佇列上真實存在的 task_id（#466 C）。
// 原本不管 skip 是什麼都呼叫 task_dispatched（對不存在的 id 會新插一列；非 verify: 的列觸發 gap_events opened／closed，
// 那張表只增不刪），匿名帶任意字串就能一直灌大。真實 id 的 skip 行為（記 skips、推回隊尾）一字不改。
import { assert, assertEquals } from "jsr:@std/assert@1";
import { loadEntry, type RestCall } from "./entry-harness.ts";

const env = { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789", CONTRIBUTION_IP_SALT: "salt" };
const REAL = "auto:profile_gap:abc123";
const taskRow = { task_id: REAL, task_type: "profile_gap", target: {}, what_we_need: "補基本資料", hint_sources: [], reward: 1, queue_at: "2026-10-01T00:00:00Z" };

async function runSkip(skip: string, known: string[]): Promise<RestCall[]> {
  const router = (c: RestCall): unknown => {
    if (c.target === "task_dispatches" && c.method === "GET") {
      const q = c.url.searchParams.get("task_id");
      return q?.startsWith("eq.") && known.includes(q.slice(3)) ? [{ task_id: q.slice(3) }] : [];
    }
    if (c.target === "rpc/contribution_verify_pool") return [];
    if (c.target === "rpc/contribution_queue_tasks") return [taskRow];
    return undefined;
  };
  const entry = await loadEntry("../next/index.ts", env, router);
  try {
    const res = await entry.call(new Request(`https://x/next?agent_name=dave&agent_tool=claude-code/claude-sonnet-5&skip=${encodeURIComponent(skip)}`, { headers: { "x-forwarded-for": "10.1.1.5" } }));
    assert(res.status < 500, `status ${res.status}`);
    await res.text();
    return entry.calls;
  } finally {
    entry.restore();
  }
}
const skipsWritten = (calls: RestCall[]) => calls.filter((c) => c.target === "contribution_task_skips" && c.method !== "GET");
const pushedBack = (calls: RestCall[], id: string) => calls.filter((c) => c.target === "rpc/task_dispatched" && (c.body as { p_task_id?: string })?.p_task_id === id);

Deno.test("skip=不存在的 id → 不記 skips、不呼叫 task_dispatched（不在 task_dispatches 插新列）", async () => {
  const calls = await runSkip("lol-anything-123", [REAL]);
  assertEquals(skipsWritten(calls).length, 0);
  assertEquals(pushedBack(calls, "lol-anything-123").length, 0);
  assert(!calls.some((c) => c.target === "rpc/task_dispatched" && (c.body as { p_task_id?: string })?.p_task_id?.includes("lol-anything")));
});

Deno.test("skip=verify: 開頭但不在佇列的字串 → 同樣忽略", async () => {
  const calls = await runSkip("verify:00000000-0000-4000-8000-000000000000", [REAL]);
  assertEquals(skipsWritten(calls).length, 0);
  assertEquals(pushedBack(calls, "verify:00000000-0000-4000-8000-000000000000").length, 0);
});

Deno.test("skip=佇列上真實存在的 task_id → 照舊：記 skips、推回隊尾", async () => {
  const calls = await runSkip(REAL, [REAL]);
  assertEquals(skipsWritten(calls).length, 1);
  assertEquals((skipsWritten(calls)[0].body as { task_id?: string }).task_id, REAL);
  assertEquals(pushedBack(calls, REAL).length, 1);
});
