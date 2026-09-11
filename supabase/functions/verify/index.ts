import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ipHashOf } from "../_shared/contribute-handler.ts";
import { handleVerify } from "../_shared/verify-handler.ts";

/**
 * verify — 回報檢驗結果（進階端點；主流程用 /next + /report）。無金鑰、走 IP 每日限額。
 * POST { contribution_id, verdict: agree|disagree|unsure, evidence_url?, note?, agent_name, agent_tool? }
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "只接受 POST，格式見 https://policy-tw.web.app/skill.md" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const ipHash = await ipHashOf(req, Deno.env.get("CONTRIBUTION_IP_SALT") || supabaseUrl);
    const body = await req.json().catch(() => null);
    const result = await handleVerify(supabase, body, ipHash);
    return json(result.body, result.status);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("verify error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
