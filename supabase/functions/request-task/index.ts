import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ipHashOf } from "../_shared/contribute-handler.ts";
import { AUDIT_NOTE_MAX, buildRequestTaskText, decideRequest, isAuditUrl, isRequestKind, KIND_TO_TASK_TYPE, POLICY_KINDS, REQUEST_DAILY_LIMIT_PER_IP } from "../_shared/request-task.ts";
import { createTask, findOpenTaskForTarget, findRecentAuditTask } from "../_shared/task-admin.ts";

/**
 * request-task — 網站「請 AI 幫忙查」按鈕（公開、無金鑰、每 IP 每日 20 次）。
 * POST { politician_id?, policy_id?, kind: "policy"|"profile"|"progress"|"validity", requester?: "web" }
 *   → 同目標已有同型別 open 任務或對應自動缺口：{ status:"already_queued", task_id, queue_position, open_tasks, board_url }
 *   → 否則建一筆 contribution_tasks（source=web_request、priority 2，排在公民提問之後）：{ status:"queued", task_id, … }
 * POST { kind: "audit", source_url, policy_id?, politician_id?, note? }（政見深度分析頁「執行稽核」）
 *   → 同網址＋同目標 24 小時內已建過：already_queued（reason=duplicate_url）；否則建 task_type=audit、target.source_url=網址
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
// 這是前端頁面的網址：部署這支之前，正式站的 /tasks 要先是 200（前端先上、這支後上）。
const BOARD_URL = "https://policy-tw.web.app/tasks";
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

    const kind = body.kind;
    const politicianId = typeof body.politician_id === "string" && UUID_RE.test(body.politician_id) ? body.politician_id : null;
    const policyId = typeof body.policy_id === "string" && UUID_RE.test(body.policy_id) ? body.policy_id : null;
    if (!isRequestKind(kind)) return json({ success: false, error: "kind 要是 policy／profile／progress／validity／audit" }, 400);
    const sourceUrl = kind === "audit" && isAuditUrl(body.source_url) ? String(body.source_url).trim() : null;
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, AUDIT_NOTE_MAX) : null;
    if (kind === "audit" && !sourceUrl) return json({ success: false, error: "invalid_url", message: "請貼可以打開的 http(s) 網址" }, 400);
    const isPolicyKind = POLICY_KINDS.includes(kind);
    if (isPolicyKind && !policyId) return json({ success: false, error: `kind=${kind} 要帶 policy_id` }, 400);
    if ((kind === "policy" || kind === "profile") && !politicianId) return json({ success: false, error: "要帶 politician_id" }, 400);

    // 目標存在？順便拿名字
    let politician: { id: string; name: string; region: string | null } | null = null;
    let policy: { id: string; title: string; politician_id: string } | null = null;
    if (policyId) {
      const { data, error } = await supabase.from("policies").select("id, title, politician_id").eq("id", policyId).maybeSingle();
      if (error) throw new Error(`policies lookup: ${error.message}`);
      if (!data) return json({ success: false, error: "not_found", message: "找不到這條政見" }, 404);
      policy = data;
    }
    const pid = politicianId ?? policy?.politician_id ?? null;
    if (pid) {
      const { data, error } = await supabase.from("politicians").select("id, name, region").eq("id", pid).maybeSingle();
      if (error) throw new Error(`politicians lookup: ${error.message}`);
      if (!data) return json({ success: false, error: "not_found", message: "找不到這位政治人物" }, 404);
      politician = data;
    }

    // 限額（用 contribution_tasks 自己的列數算）
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { count: usedToday, error: countError } = await supabase.from("contribution_tasks").select("id", { count: "exact", head: true })
      .eq("requester_ip_hash", ipHash).gte("created_at", todayStart.toISOString());
    if (countError) throw new Error(`rate limit lookup: ${countError.message}`);

    // 已有 open 任務？已有對應自動缺口？（audit 不看這兩項，改看同網址 24 小時去重）
    const taskType = KIND_TO_TASK_TYPE[kind];
    const existing = kind === "audit" ? null : await findOpenTaskForTarget(supabase, { politician_id: isPolicyKind ? null : pid, policy_id: policyId, task_type: taskType });
    const targetId = isPolicyKind ? policyId : pid;
    let autoGap: { task_id: string } | null = null;
    if (kind !== "audit" && targetId) {
      const { data: gaps, error: gapError } = await supabase.rpc("contribution_auto_tasks", { p_type: taskType, p_region: null, p_limit: 100000, p_seed: "" });
      if (gapError) throw new Error(`auto tasks: ${gapError.message}`);
      autoGap = ((gaps ?? []) as Array<{ task_id: string }>).find((g) => g.task_id.endsWith(`:${targetId}`)) ?? null;
    }
    const duplicateAudit = kind === "audit" && sourceUrl ? await findRecentAuditTask(supabase, { source_url: sourceUrl, politician_id: pid, policy_id: policyId }) : null;

    const [{ count: openManual }, { data: counts }] = await Promise.all([
      supabase.from("contribution_tasks").select("id", { count: "exact", head: true }).eq("status", "open"),
      supabase.rpc("contribution_auto_task_counts", { p_region: null }),
    ]);
    const autoTotal = ((counts ?? []) as Array<{ total: number }>).reduce((a, r) => a + Number(r.total), 0);
    const base = { queue_position: openManual ?? 0, open_tasks: (openManual ?? 0) + autoTotal, board_url: BOARD_URL };

    const decision = decideRequest({
      usedToday: usedToday ?? 0,
      existingOpenTask: existing ? { id: String(existing.id) } : null,
      autoGapTaskId: autoGap?.task_id ?? null,
      duplicateAuditTask: duplicateAudit ? { id: String(duplicateAudit.id) } : null,
    });
    if (decision.action === "rate_limited") {
      return json({ success: false, error: "rate_limited", message: `每個來源每日最多 ${REQUEST_DAILY_LIMIT_PER_IP} 次，明天再試`, ...base }, 429);
    }
    if (decision.action === "already_queued") {
      return json({ success: true, status: "already_queued", task_id: decision.task_id, reason: decision.reason, message: "這個項目已在任務池中，AI 代理會來查", ...base });
    }

    const text = buildRequestTaskText({ kind, politician_id: pid, policy_id: policyId, politician_name: politician?.name ?? null, region: politician?.region ?? null, policy_title: policy?.title ?? null, source_url: sourceUrl, note });
    const task = await createTask(supabase, {
      title: text.title, description: text.description, task_type: taskType,
      target_politician_id: pid, target_policy_id: policyId, region: politician?.region ?? null, hint_sources: text.hint_sources, source_url: sourceUrl,
    }, { source: "web_request", created_by: typeof body.requester === "string" ? body.requester.slice(0, 40) : "web", requester_ip_hash: ipHash });

    return json({ success: true, status: "queued", task_id: task.id, message: "已加入任務池，AI 代理會來查", ...base, queue_position: (openManual ?? 0) + 1, open_tasks: base.open_tasks + 1 }, 201);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("request-task error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
