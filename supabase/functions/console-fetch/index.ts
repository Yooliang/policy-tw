import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  CONSOLE_CONFIG,
  makeFirestoreStore,
  makeTokenGetter,
  missingEnv,
  parseServiceAccountKey,
  realDeps,
  REQUIRED_ENV,
  runConsoleFetch,
} from "../_shared/console-fetch.ts";
import { runPageTrafficSync, type TrafficStore } from "../_shared/page-traffic.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { verifyCaller } from "../_shared/console-fetch-auth.ts";
import { makeSupabaseGaMirror, makeTimeoutFetch, runGaSearchSync, teeStore } from "../_shared/ga-console-store.ts";

/**
 * console-fetch — 抓 GA4（正見、政策の系譜、島作），寫進 Firestore（專案 policy-tw），給站務主控台
 * （policy-console.web.app）讀。從私人 repo policy-console 的 scripts/fetch.mjs 搬來（2026-10-07）：
 * 原本靠 GitHub Actions 每小時跑，GitHub 常跳過排程；改由 pg_cron 每小時第 17 分叫這支。
 * 分工（2026-10-08）：GA 只在這裡跑；AdSense 只留在 policy-console 的 GitHub Actions（這裡完全不碰，meta/status 也只寫 GA 的欄位）。
 *
 * 呼叫者驗證：x-cron-secret（pg_cron 從 Vault 帶；函式端用 RPC console_fetch_cron_secret_ok 請資料庫比對）或 service role bearer，
 * 細節與理由見 _shared/console-fetch-auth.ts。
 * 環境變數（與 GitHub secret 同名）：GCP_SA_KEY（服務帳號 JSON，GA 與 Firestore 共用）。驗證用的密鑰不在環境變數裡（只在 Vault）。
 * 頁面流量（2026-10-08）：GA 抓完之後多抓一份人物頁／政見頁近 N 天的流量，經 service_role RPC replace_page_traffic 整批覆寫 Supabase 的 page_traffic，
 * 給 seed 的流量提層用（_shared/page-traffic.ts、migration 20261008190000）。N、停用開關讀 traffic_boost_settings。它的成敗不影響上面的 success：
 * 失敗只記進回應的 traffic 欄與日誌，不寫 Firestore 的 meta/status。
 * 缺環境變數：能寫 Firestore 就把失敗寫進 meta/status，並回 500，不靜默成功。
 * 單一資料源（GA 的某一站）失敗只記進 meta/status、仍回 200（與 fetch.mjs 一致）；只有 Firestore 寫入本身壞掉才回 500。
 * Supabase 另存（2026-10-20，policy-ops #148，migration 20261020010000）：寫 Firestore summary／daily 的同一份另外 upsert 進私有表
 * ga_summary／ga_daily（_shared/ga-console-store.ts 的 teeStore），再抓正見站內搜尋詞進 ga_search_terms（GA 沒登記自訂維度就略過）。
 * 兩者的成敗都不影響 success 與 Firestore：只記進回應的 ga_store、search 欄與日誌。
 * 回應：{ success, missing_env?, sources: { "ga-tw": { state, message } … }, traffic: { state, message, rows? }, ga_store, search, elapsed_ms }（不含任何金鑰）
 */

