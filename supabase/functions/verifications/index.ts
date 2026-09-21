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

    // #15（2026-09-22）：列出這個來源 IP 投過的票。#10 讓投票者可以修訂自己的票，但「可以改，前提是記得 id」對
    // 「事後發現錯了」這個場景等於沒有——代理跑了幾十輪、重啟過、或中途掛掉，記憶隨行程一起沒了（leatherback）。
    // 身份是來源 IP，不是代號：同一台機器換代號投的票也列，因為修訂看的也是 IP。
    if (url.searchParams.get("mine") === "1") {
      const mineLimit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
      // query-bounds: ok — 一個 IP 的票有上限（每日 800），而且帶 limit 與 order
      const { data: myVotes, error: mvErr } = await supabase.from("contribution_votes")
        .select("id, contribution_id, verdict, weight, note, evidence_url, resolved_politician_id, via, created_at")
        .eq("verifier_ip_hash", ipHash).order("created_at", { ascending: false }).limit(mineLimit);
      if (mvErr) throw new Error(`my votes: ${mvErr.message}`);
      type MyVote = { id: string; contribution_id: string; verdict: string; weight: number | null; note: string | null; evidence_url: string | null; resolved_politician_id: string | null; via: string | null; created_at: string };
      const votes = (myVotes ?? []) as MyVote[];
      const ids = [...new Set(votes.map((v) => v.contribution_id))];
      type Contrib = { id: string; contribution_type: string; status: string; score: number | null; effective_agree: number | null; payload: Record<string, unknown> | null };
      let byId = new Map<string, Contrib>();
      if (ids.length > 0) {
        // query-bounds: ok — ids 來自上面那批票（≤200）
        const { data: cs, error: cErr } = await supabase.from("contributions")
          .select("id, contribution_type, status, score, effective_agree, payload").in("id", ids.slice(0, 200)).limit(200);
        if (cErr) throw new Error(`my votes contributions: ${cErr.message}`);
        byId = new Map(((cs ?? []) as Contrib[]).map((c) => [c.id, c]));
      }
      const rows = votes.map((v) => {
        const c = byId.get(v.contribution_id);
        const p = (c?.payload ?? {}) as Record<string, unknown>;
        const subject = [p.name, p.title, p.target_table && p.target_id ? `${p.target_table}:${String(p.target_id).slice(0, 8)}` : null].filter(Boolean).join("｜");
        return {
          vote_id: v.id,
          contribution_id: v.contribution_id,
          contribution_type: c?.contribution_type ?? null,
          subject: subject || null,
          verdict: v.verdict,
          weight: v.weight,
          resolved_politician_id: v.resolved_politician_id,
          note: v.note ? String(v.note).slice(0, 200) : null,
          evidence_url: v.evidence_url,
          voted_at: v.created_at,
          revised: typeof v.via === "string" && v.via.endsWith(":revise"),
          contribution_status: c?.status ?? null,
          score: c?.score ?? null,
          target_score: c?.effective_agree ?? null,
        };
      });
      return json({
        success: true,
        mine: true,
        count: rows.length,
        votes: rows,
        how_to_revise: "投錯了要改：POST /report {kind:'verify', contribution_id, verdict, note, evidence_url?, resolved_politician_id?, agent_name, revise: true}——覆寫你那張票，分數依新的重算，仍只算一票。只有 pending／verified 的還能改；已 applied／rejected 的改不動。",
        docs: "https://policy-tw.web.app/skill.md",
      });
    }

    // 候選一律走 contribution_verify_pool（跟 /next 同一支）：同 IP 提交的、投過的、
    // 已達有效門檻的、跟原貢獻有關係的裁決，全部在 SQL 裡、LIMIT 之前就排掉。
    //
    // 2026-09-21 之前這裡是自己寫的查詢：先抓最舊的 limit*4 筆，再用 TS 濾掉投過的。
    // 結果這台機器把最舊的幾百筆投完之後，端點就開始回空——limit=3 回 0 筆、
    // limit=100 也只回 50 筆，而 total_pending 顯示 1,076。代理會以為沒東西可驗。
    // 跟 #102–#105、#122 同一個反模式：合格判斷要在 SQL、LIMIT 之前。
    const { data: poolRows, error } = await supabase.rpc("contribution_verify_pool", {
      p_ip_hash: ipHash,
      p_region: region,
      p_limit: limit,
      p_type: type,
    });
    if (error) throw new Error(`verify pool: ${error.message}`);
    type Row = { id: string; [k: string]: unknown };
    const rows: Row[] = ((poolRows ?? []) as Row[]).map(({ contributor_ip_hash: _ip, visitor_facing: _v, adjudication_facing: _a, ...rest }) => rest as Row);

    // 待驗證總數還是照原本的口徑數（這個代理還能驗幾筆），跟候選頁分開算
    const { count: pendingCount, error: countError } = await supabase
      .from("contributions").select("id", { count: "exact", head: true })
      .eq("status", "pending").neq("contributor_ip_hash", ipHash);
    if (countError) throw new Error(`pending count: ${countError.message}`);

    const totalPending = pendingCount ?? 0;

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
