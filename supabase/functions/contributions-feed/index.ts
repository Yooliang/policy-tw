import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requiredAgree } from "../_shared/consensus.ts";
import { ATTENTION_STATUSES, type FeedSummary, safePayload, summarizeContribution } from "../_shared/contribution-summary.ts";

/**
 * contributions-feed — 貢獻看板的公開唯讀資料（contributions 表匿名讀不到，所以走端點）。
 * GET ?status=all|attention|voting|pending|verified|applied|disputed|apply_failed|rejected|reverted&agent_name=&actor_id=&type=&limit=20&cursor=<last_activity_at>
 *   voting＝還在等票但已經有人投過（status=pending 且三種票數任一 > 0）。
 *   verified 這個狀態是過渡的——通過驗證會立刻自動落庫變 applied，所以那一頁幾乎永遠是空的，
 *   讀者要看的其實是「正在被核對的那些」。
 * 每筆：安全摘要＋計數＋來源＋審核備註（不回 ip_hash；長文截 200 字）。另回 summary（各狀態筆數、近 7 日每日提交、貢獻榜前 10）。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const STATUSES = ["pending", "verified", "applied", "disputed", "rejected", "reverted", "apply_failed"];
const FEED_COLUMNS = "id, contribution_type, payload, status, agree_count, disagree_count, unsure_count, agent_name, agent_tool, source_urls, note, task_id, created_at, applied_at, review_notes, applied_politician_id, applied_policy_id, last_activity_at, last_activity";

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
    // 身份鍵（docs/BLUEPRINT-agent-identity.md）：登入者的「我的貢獻」用 actor_id=ditrust:<auth.uid()> 撈，
    // 不再靠字串比對代號——任何人填別人的代號就看到別人的，那不叫「我的」
    const actorId = url.searchParams.get("actor_id");
    const type = url.searchParams.get("type");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 50);
    const cursor = url.searchParams.get("cursor");
    if (status !== "all" && status !== "attention" && status !== "voting" && !STATUSES.includes(status)) return json({ success: false, error: `status 要是 all／attention／voting 或 ${STATUSES.join("/")}` }, 400);

    // 第一頁要回「目前這組篩選共幾筆」給畫面顯示。count 走 PostgREST 同一個請求的
    // Content-Range，不是第二次查詢；翻頁時不算（那時查詢帶了 cursor，數出來的是
    // 「游標之後還有幾筆」，不是總數，印在畫面上會是錯的）。
    // 跟 summary 分開判斷：貢獻頁只要這個數字、不要那份全表聚合（它帶 summary=0）。
    const wantCount = !cursor;
    const wantSummary = wantCount && url.searchParams.get("summary") !== "0";
    let q = supabase.from("contributions")
      .select(FEED_COLUMNS, wantCount ? { count: "exact" } : undefined)
      // 排序看「最後一次變動」而不是提交時間（2026-09-18）：一筆兩天前交的貢獻，
      // 剛剛有人投票或剛上線，就該回到最上面。翻頁游標也要跟著換成同一個欄位，
      // 不然第二頁會用另一個欄位去切，中間的資料會漏掉。
      .order("last_activity_at", { ascending: false }).limit(limit + 1);
    if (status === "attention") q = q.in("status", ATTENTION_STATUSES);
    // 「驗證中」＝還在等票、但已經有人動過的。單看 status 分不出「沒人理」與「正在被核對」。
    else if (status === "voting") q = q.eq("status", "pending").or("agree_count.gt.0,disagree_count.gt.0,unsure_count.gt.0");
    else if (status !== "all") q = q.eq("status", status);
    if (agentName) q = q.eq("agent_name", agentName);
    if (actorId) q = q.eq("actor_id", actorId);
    if (type) q = q.eq("contribution_type", type);
    if (cursor) q = q.lt("last_activity_at", cursor);

    // 統計只在第一頁算（2026-09-17：「會不會造成伺服器的負擔？」）。
    // 翻頁時前端根本不會用 summary——它只在第一次載入時覆寫——但伺服器原本每一頁都
    // 重新掃一次全表。資料每天 +400 筆，那個浪費會越長越大。
    // 要整份撈是另一回事：PostgREST 一次最多回 1000 列，.limit(20000) 是騙自己的，
    // 實際後果是貢獻榜的驗證票合計卡在 1000，之後的票一張都不算分。
    // 統計在資料庫算（contribution_feed_summary，見 migration 20260917000012）：
    // 一次 GROUP BY，不把上千列搬進函式。實測 808ms → 225ms，而且資料再長也是一次查詢。
    // 仍只在第一頁算——翻頁用不到它。
    const [feedRes, summaryRes] = await Promise.all([
      q,
      wantSummary ? supabase.rpc("contribution_feed_summary") : Promise.resolve({ data: null, error: null }),
    ]);
    if (feedRes.error) throw new Error(feedRes.error.message);
    if (summaryRes.error) throw new Error(`summary: ${summaryRes.error.message}`);

    // deno-lint-ignore no-explicit-any
    const rows = (feedRes.data ?? []) as any[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    // 代理可以用 politician_id 取代姓名提交。摘要是純函式、沒有資料庫，取不到名字就
    // 只能印「（政治人物）」給讀者看——那等於沒資訊。這裡把用到的 id 一次撈回姓名補上。
    // deno-lint-ignore no-explicit-any
    const idsNeedingName = [...new Set(page.flatMap((r: any) => {
      const p = (r.payload && typeof r.payload === "object" ? r.payload : {}) as Record<string, unknown>;
      const hasName = typeof p.name === "string" && p.name.trim().length > 0;
      const pid = typeof p.politician_id === "string" ? p.politician_id : null;
      return !hasName && pid ? [pid] : [];
    }))];
    // 政見標題同理（2026-09-17：「政見 aa6d7871」不該出現在畫面上）：
    // policy_progress／policy_source 這些只帶 policy_id，摘要取不到標題就印 id 前八碼。
    // deno-lint-ignore no-explicit-any
    const idsNeedingTitle = [...new Set(page.flatMap((r: any) => {
      const p = (r.payload && typeof r.payload === "object" ? r.payload : {}) as Record<string, unknown>;
      const hasTitle = typeof p.policy_title === "string" && p.policy_title.trim().length > 0;
      const pid = typeof p.policy_id === "string"
        ? p.policy_id
        : (p.target_table === "policies" && typeof p.target_id === "string" ? p.target_id : null);
      return !hasTitle && pid ? [pid] : [];
    }))];
    const titleById = new Map<string, string>();
    if (idsNeedingTitle.length > 0) {
      const { data: pol, error: polErr } = await supabase.from("policies").select("id, title").in("id", idsNeedingTitle);
      if (polErr) throw new Error(`policy titles: ${polErr.message}`);
      // deno-lint-ignore no-explicit-any
      for (const x of (pol ?? []) as any[]) titleById.set(x.id, x.title);
    }

    // 參選紀錄（politician_elections）的列 id 同樣要換成人看得懂的字：
    // 「把參選紀錄 9827 的參選狀態改為…」→「把參選紀錄「王小明 2026 縣市議員」的…」
    // deno-lint-ignore no-explicit-any
    const electionRowIds = [...new Set(page.flatMap((r: any) => {
      const p = (r.payload && typeof r.payload === "object" ? r.payload : {}) as Record<string, unknown>;
      return p.target_table === "politician_elections" && (typeof p.target_id === "string" || typeof p.target_id === "number")
        ? [String(p.target_id)]
        : [];
    }))];
    const electionLabelById = new Map<string, string>();
    if (electionRowIds.length > 0) {
      const { data: pe } = await supabase.from("politician_elections")
        .select("id, election_id, election_type, politicians(name)").in("id", electionRowIds);
      // deno-lint-ignore no-explicit-any
      for (const x of (pe ?? []) as any[]) {
        const who = x.politicians?.name ?? "未指名";
        electionLabelById.set(String(x.id), `${who} ${x.election_id ?? ""} ${x.election_type ?? ""}`.trim());
      }
    }

    const nameById = new Map<string, string>();
    if (idsNeedingName.length > 0) {
      const { data: who, error: whoErr } = await supabase.from("politicians").select("id, name").in("id", idsNeedingName);
      if (whoErr) throw new Error(`politician names: ${whoErr.message}`);
      // deno-lint-ignore no-explicit-any
      for (const w of (who ?? []) as any[]) nameById.set(w.id, w.name);
    }

    const items = page.map((r) => {
      const raw = (r.payload && typeof r.payload === "object" ? r.payload : {}) as Record<string, unknown>;
      const hasName = typeof raw.name === "string" && raw.name.trim().length > 0;
      const resolved = !hasName && typeof raw.politician_id === "string" ? nameById.get(raw.politician_id) : undefined;
      const hasTitle = typeof raw.policy_title === "string" && raw.policy_title.trim().length > 0;
      const titleKey = typeof raw.policy_id === "string"
        ? raw.policy_id
        : (raw.target_table === "policies" && typeof raw.target_id === "string" ? raw.target_id : null);
      const resolvedTitle = !hasTitle && titleKey ? titleById.get(titleKey) : undefined;
      const resolvedElection = raw.target_table === "politician_elections" && (typeof raw.target_id === "string" || typeof raw.target_id === "number")
        ? electionLabelById.get(String(raw.target_id))
        : undefined;
      const payloadForSummary = (resolved || resolvedTitle || resolvedElection)
        ? {
          ...raw,
          ...(resolved ? { name: resolved } : {}),
          ...(resolvedTitle ? { policy_title: resolvedTitle } : {}),
          ...(resolvedElection ? { target_label: resolvedElection } : {}),
        }
        : r.payload;
      const s = summarizeContribution({ contribution_type: r.contribution_type, payload: payloadForSummary, applied_politician_id: r.applied_politician_id, applied_policy_id: r.applied_policy_id });
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
        last_activity_at: r.last_activity_at ?? r.created_at,
        last_activity: r.last_activity ?? "created",
        applied_at: r.applied_at,
        review_notes: r.review_notes,
        summary: s.summary,
        target_name: s.target_name,
        politician_url: s.politician_url,
        policy_url: s.policy_url,
        payload: safePayload(r.payload),
      };
    });

    // 翻頁時回 null，前端沿用第一頁那份
    const summary = (summaryRes.data ?? null) as FeedSummary | null;

    return json({
      success: true,
      count: items.length,
      /** 目前這組篩選共幾筆（只有第一頁算得準；翻頁時回 null） */
      filtered_total: wantCount ? (feedRes.count ?? null) : null,
      has_more: hasMore,
      next_cursor: hasMore ? page[page.length - 1].last_activity_at : null,
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
