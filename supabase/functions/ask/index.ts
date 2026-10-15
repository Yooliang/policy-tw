import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { loginWalledOnly, LOGIN_WALLED_MESSAGE } from "../_shared/question-intake.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ipHashOf } from "../_shared/contribute-handler.ts";
import { ASK_DAILY_LIMIT_PER_IP, buildAskTaskTitle, decideAsk, isValidQuestionLength, QUESTION_MAX_LEN, QUESTION_MIN_LEN } from "../_shared/ask.ts";
import { createTask, QUESTION_PRIORITY } from "../_shared/task-admin.ts";
import { askJev, jevKeyFromEnv, stripNulDeep } from "../_shared/system-one.ts";
import { ASK_SCREEN_QUESTION, ASK_SCREEN_SUBJECT, screenQuestion } from "../_shared/ask-screen.ts";
import { sha256Hex } from "../_shared/contribution-schema.ts";

/**
 * ask — 網站訪客「問一句話」（公開、無金鑰、每 IP 每日 20 次）。
 * 只收民眾自己打字的提問；政見頁／人物頁的按鈕走 request-task，不經過這裡。
 * POST { question✅, policy_id?, politician_id?, region? }
 *   → 建一筆 citizen_questions ＋一筆 contribution_tasks（task_type="question"、source="web_request"），
 *     `/next` 會派給代理去找有出處的答案；同一題最多收 3 份不同代理的答案。
 *   → 內容太短／灌水詞堆疊 → 400；24 小時內問過幾乎一樣的話 → 409；超額 → 429。
 *   → 以上都過了、建提問之前，先問 Jev 一題（可答／無關／隱私，見 _shared/ask-screen.ts）：
 *     判成無關或隱私且機率達門檻 → 400（error=off_topic／privacy，message 是給訪客看的白話）；
 *     Jev 金鑰沒設、逾時、出錯 → 照舊收下，只記 console.error。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DUPLICATE_WINDOW_HOURS = 24;

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

    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!isValidQuestionLength(question)) {
      return json({ success: false, error: "invalid_question", message: `question 必填，${QUESTION_MIN_LEN}～${QUESTION_MAX_LEN} 字` }, 400);
    }
    // 只有需登入的社群連結：代理讀不到，入口就退（2026-09-20）
    if (loginWalledOnly(question)) return json({ success: false, error: "login_walled_link", message: LOGIN_WALLED_MESSAGE }, 400);
    const policyId = typeof body.policy_id === "string" && UUID_RE.test(body.policy_id) ? body.policy_id : null;
    if (body.policy_id !== undefined && body.policy_id !== null && !policyId) return json({ success: false, error: "invalid_policy_id", message: "policy_id 要是 uuid" }, 400);
    const politicianId = typeof body.politician_id === "string" && UUID_RE.test(body.politician_id) ? body.politician_id : null;
    if (body.politician_id !== undefined && body.politician_id !== null && !politicianId) return json({ success: false, error: "invalid_politician_id", message: "politician_id 要是 uuid" }, 400);
    const region = typeof body.region === "string" && body.region.trim() ? body.region.replace(/臺/g, "台").trim() : null;

    // 目標存在？（有給才查，兩個都可以不給——代表全國性議題）
    if (policyId) {
      const { data, error } = await supabase.from("policies").select("id").eq("id", policyId).maybeSingle();
      if (error) throw new Error(`policies lookup: ${error.message}`);
      if (!data) return json({ success: false, error: "not_found", message: "找不到這條政見" }, 400);
    }
    if (politicianId) {
      const { data, error } = await supabase.from("politicians").select("id").eq("id", politicianId).maybeSingle();
      if (error) throw new Error(`politicians lookup: ${error.message}`);
      if (!data) return json({ success: false, error: "not_found", message: "找不到這位政治人物" }, 400);
    }

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const since24h = new Date(Date.now() - DUPLICATE_WINDOW_HOURS * 3600 * 1000).toISOString();
    const [{ count: usedToday, error: countError }, { data: recentRows, error: recentError }] = await Promise.all([
      supabase.from("citizen_questions").select("id", { count: "exact", head: true }).eq("asker_ip_hash", ipHash).gte("created_at", todayStart.toISOString()),
      // query-bounds: ok — 同一個 IP 24 小時內問過的題目，本來就被每日額度壓在兩位數
      supabase.from("citizen_questions").select("question").eq("asker_ip_hash", ipHash).gte("created_at", since24h),
    ]);
    if (countError) throw new Error(`rate limit lookup: ${countError.message}`);
    if (recentError) throw new Error(`recent questions lookup: ${recentError.message}`);
    const recentQuestions = ((recentRows ?? []) as Array<{ question: string }>).map((r) => r.question);

    const decision = decideAsk({ usedToday: usedToday ?? 0, question, recentQuestions });
    if (decision.action === "rate_limited") {
      return json({ success: false, error: "rate_limited", message: `每個來源每日最多問 ${ASK_DAILY_LIMIT_PER_IP} 題，明天再試` }, 429);
    }
    if (decision.action === "rejected" && decision.reason === "low_effort") {
      return json({ success: false, error: "low_effort", message: "這句話看不出想問什麼，請具體一點（例如問某個政見、某個施政項目）" }, 400);
    }
    if (decision.action === "rejected" && decision.reason === "duplicate") {
      return json({ success: false, error: "duplicate", message: "你在 24 小時內問過幾乎一樣的問題了，正在等代理回答，請稍後查看結果" }, 409);
    }

    // Jev 先篩（2026-10-15）：壞掉一律放行，不因為篩選故障就關掉提問
    const apiKey = jevKeyFromEnv((k) => Deno.env.get(k));
    const screen = await screenQuestion(question, apiKey ? (state, questions) => askJev(apiKey, state, questions) : null);
    if (screen.error) console.error("ask screen skipped:", screen.error);
    if (screen.response) {
      // 判決記進 jev_decisions（subject_id＝提問文字的雜湊；不存 IP）。寫不進去不影響提問
      try {
        const a = screen.response.answers[ASK_SCREEN_QUESTION];
        const { error: recError } = await supabase.from("jev_decisions").upsert(stripNulDeep([{
          subject_type: ASK_SCREEN_SUBJECT, subject_id: await sha256Hex(question), question: ASK_SCREEN_QUESTION,
          choice: screen.verdict.choice ?? a?.choice ?? "unknown", probability: screen.verdict.probability,
          confidence: a?.confidence ?? null, probabilities: a?.probabilities ?? null, model: screen.response.model,
          state: screen.state, cost_usd: Number(screen.response.usage.cost.toFixed(8)),
        }]), { onConflict: "subject_type,subject_id,question,model,state_hash", ignoreDuplicates: true });
        if (recError) console.error("ask screen record failed:", recError.message);
      } catch (e) {
        console.error("ask screen record failed:", e instanceof Error ? e.message : String(e));
      }
    }
    if (screen.verdict.action === "block") {
      return json({ success: false, error: screen.verdict.error, message: screen.verdict.message }, 400);
    }

    const { data: inserted, error: insertError } = await supabase.from("citizen_questions").insert({
      question, policy_id: policyId, politician_id: politicianId, region, asker_ip_hash: ipHash,
    }).select("id").maybeSingle();
    if (insertError) throw new Error(`citizen_questions insert: ${insertError.message}`);
    if (!inserted) throw new Error("citizen_questions insert 沒有回傳 id");

    const task = await createTask(supabase, {
      title: buildAskTaskTitle(question),
      description: question,
      task_type: "question",
      // 派工順序：公民提問 > 任務清單 > 自動缺口（見 task-admin.ts 的 DEFAULT_PRIORITY）
      priority: QUESTION_PRIORITY,
      target_politician_id: politicianId,
      target_policy_id: policyId,
      region,
      target_extra: { question_id: inserted.id },
    }, { source: "web_request", created_by: "web", requester_ip_hash: ipHash });

    const { error: linkError } = await supabase.from("citizen_questions").update({ task_id: task.id }).eq("id", inserted.id);
    if (linkError) console.error("citizen_questions link task_id failed:", linkError.message);

    return json({ success: true, question_id: inserted.id, task_id: task.id, message: "已收到你的問題，AI 代理會去找有出處的答案，同一題最多會有 3 份不同的回答" }, 201);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("ask error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
