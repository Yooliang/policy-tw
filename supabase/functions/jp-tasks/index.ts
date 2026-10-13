// jp-only:begin 檔頭與 import（日本站的 client、協議網址、日本站的任務對照）
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { jpClient } from "../_shared/jp/client.ts";
import { JP_PROTOCOL_URL, JP_PROTOCOL_VERSION } from "../_shared/jp/protocol.ts";
import { requiredAgree as jpRequiredAgree } from "../_shared/jp/consensus.ts";
import { JP_TASK_ARMS } from "../_shared/jp/contribution-schema.ts";
import { describeManualTask } from "../_shared/task-admin.ts";
import { SUGGESTED_TYPE as TW_SUGGESTED_TYPE } from "../_shared/task-types.ts";
import { summarizeTaskVotes, type VoteContribution } from "../_shared/task-votes.ts";

/**
 * jp-tasks — 日本站的任務看板（公開唯讀，對應正見的 tasks）。
 * 照搬 tasks，只換 schema、分數欄位與個資處理；改正見那支時這支要跟著改
 * （守門：_shared/jp-tasks.test.ts 把兩支去掉標為日本專屬的區段後逐行比對）。
 * GET ?type=&region=&limit=&seed=&source=&include_closed=1
 *   → { tasks: [ { task_id, task_type, target, what_we_need, hint_sources, reward, source, status?, votes, suggested_contribution_type, … } ], totals, docs }
 * 日本專屬的差異（下面標 jp-only 的區段）：
 *   - client 固定 db.schema=policy_jp（_shared/jp/client.ts）；contribution_auto_tasks／contribution_auto_task_counts 只給 service_role，所以用 service 金鑰。
 *   - 分數：policy_jp.contributions 沒有計算欄位 effective_agree，改撈 target_score，空的退回日本站門檻（_shared/jp/consensus.ts）。
 *   - 個資：不回 created_by、suggested_by（也不撈 requester_ip_hash）；回應只有公開欄位。
 *   - 自動缺口（日本站的任務幾乎都是）也附票數摘要；with_current 一律關（日本站沒有對應的 task-context，不回 current／lookup）。
 *   - suggested_contribution_type：正見的對照表再疊上日本站的任務→交件型別（JP_TASK_ARMS）。
 *   - docs／how_to 指向日本站的手引き（JP_PROTOCOL_URL）。
 */
const SUGGESTED_TYPE: Record<string, string> = { ...TW_SUGGESTED_TYPE, ...JP_TASK_ARMS };
// jp-only:end

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

/** 手動任務的來源（contribution_tasks.source） */
const MANUAL_SOURCES = new Set(["manual", "suggested", "web_request", "auto_dispute"]);
// jp-only:begin 票數欄位（日本站撈 target_score，沒有 effective_agree）
const VOTE_COLUMNS = "id, contribution_type, payload, source_urls, status, agree_count, disagree_count, unsure_count, score, target_score, task_id";
/** target_score 放進 summarizeTaskVotes 讀的 effective_agree；空的（還沒計過票）退回日本站門檻 */
function withJpTarget(rows: VoteContribution[]): VoteContribution[] {
  return rows.map((r) => ({ ...r, effective_agree: typeof r.target_score === "number" ? r.target_score : jpRequiredAgree(r.contribution_type, r.payload, r.source_urls ?? []) }));
}
// jp-only:end

