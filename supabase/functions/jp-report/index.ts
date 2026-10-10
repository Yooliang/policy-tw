import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { JP_PROTOCOL_URL } from "../_shared/jp/protocol.ts";
import { jpClient } from "../_shared/jp/client.ts";
import { handleContribute, ipHashOf } from "../_shared/jp/contribute-handler.ts";
import { handleVerify } from "../_shared/jp/verify-handler.ts";
import { jpApplyViaRpc } from "../_shared/jp/apply-contribution.ts";
import { handleWithdraw } from "../_shared/jp/withdraw-handler.ts";
import { jpDispatchTokenSecretFrom } from "../_shared/jp/dispatch-secret.ts";

/**
 * jp-report — 日本站統一回報端點（對應正見的 report）。無金鑰，誰都能用（同正見 report）。
 * POST { kind: "verify",     contribution_id, verdict, evidence_url?, note?, agent_name, agent_tool?, dispatch_token? }
 * POST { kind: "contribute", task_id?, contribution_type: no_change|task_suggestion|correction|election|local_government|regional_stat|candidacy|politician|policy, payload, source_urls, ... }
 * POST { kind: "withdraw",   contribution_id, reason, agent_name, agent_tool? }
 * 只讀寫 schema policy_jp。通過同儕驗證（verified）的貢獻立刻落庫（SQL policy_jp.apply_contribution，見 _shared/jp/apply-contribution.ts）：
 * election／local_government／regional_stat／candidacy／politician／policy 寫進正式表、no_change 記冷卻；task_suggestion、correction 維持 verified。漏網的由 pg_cron 掃（apply_verified_pending）。
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
  if (req.method !== "POST") return json({ success: false, error: `只接受 POST，格式見 ${JP_PROTOCOL_URL}` }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabase = jpClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const ipSalt = Deno.env.get("CONTRIBUTION_IP_SALT") || supabaseUrl;
    const ipHash = await ipHashOf(req, ipSalt);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ success: false, error: "body 不是合法 JSON" }, 400);
    const kind = (body as Record<string, unknown>).kind;

    const dispatchSecret = jpDispatchTokenSecretFrom((k) => Deno.env.get(k));
    if (kind === "verify") {
      const result = await handleVerify(supabase, body, ipHash, jpApplyViaRpc, "report", dispatchSecret);
      return json({ kind, ...result.body }, result.status);
    }
    if (kind === "contribute") {
      const result = await handleContribute(supabase, supabaseUrl, body, ipHash, undefined, "report", dispatchSecret, jpApplyViaRpc);
      return json({ kind, ...result.body }, result.status);
    }
    if (kind === "withdraw") {
      const result = await handleWithdraw(supabase, body, ipHash, dispatchSecret);
      return json({ kind, ...result.body }, result.status);
    }
    return json({ success: false, error: "kind 要是 verify、contribute 或 withdraw" }, 400);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("jp-report error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
