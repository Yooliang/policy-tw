import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ipHashOf } from "../_shared/contribute-handler.ts";
import { isStance, stanceValue, STANCE_DAILY_LIMIT_PER_IP } from "../_shared/question-stance.ts";

/**
 * question-stance — 讀者對一則提問表態「贊同／不贊同這題值得被回答」（公開、無金鑰、每 IP 每日 20 次）。
 * POST { question_id✅, stance✅（up／down） }
 *   → upsert 到 question_stances（同一 IP 同一題重複表態＝改成新值，不是報錯）；
 *     DB trigger 會同步 citizen_questions.stance_up／stance_down，回應直接帶更新後的計數。
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

    const questionId = typeof body.question_id === "string" && UUID_RE.test(body.question_id) ? body.question_id : null;
    if (!questionId) return json({ success: false, error: "invalid_question_id", message: "question_id 必填（uuid）" }, 400);
    if (!isStance(body.stance)) return json({ success: false, error: "invalid_stance", message: "stance 要是 up 或 down" }, 400);

    const { data: question, error: qError } = await supabase.from("citizen_questions").select("id, status").eq("id", questionId).maybeSingle();
    if (qError) throw new Error(`citizen_questions lookup: ${qError.message}`);
    if (!question || question.status === "hidden") return json({ success: false, error: "not_found", message: "找不到這個提問" }, 404);

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { count: usedToday, error: countError } = await supabase.from("question_stances").select("id", { count: "exact", head: true })
      .eq("voter_ip_hash", ipHash).gte("created_at", todayStart.toISOString());
    if (countError) throw new Error(`rate limit lookup: ${countError.message}`);
    if ((usedToday ?? 0) >= STANCE_DAILY_LIMIT_PER_IP) {
      return json({ success: false, error: "rate_limited", message: `每個來源每日最多表態 ${STANCE_DAILY_LIMIT_PER_IP} 次，明天再試` }, 429);
    }

    // 同一個 IP 對同一題重複表態＝改成新值：交給 UNIQUE (question_id, voter_ip_hash) 做 upsert，不是報錯
    const { error: upsertError } = await supabase.from("question_stances").upsert(
      { question_id: questionId, voter_ip_hash: ipHash, stance: stanceValue(body.stance) },
      { onConflict: "question_id,voter_ip_hash" },
    );
    if (upsertError) throw new Error(`question_stances upsert: ${upsertError.message}`);

    const { data: updated, error: readError } = await supabase.from("citizen_questions").select("stance_up, stance_down").eq("id", questionId).maybeSingle();
    if (readError) throw new Error(`citizen_questions read: ${readError.message}`);

    return json({ success: true, question_id: questionId, stance: body.stance, stance_up: updated?.stance_up ?? 0, stance_down: updated?.stance_down ?? 0 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("question-stance error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
