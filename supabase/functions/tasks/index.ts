import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * tasks — 領任務（四主端點之一）。無金鑰。
 * GET ?type=&region=&limit=&seed=
 *   回「我們現在缺什麼」：自動缺口（DB 函式 contribution_auto_tasks 即時算）＋維護者手動任務（contribution_tasks）。
 *   預設隨機排序＋limit 20（seed 不同就拿到不同切片），無認領機制；同一任務可能多人做，重複提交會在驗證階段合併。
 *   每筆：task_id、task_type、target、what_we_need、hint_sources、reward、suggested_contribution_type。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const SUGGESTED_TYPE: Record<string, string> = {
  policy_missing: "policy",
  profile_gap: "politician",
  policy_source_missing: "correction",
  progress_stale: "policy_progress",
  candidacy_source_missing: "candidacy",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const url = new URL(req.url);
    const type = url.searchParams.get("type") || null;
    const region = url.searchParams.get("region")?.replace(/臺/g, "台") || null;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
    const seed = url.searchParams.get("seed") || crypto.randomUUID();

    const [autoRes, manualRes, countRes] = await Promise.all([
      supabase.rpc("contribution_auto_tasks", { p_type: type, p_region: region, p_limit: limit, p_seed: seed }),
      (() => {
        let q = supabase.from("contribution_tasks")
          .select("id, title, description, task_type, target, region, priority, reward, created_at")
          .eq("status", "open").order("priority", { ascending: false }).limit(limit);
        if (type) q = q.eq("task_type", type);
        if (region) q = q.eq("region", region);
        return q;
      })(),
      supabase.rpc("contribution_auto_task_counts", { p_region: region }),
    ]);
    if (autoRes.error) throw new Error(`auto tasks: ${autoRes.error.message}`);
    if (manualRes.error) throw new Error(`manual tasks: ${manualRes.error.message}`);
    if (countRes.error) throw new Error(`task counts: ${countRes.error.message}`);

    // deno-lint-ignore no-explicit-any
    const manual = (manualRes.data ?? []).map((t: any) => ({
      task_id: t.id,
      task_type: t.task_type,
      target: t.target,
      what_we_need: t.description ? `${t.title}：${t.description}` : t.title,
      hint_sources: [],
      reward: t.reward,
      priority: t.priority,
      source: "manual",
      suggested_contribution_type: SUGGESTED_TYPE[t.task_type] ?? null,
    }));
    // deno-lint-ignore no-explicit-any
    const auto = (autoRes.data ?? []).map((t: any) => ({ ...t, source: "auto", suggested_contribution_type: SUGGESTED_TYPE[t.task_type] ?? null }));
    const tasks = [...manual, ...auto].slice(0, limit);

    // deno-lint-ignore no-explicit-any
    const totals = Object.fromEntries((countRes.data ?? []).map((r: any) => [r.task_type, Number(r.total)]));

    return json({
      success: true,
      count: tasks.length,
      seed,
      totals: { ...totals, manual_open: manual.length },
      tasks,
      how_to: "挑一筆 → 到優先來源（官方優先）查證 → POST /contribute，payload 帶 task_id；查不到就放著，不要猜。同一任務可能多人做，重複會在驗證階段合併。",
      docs: "https://policy-tw.web.app/skill.md",
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("tasks error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
