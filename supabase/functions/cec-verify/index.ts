import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { attachTickets, CEC_DATA_URL, CEC_QUERY_URL, type CecCandidacy, normalizeCandidacies, withoutFutureResults } from "../_shared/cec-candidate.ts";
import { CEC_VERIFIABLE_TYPES, decideByCec } from "../_shared/cec-verify.ts";
import { autoApplyContribution } from "../_shared/auto-apply.ts";

/**
 * cec-verify — 用中選會的資料自動查證（cron 每 10 分鐘，無金鑰，與 apply-verified 同一種掃地機）。
 *
 * 2026-09-17 小良哥：「如果有可驗證的 api 那他就可以只有 1 票」。
 * 這一類其實連一票都不需要：選舉結果、得票數、出生年有權威資料庫可查，機器比對比投票可靠。
 * 當時 894 筆待驗證裡有 406 筆卡在 4～6 票的高門檻，而站上只有幾個獨立來源在投票。
 *
 * 掃 pending 的 candidacy／politician，用姓名查中選會：
 *   對得上 → 直接落庫（reviewed_by='cec-auto'，理由寫比對了哪些欄位）
 *   對不上 → 退件，理由帶中選會的實際數字
 *   查不到、同名多筆、還沒投票 → 不碰，留給同儕驗證
 * 判斷邏輯在 _shared/cec-verify.ts（純函式、有測試、反向驗證過三條紅線）。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const USER_AGENT = "Mozilla/5.0 (compatible; PolicyTracker/1.0; +https://policy-tw.web.app)";
const REVIEWER = "cec-auto";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function cecFetch(url: string): Promise<unknown | null> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Referer: "https://db.cec.gov.tw/" } });
  if (!res.ok) return null;
  return await res.json();
}

/** 查一個人的歷屆參選；同一輪掃描裡同名只查一次 */
async function lookup(name: string, cache: Map<string, CecCandidacy[]>): Promise<CecCandidacy[]> {
  const hit = cache.get(name);
  if (hit) return hit;
  const raw = await cecFetch(`${CEC_QUERY_URL}?${new URLSearchParams({ cand_name: name })}`) as { cand_data_list?: unknown[] } | null;
  const list = withoutFutureResults(normalizeCandidacies((raw?.cand_data_list ?? []) as never[]));
  cache.set(name, list);
  return list;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
    // ?dry_run=1：只回會怎麼判，不寫任何東西（上線前先看一輪）
    const dryRun = url.searchParams.get("dry_run") === "1";

    const { data: rows, error } = await supabase.from("contributions")
      .select("id, contribution_type, payload, agent_name, created_at")
      .eq("status", "pending").in("contribution_type", [...CEC_VERIFIABLE_TYPES])
      .order("created_at", { ascending: true }).limit(limit);
    if (error) throw new Error(`contributions scan: ${error.message}`);

    const cache = new Map<string, CecCandidacy[]>();
    const results: Array<Record<string, unknown>> = [];
    let applied = 0, rejected = 0, skipped = 0;

    for (const row of rows ?? []) {
      const payload = (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>;
      // 姓名可能只在 politician_id 上：這一輪先處理 payload 帶姓名的，其餘留給同儕
      const name = typeof payload.name === "string" ? payload.name.trim() : "";
      if (!name) { skipped++; results.push({ contribution_id: row.id, action: "skip", reason: "payload 沒有姓名" }); continue; }

      let list = await lookup(name, cache);
      // candidacy 要比得票數／得票率時才多查一次 data 端點（多一次外部請求，只在必要時）
      const electionId = typeof payload.election_id === "number" ? payload.election_id : null;
      const needsTickets = row.contribution_type === "candidacy" && (payload.votes_received !== undefined || payload.vote_percentage !== undefined);
      if (needsTickets && electionId) {
        const one = list.find((c) => c.election_id === electionId);
        if (one?.theme_id && one?.cand_id) {
          const tickets = await cecFetch(`${CEC_DATA_URL}?theme_id=${one.theme_id}&cand_id=${one.cand_id}`);
          if (tickets) list = list.map((c) => (c === one ? attachTickets(c, tickets) : c));
        }
      }

      // 判斷要用「我們記的縣市」排除同名同姓（見 _shared/cec-verify.ts 的 sameRegion）：
      // 先用 payload.politician_id，沒有就用姓名找；找不到人就只能靠 payload.region
      let ours: { id?: string; name?: string; party?: string | null; region?: string | null } | null = null;
      const politicianId = typeof payload.politician_id === "string" ? payload.politician_id : null;
      if (politicianId) {
        const { data } = await supabase.from("politicians").select("id, name, party, region").eq("id", politicianId).maybeSingle();
        ours = data ?? null;
      } else {
        const { data } = await supabase.from("politicians").select("id, name, party, region").eq("name", name).limit(2);
        // 我們自己也有同名兩筆時，分不出是誰，不要猜
        if ((data ?? []).length === 1) ours = data![0];
      }

      // 我們自己的資料庫分不出是誰就不要自動決定：2026-09-17 第一次實跑時，
      // 「吳品叡」在我們這邊有兩筆同名，落庫階段判不出身份，那兩筆被轉成 disputed、
      // 白白開了兩個裁決任務。身份不明的留給同儕，他們可以指認 resolved_politician_id。
      if (!ours?.id) {
        skipped++;
        results.push({ contribution_id: row.id, name, action: "skip", reason: "我們資料庫查不到這個人、或有同名多筆，身份不明不自動判" });
        continue;
      }

      const decision = decideByCec({ contribution_type: row.contribution_type, payload, politician: ours }, list);
      const base = { contribution_id: row.id, type: row.contribution_type, name, action: decision.action };

      if (decision.action === "skip") {
        skipped++;
        results.push({ ...base, reason: decision.reason });
        continue;
      }
      if (decision.action === "reject") {
        rejected++;
        if (!dryRun) {
          const { error: e } = await supabase.from("contributions").update({
            status: "rejected",
            review_notes: `中選會自動查證不通過：${decision.reason}`,
            reviewed_by: REVIEWER,
            reviewed_at: new Date().toISOString(),
          }).eq("id", row.id).eq("status", "pending");
          if (e) throw new Error(`reject ${row.id}: ${e.message}`);
        }
        results.push({ ...base, reason: decision.reason });
        continue;
      }

      applied++;
      if (!dryRun) {
        // 先標 verified（留下「是誰驗的」），再走跟同儕驗證一樣的落庫路徑，edit_history 照記、可還原
        const { error: e } = await supabase.from("contributions").update({
          status: "verified",
          verified_at: new Date().toISOString(),
          review_notes: `中選會自動查證通過（比對 ${decision.matched.join("、")}）`,
          reviewed_by: REVIEWER,
          reviewed_at: new Date().toISOString(),
        }).eq("id", row.id).eq("status", "pending");
        if (e) throw new Error(`verify ${row.id}: ${e.message}`);
        const outcome = await autoApplyContribution(supabase, row.id, undefined, { resolvedPoliticianId: ours.id });
        results.push({ ...base, matched: decision.matched, apply_status: outcome.status, message: outcome.outcome?.message });
        continue;
      }
      results.push({ ...base, matched: decision.matched });
    }

    return json({ success: true, dry_run: dryRun, scanned: rows?.length ?? 0, applied, rejected, skipped, results });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("cec-verify error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
