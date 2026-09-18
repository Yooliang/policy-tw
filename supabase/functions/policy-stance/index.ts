import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ipHashOf } from "../_shared/contribute-handler.ts";
import { isPolicyStance, POLICY_STANCE_DAILY_LIMIT_PER_IP, policyStanceValue } from "../_shared/policy-stance.ts";

/**
 * policy-stance — 讀者對一條既有政見表態（公開、無金鑰、每 IP 每日 30 次）。
 * POST { policy_id✅, stance✅（support／oppose；priority 已改成⭐，見 migration 20260918000003） }
 *   → upsert 到 policy_stances（同一 IP 同一條政見重複表態＝改成新值，不是報錯）；
 *     DB trigger 會同步 policies 上的三個計數，回應直接帶更新後的數字。
 *
 * 這不影響任何資料的真假判定——政見內容仍然只由附來源的貢獻與同儕驗證決定。
 * 這裡收的是民意，讓政見頁看得出「多少人支持、多少人反對、多少人覺得該優先做」。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "只接受 POST" }, 405);
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const ipHash = await ipHashOf(req, Deno.env.get("CONTRIBUTION_IP_SALT") || supabaseUrl);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ success: false, error: "body 不是合法 JSON" }, 400);

    const policyId = typeof body.policy_id === "string" && UUID_RE.test(body.policy_id) ? body.policy_id : null;
    if (!policyId) return json({ success: false, error: "invalid_policy_id", message: "policy_id 必填（uuid）" }, 400);
    if (!isPolicyStance(body.stance)) {
      return json({ success: false, error: "invalid_stance", message: "stance 要是 support、oppose 或 priority" }, 400);
    }

    // 「關注」從 2026-09-18 起不是表態了：改成按⭐、只算登入的人（user_checkpoints）。
    // 還開著的舊頁面可能照舊送 priority——不能再以 IP 計數，也不要假裝成功，告訴他怎麼做。
    if (body.stance === "priority") {
      return json({ success: false, error: "moved", message: "「關注」改成按政見旁的⭐，登入後會計入關注數。請重新整理頁面" }, 400);
    }

    // 已軟移除的政見不收表態：頁面上看不到它，也不該再累積民意
    const { data: policy, error: pError } = await supabase.from("policies").select("id, removed_at").eq("id", policyId).maybeSingle();
    if (pError) throw new Error(`policies lookup: ${pError.message}`);
    if (!policy || policy.removed_at) return json({ success: false, error: "not_found", message: "找不到這條政見" }, 404);

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { count: usedToday, error: countError } = await supabase.from("policy_stances").select("id", { count: "exact", head: true })
      .eq("voter_ip_hash", ipHash).gte("created_at", todayStart.toISOString());
    if (countError) throw new Error(`rate limit lookup: ${countError.message}`);
    if ((usedToday ?? 0) >= POLICY_STANCE_DAILY_LIMIT_PER_IP) {
      return json({ success: false, error: "rate_limited", message: `每個來源每日最多表態 ${POLICY_STANCE_DAILY_LIMIT_PER_IP} 次，明天再試` }, 429);
    }

    // 同一個 IP 對同一條政見重複表態＝改成新值：交給 UNIQUE (policy_id, voter_ip_hash) 做 upsert
    const { error: upsertError } = await supabase.from("policy_stances").upsert(
      { policy_id: policyId, voter_ip_hash: ipHash, stance: policyStanceValue(body.stance), updated_at: new Date().toISOString() },
      { onConflict: "policy_id,voter_ip_hash" },
    );
    if (upsertError) throw new Error(`policy_stances upsert: ${upsertError.message}`);

    const { data: updated, error: readError } = await supabase.from("policies")
      .select("stance_support, stance_oppose, stance_priority").eq("id", policyId).maybeSingle();
    if (readError) throw new Error(`policies read: ${readError.message}`);

    return json({
      success: true,
      policy_id: policyId,
      stance: body.stance,
      stance_support: updated?.stance_support ?? 0,
      stance_oppose: updated?.stance_oppose ?? 0,
      stance_priority: updated?.stance_priority ?? 0,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("policy-stance error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
