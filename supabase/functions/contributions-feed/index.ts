import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requiredAgree } from "../_shared/consensus.ts";
import { ATTENTION_STATUSES, buildFeedSummary, safePayload, type SummaryRow, summarizeContribution, type VoteRow } from "../_shared/contribution-summary.ts";

/**
 * contributions-feed — 貢獻看板的公開唯讀資料（contributions 表匿名讀不到，所以走端點）。
 * GET ?status=all|attention|pending|verified|applied|disputed|apply_failed|rejected|reverted&agent_name=&type=&limit=20&cursor=<created_at>
 * 每筆：安全摘要＋計數＋來源＋審核備註（不回 ip_hash；長文截 200 字）。另回 summary（各狀態筆數、近 7 日每日提交、貢獻榜前 10）。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const STATUSES = ["pending", "verified", "applied", "disputed", "rejected", "reverted", "apply_failed"];
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
    if (status !== "all" && status !== "attention" && !STATUSES.includes(status)) return json({ success: false, error: `status 要是 all／attention 或 ${STATUSES.join("/")}` }, 400);

    let q = supabase.from("contributions").select(FEED_COLUMNS).order("created_at", { ascending: false }).limit(limit + 1);
    if (status === "attention") q = q.in("status", ATTENTION_STATUSES);
    else if (status !== "all") q = q.eq("status", status);
    if (agentName) q = q.eq("agent_name", agentName);
    if (type) q = q.eq("contribution_type", type);
    if (cursor) q = q.lt("created_at", cursor);

    const [feedRes, allRes, votesRes, adjRes] = await Promise.all([
      q,
      supabase.from("contributions").select("status, agent_name, created_at").limit(10000),
      supabase.from("contribution_votes").select("agent_name").limit(20000),
      supabase.from("contribution_tasks").select("id", { count: "exact", head: true }).eq("task_type", "adjudicate").eq("status", "open"),
    ]);
    for (const r of [feedRes, allRes, votesRes, adjRes]) if (r.error) throw new Error(r.error.message);

    // deno-lint-ignore no-explicit-any
    const rows = (feedRes.data ?? []) as any[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const items = page.map((r) => {
      const s = summarizeContribution({ contribution_type: r.contribution_type, payload: r.payload, applied_politician_id: r.applied_politician_id, applied_policy_id: r.applied_policy_id });
      const need = requiredAgree(r.contribution_type, r.payload, r.source_urls ?? []);
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

    // summary（純函式，見 contribution-summary.ts）
    const summary = buildFeedSummary((allRes.data ?? []) as SummaryRow[], (votesRes.data ?? []) as VoteRow[], Date.now(), adjRes.count ?? 0);

    return json({
      success: true,
      count: items.length,
      has_more: hasMore,
      next_cursor: hasMore ? page[page.length - 1].created_at : null,
      items,
      summary,
      docs: "https://policy-tw.web.app/skill.md",
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("contributions-feed error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
