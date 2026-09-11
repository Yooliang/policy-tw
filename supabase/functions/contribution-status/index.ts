import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requiredAgree } from "../_shared/consensus.ts";

/**
 * contribution-status — 查單筆貢獻的審核狀態：GET ?id=<uuid>
 * contributions 表對 anon 關閉，只透過這支用 service role 代查、只回必要欄位。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    let id = url.searchParams.get("id");
    if (!id && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      id = typeof body?.id === "string" ? body.id : null;
    }
    if (!id || !UUID_RE.test(id)) return json({ success: false, error: "缺少或不合法的 id（uuid）" }, 400);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data, error } = await supabase
      .from("contributions")
      .select("id, contribution_type, payload, source_urls, status, agree_count, disagree_count, unsure_count, review_notes, reviewed_at, applied_at, applied_politician_id, applied_policy_id, created_at")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`contributions lookup: ${error.message}`);
    if (!data) return json({ success: false, error: "not_found" }, 404);
    const { count: editCount, error: editError } = await supabase.from("edit_history").select("id", { count: "exact", head: true }).eq("contribution_id", id);
    if (editError) throw new Error(`edit_history count: ${editError.message}`);

    const { payload, source_urls: _sourceUrls, ...rest } = data;
    return json({
      success: true,
      contribution: {
        ...rest,
        required_agree: requiredAgree(data.contribution_type, payload, data.source_urls ?? []),
        edit_history_count: editCount ?? 0,
        ...(data.applied_politician_id ? { politician_url: `https://policy-tw.web.app/politician/${data.applied_politician_id}` } : {}),
        ...(data.applied_policy_id ? { policy_url: `https://policy-tw.web.app/policy/${data.applied_policy_id}` } : {}),
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("contribution-status error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
