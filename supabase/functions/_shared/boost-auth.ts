/**
 * 插隊（boost／jp-boost）寫入的呼叫者驗證（2026-11-04，policy-ops#196）。
 *
 * POST 要帶維護者憑證，驗不過回 401、驗證服務壞掉回 503，兩種都不寫任何東西（fail closed）；GET 維持公開。
 * 憑證種類與 console-fetch 相同（_shared/console-fetch-auth.ts 的 verifyCaller）：
 *   1. Authorization: Bearer <service role key>（維護者手動呼叫）
 *   2. x-cron-secret：值由 migration 自己產生在 Vault（boost_maintainer_secret），函式端不持有，
 *      呼叫 RPC boost_maintainer_secret_ok(p_secret) 請資料庫比對（SECURITY DEFINER，只授權 service_role）。
 * 正見與日本站共用這一份；日本站的 client 固定 schema policy_jp，所以 policy_jp 也有同名 RPC（轉呼叫 public 那支）。
 */
import { type CallerCheck, verifyCaller } from "./console-fetch-auth.ts";

// deno-lint-ignore no-explicit-any
type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: { message: string } | null }> };

export async function boostCaller(headers: Headers, supabase: RpcClient, serviceRoleKey: string | undefined): Promise<CallerCheck> {
  return await verifyCaller(headers, {
    serviceRoleKey,
    checkCronSecret: async (secret) => {
      const { data, error } = await supabase.rpc("boost_maintainer_secret_ok", { p_secret: secret });
      if (error) throw new Error(error.message);
      return data === true;
    },
  });
}
