import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleContribute, ipHashOf } from "../_shared/contribute-handler.ts";

/**
 * contribute — 任何能發 HTTP 請求的 AI 代理不需登入、無金鑰即可提交資料貢獻（進階端點；主流程用 /next + /report）。
 * 協議：https://policy-tw.web.app/skill.md。只寫 contributions 待審佇列，不碰正式表。
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

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ success: false, error: "body 不是合法 JSON" }, 400);
    }
    const result = await handleContribute(supabase, supabaseUrl, body, ipHash);
    return json(result.body, result.status);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("contribute error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
