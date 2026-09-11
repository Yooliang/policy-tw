import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requiredAgree } from "../_shared/consensus.ts";
import { safePayload, summarizeContribution } from "../_shared/contribution-summary.ts";

/**
 * contributions-feed — 貢獻看板的公開唯讀資料（contributions 表匿名讀不到，所以走端點）。
 * GET ?status=all|pending|verified|applied|disputed|needs_review|rejected|reverted&agent_name=&type=&limit=20&cursor=<created_at>
 * 每筆：安全摘要＋計數＋來源＋審核備註（不回 ip_hash；長文截 200 字）。另回 summary（各狀態筆數、近 7 日每日提交、貢獻榜前 10）。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const STATUSES = ["pending", "verified", "applied", "disputed", "needs_review", "rejected", "reverted", "approved", "apply_failed"];
const FEED_COLUMNS = "id, contribution_type, payload, status, agree_count, disagree_count, unsure_count, agent_name, agent_tool, source_urls, note, task_id, created_at, applied_at, review_notes, applied_politician_id, applied_policy_id";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=30" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const url = new URL(req.url);
    const status = url.searchParams.get("status") || "all";
    const agentName = url.searchParams.get("agent_name");
    const type = url.searchParams.get("type");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 50);
    const cursor = url.searchParams.get("cursor");
    if (status !== "all" && !STATUSES.includes(status)) return json({ success: false, error: `status 要是 all 或 ${STATUSES.join("/")}` }, 400);

    let q = supabase.from("contributions").select(FEED_COLUMNS).order("created_at", { ascending: false }).limit(limit + 1);
    if (status !== "all") q = q.eq("status", status);
    if (agentName) q = q.eq("agent_name", agentName);
    if (type) q = q.eq("contribution_type", type);
    if (cursor) q = q.lt("created_at", cursor);

    const since7 = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const [feedRes, allRes, recentRes] = await Promise.all([
      q,
      supabase.from("contributions").select("status, agent_name").limit(10000),
      supabase.from("contributions").select("created_at").gte("created_at", since7).limit(10000),
    ]);
    for (const r of [feedRes, allRes, recentRes]) if (r.error) throw new Error(r.error.message);

    // deno-lint-ignore no-explicit-any
    const rows = (feedRes.data ?? []) as any[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const items = page.map((r) => {
      const s = summarizeContribution({ contribution_type: r.contribution_type, payload: r.payload, applied_politician_id: r.applied_politician_id, applied_policy_id: r.applied_policy_id });
      const need = requiredAgree(r.contribution_type, r.payload);
      return {
        id: r.id,
        contribution_type: r.contribution_type,
        status: r.status,
        required_agree: need,
        votes_needed: r.status === "pending" ? Math.max(need - (r.agree_count ?? 0), 0) : 0,
        agree_count: r.agree_count ?? 0,
        disagree_count: r.disagree_count ?? 0,
        unsure_count: r.unsure_count ?? 0,
        agent_name: r.agent_name,
        agent_tool: r.agent_tool,
        source_urls: r.source_urls ?? [],
        task_id: r.task_id,
        created_at: r.created_at,
        applied_at: r.applied_at,
        review_notes: r.review_notes,
        summary: s.summary,
        target_name: s.target_name,
        politician_url: s.politician_url,
        policy_url: s.policy_url,
        payload: safePayload(r.payload),
      };
    });

    // summary
    // deno-lint-ignore no-explicit-any
    const all = (allRes.data ?? []) as any[];
    const byStatus: Record<string, number> = {};
    const byAgent = new Map<string, { submitted: number; applied: number }>();
    for (const r of all) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      const a = byAgent.get(r.agent_name) ?? { submitted: 0, applied: 0 };
      a.submitted++;
      if (r.status === "applied") a.applied++;
      byAgent.set(r.agent_name, a);
    }
    const daily: Record<string, number> = {};
    for (let i = 6; i >= 0; i--) daily[new Date(Date.now() - i * 86400 * 1000).toISOString().slice(0, 10)] = 0;
    // deno-lint-ignore no-explicit-any
    for (const r of (recentRes.data ?? []) as any[]) {
      const d = String(r.created_at).slice(0, 10);
      if (d in daily) daily[d]++;
    }
    const leaderboard = [...byAgent.entries()].map(([agent_name, v]) => ({ agent_name, ...v })).sort((a, b) => b.applied - a.applied || b.submitted - a.submitted).slice(0, 10);

    return json({
      success: true,
      count: items.length,
      has_more: hasMore,
      next_cursor: hasMore ? page[page.length - 1].created_at : null,
      items,
      summary: { total: all.length, by_status: byStatus, daily_last_7: Object.entries(daily).map(([date, count]) => ({ date, count })), leaderboard },
      docs: "https://policy-tw.web.app/skill.md",
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("contributions-feed error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
