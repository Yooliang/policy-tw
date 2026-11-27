/**
 * cec-sync 結尾的派工缺口入列（第 2 期 PR-2，migration 20261127053900）守門。
 * 純函式與接線：去重、分批、失敗不丟錯；cec-sync 在「先刪後寫」之後收集單位、迴圈結束後只呼叫一次；rpc 名稱與遷移裡的 SQL 函式同名。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { dedupeUnits, enqueueCecUnits, GAP_RPC_NAME, GAP_UNIT_BATCH, type GapUnit, type RpcClient } from "./dispatch-gap-events.ts";

const u = (n: number, sub?: string): GapUnit => ({ election_id: 2022, election_type: "村里長", region: `縣${n}`, ...(sub ? { sub_region: sub } : {}) });

function fakeRpc(opts: { error?: string; throwOnCall?: number; events?: number } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: RpcClient = {
    rpc(name, args) {
      calls.push({ name, args: args ?? {} });
      if (opts.throwOnCall !== undefined && calls.length === opts.throwOnCall) throw new Error("連線中斷");
      if (opts.error) return Promise.resolve({ data: null, error: { message: opts.error } });
      return Promise.resolve({ data: opts.events ?? 3, error: null });
    },
  };
  return { client, calls };
}

Deno.test("dedupeUnits：同一個單位只留一筆（含 sub_region 的不同單位不合併），保持第一次出現的順序", () => {
  const out = dedupeUnits([u(1), u(2), u(1), u(1, "全國"), u(1, "全國"), u(2)]);
  assertEquals(out.map((x) => `${x.region}|${x.sub_region ?? ""}`), ["縣1|", "縣2|", "縣1|全國"]);
});

Deno.test("沒有單位就不打 rpc；有單位只打一次，帶 p_units，回傳新增事件數", async () => {
  const a = fakeRpc();
  assertEquals(await enqueueCecUnits(a.client, []), { ok: true, units: 0, events: 0 });
  assertEquals(a.calls.length, 0);
  const b = fakeRpc({ events: 7 });
  assertEquals(await enqueueCecUnits(b.client, [u(1), u(2), u(1)]), { ok: true, units: 2, events: 7 });
  assertEquals(b.calls.length, 1);
  assertEquals(b.calls[0].name, "dispatch_gap_enqueue_cec_units");
  assertEquals((b.calls[0].args.p_units as GapUnit[]).length, 2);
});

Deno.test("超過一批就分批送（每批 GAP_UNIT_BATCH 個）；事件數加總", async () => {
  const r = fakeRpc({ events: 2 });
  const units = Array.from({ length: GAP_UNIT_BATCH * 2 + 5 }, (_, i) => u(i));
  const out = await enqueueCecUnits(r.client, units);
  assertEquals(r.calls.length, 3);
  assertEquals(r.calls.map((c) => (c.args.p_units as GapUnit[]).length), [GAP_UNIT_BATCH, GAP_UNIT_BATCH, 5]);
  assertEquals(out, { ok: true, units: units.length, events: 6 });
});

Deno.test("失敗不丟錯（名單已經寫好了）：rpc 回錯誤、或連線丟例外，都回 ok=false 與訊息，並停止後面的批次", async () => {
  const e1 = fakeRpc({ error: "permission denied" });
  assertEquals(await enqueueCecUnits(e1.client, [u(1)]), { ok: false, units: 1, events: 0, error: "permission denied" });
  const e2 = fakeRpc({ throwOnCall: 2 });
  const units = Array.from({ length: GAP_UNIT_BATCH + 1 }, (_, i) => u(i));
  const out = await enqueueCecUnits(e2.client, units);
  assertEquals([out.ok, out.error, out.units], [false, "連線中斷", GAP_UNIT_BATCH + 1]);
  assertEquals(e2.calls.length, 2);
});

Deno.test("接線：rpc 名稱與遷移裡的 SQL 函式同名、只給 service_role；cec-sync 先刪後寫之後收集單位、迴圈結束後只呼叫一次、失敗只警告", async () => {
  const mig = await Deno.readTextFile(new URL("../../migrations/20261127053900_dispatch_gaps_phase2b.sql", import.meta.url));
  assert(mig.includes(`CREATE OR REPLACE FUNCTION ${GAP_RPC_NAME}(p_units JSONB)`));
  assert(mig.includes(`GRANT EXECUTE ON FUNCTION ${GAP_RPC_NAME}(JSONB) TO service_role;`));
  assert(mig.includes(`REVOKE ALL ON FUNCTION ${GAP_RPC_NAME}(JSONB) FROM PUBLIC, anon, authenticated;`));
  const src = await Deno.readTextFile(new URL("../cec-sync/index.ts", import.meta.url));
  const del = src.indexOf('supabase.from("cec_candidates").delete()');
  const push = src.indexOf("touched.push(");
  const call = src.indexOf("await enqueueCecUnits(supabase, touched)");
  const loopEnd = src.indexOf("// 投票率（#344）");
  assert(del > 0 && push > del, "touched.push 要在刪除成功之後");
  assert(push < src.indexOf("insError") && call > push && call < loopEnd, "呼叫在迴圈結束之後、投票率之前");
  assertEquals(src.split("enqueueCecUnits(").length - 1, 1, "只呼叫一次（不是每個單位一次）");
  assert(src.includes("console.warn(`[cec-sync] 派工缺口入列失敗"), "失敗只警告，不影響回應 success");
  assert(src.includes("gap_events: gapEvents"), "回應帶 gap_events 方便追查");
});
