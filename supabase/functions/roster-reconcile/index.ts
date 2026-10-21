import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { verifyCaller } from "../_shared/console-fetch-auth.ts";
import { runRosterReconcile } from "../_shared/roster-reconcile.ts";

/**
 * roster-reconcile — 名冊對帳：登記彙總表唯一對上、我們沒有的人，由系統建成參選紀錄（#678 第一階段，維護者 2026-10-19）。
 *
 * 對帳在資料庫（視圖 roster_reconcile）；這裡只把「唯一可建」的那幾位（RPC roster_reconcile_next，每輪最多 roster_reconcile_settings.batch_limit 位）
 * 用跟代理交件落庫同一支邏輯（_shared/apply-contribution.ts 的 applyCandidacy）建起來：人物不存在才建、已存在（唯一同名、同地方）就掛上去。
 * 來源記登記彙總表那一列（roster_reconcile_log）、進 edit_history（agent_name＝system:roster-reconcile）、可整筆還原（SQL 函式 roster_reconcile_revert）。
 * settings.actions 含 region 時另補地區（#731）：名冊唯一對上、我們那筆 region_id 為空的，對到 regions 唯一一列才寫（只補空白），回應多 region 一欄。
 * 說明與規矩見 _shared/roster-reconcile.ts 檔頭與 docs/decisions/2026-10-19-名冊比對表唯一對上由系統建參選紀錄.md。
 *
 * 呼叫者驗證照 bulletin-watch：x-cron-secret（密鑰只在 Vault，函式用 RPC roster_reconcile_cron_secret_ok 請資料庫比對）或 service role bearer。
 * pg_cron 每 10 分鐘（第 7 分）呼叫；settings.enabled＝false 就空轉。
 *
 * 請求 body（可省略）：{ limit?: 1..500 }（手動試跑用，沒給就用 settings.batch_limit）。
 * 回應：{ success, run_id, picked, applied, created_politicians, attached, unresolved, errors, samples, elapsed_ms, … }。
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "method not allowed" }, 405);

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const check = await verifyCaller(req.headers, {
    serviceRoleKey,
    checkCronSecret: serviceRoleKey && supabaseUrl
      ? async (secret) => {
        const { data, error } = await createClient(supabaseUrl, serviceRoleKey).rpc("roster_reconcile_cron_secret_ok", { p_secret: secret });
        if (error) throw new Error(error.message);
        return data === true;
      }
      : undefined,
  });
  if (!check.ok) return json({ success: false, error: check.error }, check.status);
  if (!serviceRoleKey || !supabaseUrl) return json({ success: false, error: "缺少 SUPABASE_URL／SUPABASE_SERVICE_ROLE_KEY" }, 500);

  let limit: number | undefined;
  try {
    const text = await req.text();
    const body = text.trim() ? JSON.parse(text) as Record<string, unknown> : {};
    if (body.limit !== undefined) {
      const n = Number(body.limit);
      if (!Number.isInteger(n) || n < 1 || n > 500) return json({ success: false, error: "limit 要是 1 到 500 的整數" }, 400);
      limit = n;
    }
  } catch {
    return json({ success: false, error: "body 不是合法的 JSON" }, 400);
  }

  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const summary = await runRosterReconcile(supabase, { limit });
    return json({ success: true, ...summary });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("roster-reconcile：", message);
    return json({ success: false, error: message }, 500);
  }
});
