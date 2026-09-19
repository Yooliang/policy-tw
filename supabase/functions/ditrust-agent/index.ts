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
 *   rename → 改代號 { display_name }（IDN-R19）：撞名 409、七天冷卻 429、保留前綴 400。
 *            link 會把 Google 名字當預設代號送過去（DiTrust 只在還沒有名字時寫入），使用者再用 rename 改成想要的。
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
const ACTIONS: Record<string, string> = { link: "agents-provision", reveal: "agents-reveal", rotate: "agents-rotate", rename: "agents-rename" };

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

    const body = await req.json().catch(() => ({})) as { action?: string; display_name?: string };
    const action = String(body.action ?? "");
    const fn = ACTIONS[action];
    if (!fn) return json({ success: false, error: "action 必須是 link／reveal／rotate／rename" }, 400);

    const payload: Record<string, unknown> = { email };
    if (action === "link") {
      // 預設代號用 Google 名字；DiTrust 只在還沒有名字時寫入，之後使用者用 rename 改
      const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
      const guess = [meta.full_name, meta.name].find((v) => typeof v === "string" && v.trim());
      if (typeof guess === "string") payload.display_name = guess.trim().slice(0, 64);
    }
    if (action === "rename") {
      const name = typeof body.display_name === "string" ? body.display_name.trim() : "";
      if (!name) return json({ success: false, error: "display_name 必填" }, 400);
      payload.display_name = name;
    }

    const res = await fetch(`${supabaseUrl}/functions/v1/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}`, "x-client-key": clientKey },
      body: JSON.stringify(payload),
    });
    const out = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!res.ok || !out?.success) {
      const err = String(out?.error ?? "");
      // 錯誤翻成給人看的中文；Retry-After 原樣轉給前端算「幾天後可以再改」
      const map: Record<string, [number, string]> = {
        name_taken: [409, "這個代號已經有人用了，換一個"],
        rename_cooldown: [429, "代號七天內只能改一次，請稍後再試"],
        reserved_name: [400, "ditrust- 開頭是系統保留的，不能當代號"],
        invalid_display_name: [400, "代號要 2～64 字，只能用字母、數字、中文與 . _ -"],
        not_found: [404, "還沒建立代理身份，請先連結"],
      };
      const [code, msg] = map[err] ?? (res.status === 404 ? [404, "還沒建立代理身份，請先連結"] : res.status === 429 ? [429, "操作太頻繁，稍後再試"] : [502, `DiTrust 回應 ${res.status}`]);
      const retry = res.headers.get("retry-after");
      return json({ success: false, error: msg, code: err || undefined, retry_after_seconds: retry ? Number(retry) : undefined }, code);
    }
    const agentId = String(out.agent_id ?? "");
    return json({
      success: true,
      agent_id: agentId,
      actor_id: `ditrust:${agentId}`,
      created: out.created === true,
      // 序號只在開戶那次與 reveal／rotate 時有；沒有就是 undefined，前端據此決定要不要顯示「顯示序號」
      secret: typeof out.secret === "string" ? out.secret : undefined,
      display_name: typeof out.display_name === "string" ? out.display_name : null,
      display_name_status: typeof out.display_name_status === "string" ? out.display_name_status : undefined,
    });
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