// deno-lint-ignore no-explicit-any
async function fetchTaskVotes(supabase: any, tasks: ReadonlyArray<{ task_id: string; task_type: string; target: unknown }>) {
  if (tasks.length === 0) return new Map();
  const ids = tasks.map((t) => t.task_id);
  const originals = tasks
    .filter((t) => t.task_type === "adjudicate")
    .map((t) => (t.target && typeof t.target === "object" ? (t.target as Record<string, unknown>).contribution_id : null))
    .filter((v): v is string => typeof v === "string");
  // 上限寫 1000 是因為伺服器就只給 1000（PostgREST max-rows）。原本寫 2000，
  // 數字比實際保護大，會讓下一個人以為這裡撐得住——實測一批任務最多 10 筆票，所以夠。
  const [byTask, byNoChange, byAdjudication] = await Promise.all([
    supabase.from("contributions").select(VOTE_COLUMNS).in("task_id", ids).limit(1000),
    // 查無回報的任務 id 只在 payload（task_id 欄是空的），不另撈就會顯示成「還沒有人提交」（2026-10-13）
    supabase.from("contributions").select(VOTE_COLUMNS).eq("contribution_type", "no_change").is("task_id", null).in("payload->>task_id", ids).limit(1000),
    originals.length > 0
      ? supabase.from("contributions").select(VOTE_COLUMNS).eq("contribution_type", "adjudication").in("payload->>contribution_id", originals).limit(1000)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (byTask.error) throw new Error(`task votes: ${byTask.error.message}`);
  if (byNoChange.error) throw new Error(`no_change votes: ${byNoChange.error.message}`);
  if (byAdjudication.error) throw new Error(`adjudication votes: ${byAdjudication.error.message}`);
  // jp-only:begin 分數目標改讀 target_score
  return summarizeTaskVotes(tasks, withJpTarget([...(byTask.data ?? []), ...(byNoChange.data ?? []), ...(byAdjudication.data ?? [])] as VoteContribution[]));
  // jp-only:end
}

function json(body: unknown, status = 200): Response {
  // jp-only:begin 公開唯讀，快取 30 秒
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=30" } });
  // jp-only:end
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // jp-only:begin client 固定 policy_jp
    // deno-lint-ignore no-explicit-any
    const supabase = jpClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!) as SupabaseClient<any, any, any>; // jpClient 回 any，不轉的話下游 .map((t) => …) 全變隱含 any
    // jp-only:end
    const url = new URL(req.url);
    const type = url.searchParams.get("type") || null;
    const region = url.searchParams.get("region")?.replace(/臺/g, "台") || null;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 10, 1), 50);
    const seed = url.searchParams.get("seed") || crypto.randomUUID();
    // 任務頁的來源過濾（policy-ops #88）：只給看板用，跟 include_closed 一樣不寫進協議；不認得的值當沒給
    const sourceParam = url.searchParams.get("source");
    const source = sourceParam && MANUAL_SOURCES.has(sourceParam) ? sourceParam : null;

    const [autoRes, manualRes, countRes, manualCountRes] = await Promise.all([
      supabase.rpc("contribution_auto_tasks", { p_type: type, p_region: region, p_limit: limit, p_seed: seed }),
      (() => {
        let q = supabase.from("contribution_tasks")
          // jp-only:begin 不撈 suggested_by、created_by、requester_ip_hash（個資）
          .select("id, title, description, task_type, target, region, priority, reward, created_at, source, hint_sources, status, closed_at")
          // jp-only:end
          .order("status", { ascending: false }).order("priority", { ascending: false }).order("created_at", { ascending: false }).limit(limit);
        if (url.searchParams.get("include_closed") !== "1") q = q.eq("status", "open");
        if (type) q = q.eq("task_type", type);
        if (region) q = q.eq("region", region);
        if (source) q = q.eq("source", source);
        return q;
      })(),
      supabase.rpc("contribution_auto_task_counts", { p_region: region }),
      // manual_open 要是真正的總數。原本用回傳陣列的長度，會被 limit 截斷：
      // /tasks?limit=1 回 manual_open:1，讀到的代理會以為只剩一筆手動任務。
      // 同一個 totals 物件裡其他數字都是 RPC 算出來的真實總數，混一個當頁筆數進去會騙人。
      (() => {
        let q = supabase.from("contribution_tasks").select("id", { count: "exact", head: true }).eq("status", "open");
        if (type) q = q.eq("task_type", type);
        if (region) q = q.eq("region", region);
        return q;
      })(),
    ]);
    if (autoRes.error) throw new Error(`auto tasks: ${autoRes.error.message}`);
    if (manualRes.error) throw new Error(`manual tasks: ${manualRes.error.message}`);
    if (manualCountRes.error) throw new Error(`manual task count: ${manualCountRes.error.message}`);
    if (countRes.error) throw new Error(`task counts: ${countRes.error.message}`);

    // deno-lint-ignore no-explicit-any
    const manual = (manualRes.data ?? []).map((t: any) => ({
      task_id: t.id,
      task_type: t.task_type,
      target: t.target,
      title: t.title,
      description: t.description,
      ...describeManualTask(t),
      hint_sources: t.hint_sources ?? [],
      reward: t.reward,
      priority: t.priority,
      source: t.source ?? "manual",
      // jp-only:begin 不回 suggested_by、created_by
      // jp-only:end
      status: t.status,
      created_at: t.created_at,
      closed_at: t.closed_at ?? null,
      suggested_contribution_type: SUGGESTED_TYPE[t.task_type] ?? null,
    }));
    // 任務清單的票數條：代理針對每筆手動任務交的貢獻，挑最接近通過的那筆（見 _shared/task-votes.ts）
    const votesByTask = await fetchTaskVotes(supabase, manual);
    const manualWithVotes = manual.map((t) => ({ ...t, votes: votesByTask.get(t.task_id) ?? { submissions: 0, leading: null } }));
    // deno-lint-ignore no-explicit-any
    // jp-only:begin 自動缺口也附票數摘要與 status（日本站的任務幾乎都是自動缺口）
    const autoRows = (autoRes.data ?? []).map((t: { task_id: string; task_type: string; target: unknown }) => ({ ...t, source: "auto", status: "open", suggested_contribution_type: SUGGESTED_TYPE[t.task_type] ?? null }));
    const autoVotes = await fetchTaskVotes(supabase, autoRows);
    const auto = autoRows.map((t: { task_id: string }) => ({ ...t, votes: autoVotes.get(t.task_id) ?? { submissions: 0, leading: null } }));
    // jp-only:end
    // jp-only:begin with_current 一律關（不回 current／lookup）
    const picked = (source ? manualWithVotes : [...manualWithVotes, ...auto]).slice(0, limit);
    const tasks = picked;
    // jp-only:end

    // deno-lint-ignore no-explicit-any
    const totals = Object.fromEntries((countRes.data ?? []).map((r: any) => [r.task_type, Number(r.total)]));

    return json({
      success: true,
      count: tasks.length,
      seed,
      totals: { ...totals, manual_open: manualCountRes.count ?? manual.length },
      tasks,
      // jp-only:begin 指向日本站的手引き
      how_to: "タスクを一つ選ぶ → 一次資料（官公庁の公式ページ）で確かめる → 手引きの手順で提出する（payload に task_id）。見つからなければ放置し、推測しない。詳しくは docs の手引きを読むこと。",
      // jp-only:end
      // jp-only:begin 日本站的手引き網址與版號
      docs: JP_PROTOCOL_URL,
      protocol_version: JP_PROTOCOL_VERSION,
      // jp-only:end
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // jp-only:begin 日誌名稱
    console.error("jp-tasks error:", message);
    // jp-only:end
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