/** 開始後超過這麼久就不抓站內搜尋詞（Edge Function 回應上限約 150 秒，GA 主流程約 1 分鐘） */
const SEARCH_DEADLINE_MS = 100_000;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "method not allowed" }, 405);

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const check = await verifyCaller(req.headers, {
    serviceRoleKey,
    checkCronSecret: serviceRoleKey && supabaseUrl
      ? async (secret) => {
        const { data, error } = await createClient(supabaseUrl, serviceRoleKey).rpc("console_fetch_cron_secret_ok", { p_secret: secret });
        if (error) throw new Error(error.message);
        return data === true;
      }
      : undefined,
  });
  if (!check.ok) return json({ success: false, error: check.error }, check.status);

  const started = Date.now();
  const env: Record<string, string | undefined> = {};
  for (const k of REQUIRED_ENV) env[k] = Deno.env.get(k);

  // 沒有服務帳號金鑰就寫不了 Firestore，也就沒地方記失敗狀態：只能回錯（Edge Function 日誌看得到）
  let sa;
  try {
    sa = parseServiceAccountKey(env.GCP_SA_KEY);
  } catch (e) {
    return json({ success: false, error: (e as Error).message, missing_env: missingEnv(env) }, 500);
  }

  const getToken = makeTokenGetter(sa, realDeps);
  // service role 的 Supabase 連線：GA 另存與頁面流量共用（沒有就各自記失敗，Firestore 照寫）
  const gaMirror = supabaseUrl && serviceRoleKey
    ? makeSupabaseGaMirror(createClient(supabaseUrl, serviceRoleKey, { global: { fetch: makeTimeoutFetch() } }))
    : null;
  const tee = teeStore(makeFirestoreStore(getToken, realDeps), gaMirror);
  const store = tee.store;
  let result: Awaited<ReturnType<typeof runConsoleFetch>> | undefined;
  let fatal: Error | undefined;
  try {
    result = await runConsoleFetch({ config: CONSOLE_CONFIG, env, deps: realDeps, store, getToken });
  } catch (e) {
    // Firestore 寫入本身壞了（連 meta/status 都寫不進去）
    fatal = e as Error;
    console.error("console-fetch 失敗：", fatal.message);
  }

  // 頁面流量：與 Firestore 無關，主流程成敗都照跑；自己的失敗不往外丟（runPageTrafficSync 回 error 狀態）
  const traffic = supabaseUrl && serviceRoleKey
    ? await runPageTrafficSync({ getToken, store: makeTrafficStore(createClient(supabaseUrl, serviceRoleKey)) })
    : { state: "error" as const, message: "沒有 SUPABASE_URL／SUPABASE_SERVICE_ROLE_KEY" };
  if (traffic.state === "error") console.error("頁面流量失敗：", traffic.message);

  // GA 另存與站內搜尋詞：同樣不往外丟、不影響 success
  const ga_store = await tee.flush();
  if (ga_store.state === "error") console.error("GA 另存 Supabase 失敗：", ga_store.message);
  const search = await runGaSearchSync({ site: "tw", propertyId: CONSOLE_CONFIG.sites.tw.propertyId as string, getToken, mirror: gaMirror, deadlineMs: started + SEARCH_DEADLINE_MS });
  if (search.state === "error") console.error("站內搜尋詞失敗：", search.message);

  if (fatal || !result) return json({ success: false, error: fatal?.message ?? "unknown", traffic, ga_store, search, elapsed_ms: Date.now() - started }, 500);
  return json(
    {
      success: result.success,
      ...(result.missing.length ? { error: `缺少環境變數：${result.missing.join("、")}`, missing_env: result.missing } : {}),
      sources: result.sources,
      traffic,
      ga_store,
      search,
      elapsed_ms: Date.now() - started,
    },
    result.success ? 200 : 500,
  );
});

/** 資料庫端的接縫：讀設定、呼叫 RPC（service role；RPC 只授權 service_role） */
// deno-lint-ignore no-explicit-any
function makeTrafficStore(db: any): TrafficStore {
  return {
    async readSettings() {
      const { data, error } = await db.from("traffic_boost_settings").select("enabled, window_days").eq("id", 1).single();
      if (error) throw new Error(error.message);
      return { enabled: data.enabled === true, window_days: Number(data.window_days) };
    },
    async replace(rows, windowDays) {
      const { data, error } = await db.rpc("replace_page_traffic", { p_rows: rows, p_window_days: windowDays });
      if (error) throw new Error(error.message);
      return Number(data ?? 0);
    },
  };
}