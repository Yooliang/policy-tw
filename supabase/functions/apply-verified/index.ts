import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { autoApplyContribution } from "../_shared/auto-apply.ts";
import { APPLY_MAX_RETRIES } from "../_shared/consensus.ts";

/**
 * apply-verified — 掃地機（cron 每 10 分鐘）：
 *   1. status=verified 且 verified_at 在 5 分鐘前的 → 自動落庫（補 /report 內建自動落庫的漏網）
 *   2. status=apply_failed 且 next_retry_at 已到、retry_count < 3 的 → 重試；連續 3 次仍失敗由 auto-apply 轉 disputed 並寫 review_notes
 * 無金鑰（只會處理已 verified／重試中的，做的事與 /report 一樣）。GET 或 POST 都可；?limit= 一次最多幾筆（預設 20）。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const GRACE_MINUTES = 5;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - GRACE_MINUTES * 60 * 1000).toISOString();

    const [verifiedRes, retryRes] = await Promise.all([
      supabase.from("contributions").select("id").eq("status", "verified").lte("verified_at", cutoff).order("verified_at", { ascending: true }).limit(limit),
      supabase.from("contributions").select("id").eq("status", "apply_failed").lt("retry_count", APPLY_MAX_RETRIES).lte("next_retry_at", now).order("next_retry_at", { ascending: true }).limit(limit),
    ]);
    if (verifiedRes.error) throw new Error(`contributions scan: ${verifiedRes.error.message}`);
    if (retryRes.error) throw new Error(`contributions retry scan: ${retryRes.error.message}`);

    const results = [];
    for (const r of verifiedRes.data ?? []) {
      const res = await autoApplyContribution(supabase, r.id);
      results.push({ contribution_id: r.id, kind: "verified", status: res.status, error: res.error, message: res.outcome?.message });
    }
    for (const r of retryRes.data ?? []) {
      const res = await autoApplyContribution(supabase, r.id, undefined, { retry: true });
      results.push({ contribution_id: r.id, kind: "retry", status: res.status, error: res.error, message: res.outcome?.message });
    }
    return json({ success: true, scanned: (verifiedRes.data?.length ?? 0) + (retryRes.data?.length ?? 0), retried: retryRes.data?.length ?? 0, results });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("apply-verified error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
