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
import { verifyCaller } from "../_shared/console-fetch-auth.ts";

/**
 * console-fetch — 抓 GA4（正見、政策の系譜）與 AdSense，寫進 Firestore（專案 policy-tw），給站務主控台
 * （policy-console.web.app）讀。從私人 repo policy-console 的 scripts/fetch.mjs 搬來（2026-10-07）：
 * 原本靠 GitHub Actions 每小時跑，GitHub 常跳過排程；改由 pg_cron 每小時第 17 分叫這支。
 *
 * 呼叫者驗證：x-cron-secret（pg_cron 從 Vault 帶）或 service role bearer，細節與理由見 _shared/console-fetch-auth.ts。
 * 環境變數（與 GitHub secrets 同名）：GCP_SA_KEY、ADSENSE_REFRESH_TOKEN、ADSENSE_CLIENT_ID、ADSENSE_CLIENT_SECRET；
 * 另有 CONSOLE_FETCH_CRON_SECRET（驗證用）、選用 ADSENSE_ACCOUNT。
 * 缺環境變數：能寫 Firestore 就把失敗寫進 meta/status，並回 500，不靜默成功。
 * 單一資料源（GA 的某一站、AdSense）失敗只記進 meta/status、仍回 200（與 fetch.mjs 一致）；只有 Firestore 寫入本身壞掉才回 500。
 * 回應：{ success, missing_env?, sources: { "ga-tw": { state, message } … }, elapsed_ms }（不含任何金鑰）
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "method not allowed" }, 405);

  const check = await verifyCaller(req.headers, {
    cronSecret: Deno.env.get("CONSOLE_FETCH_CRON_SECRET"),
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  });
  if (!check.ok) return json({ success: false, error: check.error }, check.status);

  const started = Date.now();
  const env: Record<string, string | undefined> = { ADSENSE_ACCOUNT: Deno.env.get("ADSENSE_ACCOUNT") };
  for (const k of REQUIRED_ENV) env[k] = Deno.env.get(k);

  // 沒有服務帳號金鑰就寫不了 Firestore，也就沒地方記失敗狀態：只能回錯（Edge Function 日誌看得到）
  let sa;
  try {
    sa = parseServiceAccountKey(env.GCP_SA_KEY);
  } catch (e) {
    return json({ success: false, error: (e as Error).message, missing_env: missingEnv(env) }, 500);
  }

  const getToken = makeTokenGetter(sa, realDeps);
  const store = makeFirestoreStore(getToken, realDeps);
  try {
    const result = await runConsoleFetch({ config: CONSOLE_CONFIG, env, deps: realDeps, store, getToken });
    return json(
      {
        success: result.success,
        ...(result.missing.length ? { error: `缺少環境變數：${result.missing.join("、")}`, missing_env: result.missing } : {}),
        sources: result.sources,
        elapsed_ms: Date.now() - started,
      },
      result.success ? 200 : 500,
    );
  } catch (e) {
    // Firestore 寫入本身壞了（連 meta/status 都寫不進去）
    console.error("console-fetch 失敗：", (e as Error).message);
    return json({ success: false, error: (e as Error).message, elapsed_ms: Date.now() - started }, 500);
  }
});