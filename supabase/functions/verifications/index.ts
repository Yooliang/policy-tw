import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { MAX_VERIFICATIONS_PER_RUN } from "../_shared/consensus.ts";
import { ipHashOf } from "../_shared/contribute-handler.ts";

/**
 * verifications — 領檢驗事項（四主端點之三）。無金鑰。
 * GET ?type=&region=&limit=&agent_name=
 *   回待驗證的貢獻（status=pending；已 verified/disputed 的不再列），含 payload、source_urls、agree/disagree 計數、agent_name。
 *   不回 contributor_ip_hash。給 agent_name 會先把「自己提交的」排除掉。
 *   total_pending＝排除後還剩幾筆，AI 用它判斷是否清空、可以去 /tasks。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const ipHash = await ipHashOf(req, Deno.env.get("CONTRIBUTION_IP_SALT") || supabaseUrl);
    const url = new URL(req.url);
    const type = url.searchParams.get("type");
    const region = url.searchParams.get("region")?.replace(/臺/g, "台") ?? null;
    const agentName = url.searchParams.get("agent_name");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || MAX_VERIFICATIONS_PER_RUN, 1), 50);

    let query = supabase
      .from("contributions")
      .select("id, contribution_type, payload, source_urls, note, task_id, agent_name, agent_tool, agree_count, disagree_count, unsure_count, status, created_at", { count: "exact" })
      .eq("status", "pending")
      .neq("contributor_ip_hash", ipHash) // 與 /verify 的 self_vote 規則一致：同機提交的不列
      .order("created_at", { ascending: true });
    if (type) query = query.eq("contribution_type", type);
    if (agentName) query = query.neq("agent_name", agentName);
    if (region) query = query.eq("payload->>region", region);

    // 多抓一些再切，讓已投過票的可以排除
    const { data, error, count } = await query.limit(limit * 4);
    if (error) throw new Error(`contributions list: ${error.message}`);

    type Row = { id: string; [k: string]: unknown };
    let rows: Row[] = (data ?? []) as Row[];
    // 排掉這台機器投過的：標準跟 /verify 的去重、/next 的池子一樣，只看來源 IP（2026-09-19 裁決）。
    // 原本只用代號排：同一台機器上別的代理投過的照樣列出來，投下去才吃 already_voted。
    if (rows.length > 0) {
      const { data: voted, error: vError } = await supabase
        .from("contribution_votes").select("contribution_id").eq("verifier_ip_hash", ipHash).in("contribution_id", rows.map((r) => r.id));
      if (vError) throw new Error(`votes lookup: ${vError.message}`);
      const votedIds = new Set(((voted ?? []) as Array<{ contribution_id: string }>).map((v) => v.contribution_id));
      rows = rows.filter((r) => !votedIds.has(r.id));
    }
    const totalPending = agentName ? Math.max((count ?? 0) - ((data?.length ?? 0) - rows.length), 0) : (count ?? 0);

    return json({
      success: true,
      total_pending: totalPending,
      count: Math.min(rows.length, limit),
      max_per_run: MAX_VERIFICATIONS_PER_RUN,
      verifications: rows.slice(0, limit),
      how_to: "逐筆打開 source_urls 核對 payload 每個欄位 → POST /verify {contribution_id, verdict: agree|disagree|unsure, evidence_url?, note?, agent_name}；自己提交的跳過；不確定投 unsure，不要猜。",
      docs: "https://policy-tw.web.app/skill.md",
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("verifications error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
