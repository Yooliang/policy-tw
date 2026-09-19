import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * ditrust-agent — 正見登入者的 DiTrust 代理身份。設計見 docs/BLUEPRINT-agent-identity.md §4。
 *
 * POST { action: "link" | "reveal" | "rotate" }，Authorization: Bearer <登入者的 JWT>
 *   link   → 用登入信箱向 DiTrust 開戶或連結（provision）。回 { agent_id, created, secret? }：
 *            secret 只在剛開戶那一次回，之後要看用 reveal。
 *   reveal → 回目前的序號 { agent_id, secret }
 *   rotate → 換一把新序號、舊的立刻失效 { agent_id, secret }
 *
 * 為什麼要這支、而不是前端直接打 DiTrust：
 *   DiTrust 的三支管理端點靠 clients.api_key（x-client-key）驗，那把金鑰不能進瀏覽器。
 *   這支在伺服器端拿正見 secrets 裡的 DITRUST_CLIENT_KEY 代使用者呼叫，並且**只用 session 裡的信箱**——
 *   請求本文不能指定信箱，不然任何登入者都能宣稱別人的信箱（§4 護欄一）。
 *
 * 正見不存序號（§4 護欄二）：這支只是通道，回應直接交給瀏覽器，不落地、不記 log。
 * agent_id ＝ auth.users.id ＝ 這位使用者的 auth.uid()（共用 auth.users），所以正見不需要任何連結欄位。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ACTIONS: Record<string, string> = { link: "agents-provision", reveal: "agents-reveal", rotate: "agents-rotate" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "只收 POST" }, 405);
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const clientKey = Deno.env.get("DITRUST_CLIENT_KEY");
    if (!clientKey) return json({ success: false, error: "DITRUST_CLIENT_KEY is not configured" }, 500);

    // 信箱只從登入 session 取
    const auth = req.headers.get("Authorization") ?? "";
    const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (!token) return json({ success: false, error: "請先登入" }, 401);
    const service = createClient(supabaseUrl, serviceKey);
    const { data: { user }, error: authError } = await service.auth.getUser(token);
    if (authError || !user?.email) return json({ success: false, error: "請先登入" }, 401);
    const email = user.email.trim().toLowerCase();

    const body = await req.json().catch(() => ({})) as { action?: string };
    const fn = ACTIONS[String(body.action ?? "")];
    if (!fn) return json({ success: false, error: "action 必須是 link／reveal／rotate" }, 400);

    const res = await fetch(`${supabaseUrl}/functions/v1/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}`, "x-client-key": clientKey },
      body: JSON.stringify({ email }),
    });
    const out = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!res.ok || !out?.success) {
      // reveal／rotate 對還沒開戶的帳號回 404：告訴前端先 link
      const code = res.status === 404 ? 404 : res.status === 429 ? 429 : 502;
      return json({ success: false, error: res.status === 404 ? "還沒建立代理身份，請先連結" : res.status === 429 ? "操作太頻繁，稍後再試" : `DiTrust 回應 ${res.status}` }, code);
    }
    const agentId = String(out.agent_id ?? "");
    return json({
      success: true,
      agent_id: agentId,
      actor_id: `ditrust:${agentId}`,
      created: out.created === true,
      // 序號只在開戶那次與 reveal／rotate 時有；沒有就是 undefined，前端據此決定要不要顯示「顯示序號」
      secret: typeof out.secret === "string" ? out.secret : undefined,
    });
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
