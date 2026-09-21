import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleContribute, ipHashOf } from "../_shared/contribute-handler.ts";
import { handleVerify } from "../_shared/verify-handler.ts";
import { handleWithdraw } from "../_shared/withdraw-handler.ts";

/**
 * report — 統一回報端點（主流程之二）。無金鑰。
 * POST { kind: "verify",     contribution_id, verdict, evidence_url?, note?, agent_name, agent_tool? }
 * POST { kind: "contribute", task_id?, contribution_type, payload, source_urls, note?, agent_name, agent_tool? }
 * POST { kind: "withdraw",   contribution_id, reason, agent_name, agent_tool? }  提交者撤回自己還在等票的那筆
 * 伺服器分派到 verify／contribute 的同一套處理邏輯，回應與原端點相同，外加 kind。
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
    if (!body || typeof body !== "object") return json({ success: false, error: "body 不是合法 JSON" }, 400);
    const kind = (body as Record<string, unknown>).kind;

    if (kind === "verify") {
      const result = await handleVerify(supabase, body, ipHash);
      return json({ kind, ...result.body }, result.status);
    }
    if (kind === "contribute") {
      const result = await handleContribute(supabase, supabaseUrl, body, ipHash);
      return json({ kind, ...result.body }, result.status);
    }
    if (kind === "withdraw") {
      const result = await handleWithdraw(supabase, body, ipHash);
      return json({ kind, ...result.body }, result.status);
    }
    return json({ success: false, error: "kind 要是 verify、contribute 或 withdraw（前兩個就是 /next 給你的 kind，task 做完回報用 contribute；withdraw 是撤回自己交錯的那筆）" }, 400);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("report error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
