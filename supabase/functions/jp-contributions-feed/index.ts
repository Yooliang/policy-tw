// jp-only:begin 檔頭與 import（日本站的 client、協議網址、分數欄位、摘要）
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { jpClient } from "../_shared/jp/client.ts";
import { JP_PROTOCOL_URL as PROTOCOL_URL } from "../_shared/jp/protocol.ts";
import { jpContributionScore as contributionScore, jpElectionIdsNeedingName, jpPayloadForSummary, JP_SCORE_COLUMNS as SCORE_COLUMNS, jpSummarizeContribution } from "../_shared/jp/contribution-feed.ts";
import { ATTENTION_STATUSES, type FeedSummary, safePayload } from "../_shared/contribution-summary.ts";
import { fetchSourceBriefs, viewSources } from "../_shared/source-read.ts";

/**
 * jp-contributions-feed — 日本站貢獻看板的公開唯讀資料（對應正見的 contributions-feed）。
 * 照搬 contributions-feed，只換 schema 與標題解析；改正見那支時這支要跟著改
 * （守門：_shared/jp-contributions-feed.test.ts 把兩支去掉標為日本專屬的區段後逐行比對）。
 * GET ?status=all|attention|voting|pending|verified|applied|disputed|apply_failed|rejected|reverted&agent_name=&actor_id=&type=&limit=20&cursor=<last_activity_at>
 * 每筆：安全摘要＋計數＋來源＋審核備註（不回 ip_hash、actor_id 等雜湊；長文截 200 字）。第一頁另回 summary（rpc contribution_feed_summary：各狀態筆數、近 7 日每日提交、貢獻榜）。
 * 日本專屬的差異（下面標 jp-only 的區段）：
 *   - client 固定 db.schema=policy_jp（_shared/jp/client.ts）。
 *   - 分數：policy_jp.contributions 沒有計算欄位 effective_agree，改撈欄位 target_score（_shared/jp/contribution-feed.ts）。
 *   - 標題解析：election → payload.name，沒有就用 policy_jp.elections 的 name；local_government → payload.name；
 *     regional_stat → payload.lg_code＋payload.stat_key；no_change → 核對內容。
 */
// jp-only:end

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const STATUSES = ["pending", "verified", "applied", "disputed", "rejected", "reverted", "apply_failed", "superseded", "withdrawn"];
// score／effective_agree 兩欄（分數與目標分數）跟查核履歷（history）共用同一份取法：_shared/contribution-score.ts
const FEED_COLUMNS = `id, contribution_type, payload, status, ${SCORE_COLUMNS}, agree_count, disagree_count, unsure_count, agent_name, agent_tool, source_urls, note, task_id, created_at, applied_at, review_notes, applied_politician_id, applied_policy_id, last_activity_at, last_activity`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=30" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    // jp-only:begin client 固定 schema policy_jp
    const supabase = jpClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    // jp-only:end
    const url = new URL(req.url);
    const status = url.searchParams.get("status") || "all";
    const agentName = url.searchParams.get("agent_name");
    // 身份鍵（docs/BLUEPRINT-agent-identity.md）：登入者的「我的貢獻」用 actor_id=ditrust:<auth.uid()> 撈，
    // 不再靠字串比對代號——任何人填別人的代號就看到別人的，那不叫「我的」
    const actorId = url.searchParams.get("actor_id");
    const type = url.searchParams.get("type");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 50);
    // 游標是時間戳（…+00:00）：沒 URL-encode 的話 + 會被解成空白、查詢回 500（W-Policy 09-28 回報）。空白一律還原成 +
    const cursor = url.searchParams.get("cursor")?.replace(/ /g, "+") ?? null;
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
    // score.neq.0（2026-09-21 票數→分數）：分數可正可負，只要不是 0 就代表有人投過（0 也可能是 +1 −1 互相抵銷，
    // 但那種情況原本靠 agree/disagree/unsure_count 三個計數就抓得到，OR 條件不會漏）。
    else if (status === "voting") q = q.eq("status", "pending").or("agree_count.gt.0,disagree_count.gt.0,unsure_count.gt.0,score.neq.0");
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
    // jp-only:begin 標題解析：日本站只有 election 要去 policy_jp.elections 補名稱（正見這段查 policies／politician_elections／politicians）
    // 摘要是純函式、沒有資料庫。election 交件沒帶 name 時，用 id（投票日_種類_團體碼）找名稱；找不到（還沒落庫）摘要就只寫日期與種類。
    const electionIdsNeedingName = jpElectionIdsNeedingName(page.map((r) => r.payload), page.map((r) => r.contribution_type));
    const nameByElectionId = new Map<string, string>();
    if (electionIdsNeedingName.length > 0) {
      const { data: els, error: elsErr } = await supabase.from("elections").select("id, name").in("id", electionIdsNeedingName);
      if (elsErr) throw new Error(`election names: ${elsErr.message}`);
      // deno-lint-ignore no-explicit-any
      for (const x of (els ?? []) as any[]) nameByElectionId.set(x.id, x.name);
    }
    // jp-only:end

    // 交件的網址在出處表的等級、認定根據與存檔網址（#347 第二階段 A）；拿不到就照網域自動判斷
    // deno-lint-ignore no-explicit-any
    const sourceBriefs = await fetchSourceBriefs(supabase, page.flatMap((r: any) => (Array.isArray(r.source_urls) ? r.source_urls : [])));

    const items = page.map((r) => {
      // jp-only:begin 摘要：election 補上 elections 表的名稱，四種日本站型別用日本站的摘要，不回正見網站的人物／政見連結
      const payloadForSummary = jpPayloadForSummary(r.contribution_type, r.payload, nameByElectionId);
      const s = jpSummarizeContribution({ contribution_type: r.contribution_type, payload: payloadForSummary });
      // jp-only:end
      // 分數（2026-09-21 票數→分數）：score 可為負；target_score 拿不到 effective_agree 就退回 requiredAgree，跟 required_agree 算法一樣。
      // 取法在 _shared/contribution-score.ts，查核履歷（history）用同一支
      const { score, target_score: need } = contributionScore(r);
      return {
        id: r.id,
        contribution_type: r.contribution_type,
        status: r.status,
        score,
        target_score: need,
        score_needed: r.status === "pending" ? Math.max(need - score, 0) : 0,
        // 舊欄位保留一版相容：agree_count／required_agree／votes_needed 語意不變，仍是票數
        required_agree: need,
        votes_needed: r.status === "pending" ? Math.max(need - (r.agree_count ?? 0), 0) : 0,
        agree_count: r.agree_count ?? 0,
        disagree_count: r.disagree_count ?? 0,
        unsure_count: r.unsure_count ?? 0,
        agent_name: r.agent_name,
        agent_tool: r.agent_tool,
        source_urls: r.source_urls ?? [],
        sources: viewSources(r.source_urls, sourceBriefs),
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
      // 2026-09-24 leatherback：第一頁被拿去估全站比例，兩次錯、方向相反——排序是「最近有動靜的先」，卡住的最不會出現在這裡
      order: "last_activity_at 由新到舊（最近被投票或變動的在前）；不是抽樣，不能拿一頁去估全站比例——比例請用 summary、filtered_total 或 votes_recent 等彙總",
      next_cursor: hasMore ? page[page.length - 1].last_activity_at : null,
      items,
      summary,
      docs: PROTOCOL_URL,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // jp-only:begin 日誌名稱
    console.error("jp-contributions-feed error:", message);
    // jp-only:end
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
