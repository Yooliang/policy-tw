import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { verifyCaller } from "../_shared/console-fetch-auth.ts";
import { runRosterMirror } from "../_shared/cec-roster-mirror.ts";

/**
 * cec-roster-mirror — 中選會選舉專區名冊鏡像（2026-10-31）：每天（台灣凌晨）把約 500 個候選人 JSON 抓進 cec_roster_2026，
 * 抓完（沒有待抓單位）立刻跑 cec_roster_reconcile_if_due()：比對並開 roster_extra／roster_missing／合併任務、插隊。
 * 每輪約 100 秒預算、同網域每檔間隔 0.5 秒、一般 UA、只 GET、失敗重試 3 次；pg_cron UTC 18～21 時每 5 分鐘一輪，抓完當天空轉。
 * 呼叫者驗證照 roster-reconcile：x-cron-secret（Vault roster_reconcile_cron_secret）或 service role bearer。
 * 請求 body（可省略）：{ limit?: 1..200 }。
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
      if (!Number.isInteger(n) || n < 1 || n > 200) return json({ success: false, error: "limit 要是 1 到 200 的整數" }, 400);
      limit = n;
    }
  } catch {
    return json({ success: false, error: "body 不是合法的 JSON" }, 400);
  }
  try {
    const stats = await runRosterMirror(createClient(supabaseUrl, serviceRoleKey), { limit });
    return json({ success: true, ...stats });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("cec-roster-mirror：", message);
    return json({ success: false, error: message }, 500);
  }
});
