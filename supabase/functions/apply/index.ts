import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { applyContribution, type ContributionRow, contributionStatusFor } from "../_shared/apply-contribution.ts";
import { executeRevert } from "../_shared/edit-history.ts";
import { closeTask, createTask, validateTaskInput } from "../_shared/task-admin.ts";

/**
 * apply — 維護者用（需 AI_IMPORT_API_KEY）。verified 的貢獻已由 /report／apply-verified 自動落庫，這支處理：
 *   POST { api_key, action: "list", status?, limit? }                     → 列（預設 disputed + apply_failed + pending）
 *   POST { api_key, action: "approve", contribution_id, reviewed_by?, review_notes?, resolved_politician_id? } → 手動落庫（disputed／apply_failed／pending 都可；
 *        身份爭議時帶 resolved_politician_id 指定是哪一位）
 *   POST { api_key, action: "reject",  contribution_id, reviewed_by?, review_notes }  → 退件
 *   POST { api_key, action: "revert",  contribution_id, reviewed_by?, review_notes? } → 依 edit_history 把該貢獻造成的變更全部倒回，標 reverted
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const ROW_COLUMNS = "id, contribution_type, payload, source_urls, note, agent_name, contributor_url, status, review_notes, created_at, applied_at";
const APPROVABLE = new Set(["pending", "verified", "disputed", "apply_failed"]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const expectedApiKey = Deno.env.get("AI_IMPORT_API_KEY");
    if (!expectedApiKey) return json({ success: false, error: "AI_IMPORT_API_KEY is not configured" }, 500);
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const body = await req.json().catch(() => null);
    if (!body || body.api_key !== expectedApiKey) return json({ success: false, error: "Invalid api_key" }, 401);

    const { action, contribution_id, reviewed_by, review_notes } = body;
    const reviewer = typeof reviewed_by === "string" ? reviewed_by : "maintainer";
    const now = new Date().toISOString();

    if (action === "list") {
      const statuses = body.status ? [body.status] : ["disputed", "apply_failed", "pending"];
      const { data, error } = await supabase.from("contributions").select(ROW_COLUMNS).in("status", statuses)
        .order("created_at", { ascending: true }).limit(Math.min(Number(body.limit) || 50, 200));
      if (error) throw new Error(`contributions list: ${error.message}`);
      return json({ success: true, count: data?.length ?? 0, contributions: data ?? [] });
    }

    if (action === "create_task") {
      const v = validateTaskInput(body.task);
      if (!v.ok || !v.input) return json({ success: false, error: "validation_failed", errors: v.errors }, 400);
      const task = await createTask(supabase, v.input, { source: "manual", created_by: reviewer });
      return json({ success: true, task }, 201);
    }
    if (action === "close_task") {
      if (typeof body.task_id !== "string") return json({ success: false, error: "缺 task_id" }, 400);
      const task = await closeTask(supabase, body.task_id, reviewer);
      if (!task) return json({ success: false, error: "not_found" }, 404);
      return json({ success: true, task });
    }
    if (action === "list_tasks") {
      const { data, error } = await supabase.from("contribution_tasks").select("*").order("status").order("priority", { ascending: false }).order("created_at", { ascending: false }).limit(200);
      if (error) throw new Error(`contribution_tasks list: ${error.message}`);
      return json({ success: true, count: data?.length ?? 0, tasks: data ?? [] });
    }

    if (!["approve", "reject", "revert"].includes(action)) return json({ success: false, error: "action 要是 list／approve／reject／revert／create_task／close_task／list_tasks" }, 400);
    if (typeof contribution_id !== "string") return json({ success: false, error: "缺 contribution_id" }, 400);

    const { data: row, error } = await supabase.from("contributions").select(ROW_COLUMNS).eq("id", contribution_id).maybeSingle();
    if (error) throw new Error(`contributions lookup: ${error.message}`);
    if (!row) return json({ success: false, error: "not_found" }, 404);

    if (action === "reject") {
      if (typeof review_notes !== "string" || !review_notes.trim()) return json({ success: false, error: "退件要寫 review_notes（貢獻者看得到）" }, 400);
      if (row.status === "applied") return json({ success: false, error: "已 applied，要撤回請用 revert" }, 409);
      const { error: e } = await supabase.from("contributions").update({ status: "rejected", review_notes, reviewed_by: reviewer, reviewed_at: now }).eq("id", row.id);
      if (e) throw new Error(`contributions reject: ${e.message}`);
      return json({ success: true, contribution_id: row.id, status: "rejected" });
    }

    if (action === "revert") {
      if (row.status !== "applied") return json({ success: false, error: `只有 applied 能 revert（目前 ${row.status}）` }, 409);
      const result = await executeRevert(supabase, row.id, reviewer);
      const notes = [row.review_notes, `[revert by ${reviewer}] 還原 ${result.reverted} 個變更${review_notes ? `：${review_notes}` : ""}`].filter(Boolean).join("；");
      const { error: e } = await supabase.from("contributions").update({ status: "reverted", review_notes: notes, reviewed_by: reviewer, reviewed_at: now }).eq("id", row.id);
      if (e) throw new Error(`contributions mark reverted: ${e.message}`);
      return json({ success: true, contribution_id: row.id, status: "reverted", reverted: result.reverted, steps: result.steps });
    }

    // approve
    if (!APPROVABLE.has(row.status)) return json({ success: false, error: `已是 ${row.status}，不能再審` }, 409);
    const resolvedPoliticianId = typeof body.resolved_politician_id === "string" ? body.resolved_politician_id : null;
    const outcome = await applyContribution(supabase, { ...(row as ContributionRow), resolved_politician_id: resolvedPoliticianId });
    const finalStatus = contributionStatusFor(outcome.status);
    const notes = [review_notes, outcome.message].filter((s) => typeof s === "string" && s.trim()).join("；");
    const { error: updateError } = await supabase.from("contributions").update({
      status: finalStatus,
      review_notes: notes,
      reviewed_by: reviewer,
      reviewed_at: now,
      applied_at: finalStatus === "applied" ? now : null,
      applied_politician_id: outcome.politician_id ?? null,
      applied_policy_id: outcome.policy_id ?? null,
    }).eq("id", row.id);
    if (updateError) throw new Error(`contributions update: ${updateError.message}`);

    return json({ success: outcome.status !== "failed", contribution_id: row.id, status: finalStatus, outcome }, outcome.status === "failed" ? 422 : 200);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("apply error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
