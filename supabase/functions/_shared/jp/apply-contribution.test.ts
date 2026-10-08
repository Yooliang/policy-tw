import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { JP_APPLY_TYPES, jpApplyViaRpc } from "./apply-contribution.ts";

/** rpc を記録する偽の supabase client（apply_contribution の戻り値を差し替えられる） */
function fakeSupabase(result: { data?: unknown; error?: { message: string } | null }) {
  const calls: Array<{ fn: string; args: unknown }> = [];
  return {
    calls,
    rpc: (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
    },
  };
}
const CID = "11111111-2222-4333-8444-555555555555";

Deno.test("jpApplyViaRpc：apply_contribution を p_retry=false で呼ぶ", async () => {
  const sb = fakeSupabase({ data: { status: "applied", message: "新增團體 愛知県（230006）" } });
  await jpApplyViaRpc(sb, CID);
  assertEquals(sb.calls, [{ fn: "apply_contribution", args: { p_id: CID, p_retry: false } }]);
});

Deno.test("jpApplyViaRpc：applied／rejected／apply_failed は貢獻の新しい狀態として返す", async () => {
  for (const status of ["applied", "rejected", "apply_failed"]) {
    const out = await jpApplyViaRpc(fakeSupabase({ data: { status, message: "m" } }), CID);
    assertEquals(out, { status, message: "m" });
  }
});

Deno.test("jpApplyViaRpc：waiting は狀態を返さず說明だけ（貢獻は verified のまま）；unsupported／skipped／not_found／壊れた戻り値は null（落庫を觸發していない）", async () => {
  assertEquals(await jpApplyViaRpc(fakeSupabase({ data: { status: "waiting", reason: "local_government_missing:232033", message: "等團體" } }), CID), { message: "等團體" });
  for (const data of [{ status: "unsupported" }, { status: "skipped", contribution_status: "pending" }, { status: "not_found" }, {}, [], null, "applied", 3]) {
    assertEquals(await jpApplyViaRpc(fakeSupabase({ data }), CID), null, JSON.stringify(data));
  }
});

Deno.test("jpApplyViaRpc：rpc 自體出錯就丟（verify-handler 會攔住，投票仍成功）", async () => {
  await assertRejects(() => jpApplyViaRpc(fakeSupabase({ error: { message: "function policy_jp.apply_contribution does not exist" } }), CID), Error, "apply_contribution");
});

Deno.test("落庫する型別は四つ（task_suggestion／correction は含まない）", () => {
  assertEquals([...JP_APPLY_TYPES].sort(), ["election", "local_government", "no_change", "regional_stat"]);
  assert(!(JP_APPLY_TYPES as readonly string[]).includes("correction"));
});
