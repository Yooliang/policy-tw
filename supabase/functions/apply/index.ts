import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { applyContribution, type ContributionRow } from "../_shared/apply-contribution.ts";

/**
 * apply — 維護者審核貢獻（需 AI_IMPORT_API_KEY）。後台頁下一輪再做，先給 curl 用。
 *
 * POST { api_key, action: "list" , status?: "pending", limit?: 50 }            → 列待審
 * POST { api_key, action: "approve", contribution_id, reviewed_by?, review_notes? } → 落庫（成功 status=applied；身份模稜兩可 status=approved + notes）
 * POST { api_key, action: "reject",  contribution_id, reviewed_by?, review_notes }  → 退件
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const expectedApiKey = Deno.env.get("AI_IMPORT_API_KEY");
    if (!expectedApiKey) return json({ success: false, error: "AI_IMPORT_API_KEY is not configured" }, 500);
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const body = await req.json().catch(() => null);
    if (!body || body.api_key !== expectedApiKey) return json({ success: false, error: "Invalid api_key" }, 401);

    const { action, contribution_id, reviewed_by, review_notes } = body;

    if (action === "list") {
      const { data, error } = await supabase
        .from("contributions")
        .select("id, contribution_type, payload, source_urls, note, agent_name, contributor_url, status, review_notes, created_at")
        .in("status", body.status ? [body.status] : ["pending", "verified", "disputed"])
        .order("created_at", { ascending: true })
        .limit(Math.min(Number(body.limit) || 50, 200));
      if (error) throw new Error(`contributions list: ${error.message}`);
      return json({ success: true, count: data?.length ?? 0, contributions: data ?? [] });
    }

    if (action !== "approve" && action !== "reject") return json({ success: false, error: "action 要是 list／approve／reject" }, 400);
    if (typeof contribution_id !== "string") return json({ success: false, error: "缺 contribution_id" }, 400);

    const { data: row, error } = await supabase
      .from("contributions")
      .select("id, contribution_type, payload, source_urls, note, agent_name, contributor_url, status")
      .eq("id", contribution_id)
      .maybeSingle();
    if (error) throw new Error(`contributions lookup: ${error.message}`);
    if (!row) return json({ success: false, error: "not_found" }, 404);
    if (row.status !== "pending" && row.status !== "approved") return json({ success: false, error: `已是 ${row.status}，不能再審` }, 409);

    const reviewer = typeof reviewed_by === "string" ? reviewed_by : "maintainer";
    const now = new Date().toISOString();

    if (action === "reject") {
      if (typeof review_notes !== "string" || !review_notes.trim()) return json({ success: false, error: "退件要寫 review_notes（貢獻者看得到）" }, 400);
      const { error: rejectError } = await supabase.from("contributions")
        .update({ status: "rejected", review_notes, reviewed_by: reviewer, reviewed_at: now })
        .eq("id", row.id);
      if (rejectError) throw new Error(`contributions reject: ${rejectError.message}`);
      return json({ success: true, contribution_id: row.id, status: "rejected" });
    }

    const outcome = await applyContribution(supabase, row as ContributionRow);
    const finalStatus = outcome.status === "applied" ? "applied" : "approved";
    const notes = [review_notes, outcome.message].filter((s) => typeof s === "string" && s.trim()).join("；");
    const { error: updateError } = await supabase.from("contributions")
      .update({
        status: finalStatus,
        review_notes: notes,
        reviewed_by: reviewer,
        reviewed_at: now,
        applied_politician_id: outcome.politician_id ?? null,
        applied_policy_id: outcome.policy_id ?? null,
      })
      .eq("id", row.id);
    if (updateError) throw new Error(`contributions update: ${updateError.message}`);

    return json({
      success: outcome.status !== "failed",
      contribution_id: row.id,
      status: finalStatus,
      outcome,
    }, outcome.status === "failed" ? 422 : 200);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("apply error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
