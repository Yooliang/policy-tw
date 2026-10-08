import { PROTOCOL_URL, PROTOCOL_VERSION } from "../_shared/protocol.ts";
import { loadElections, withElectionKey } from "../_shared/elections.ts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ipHashOf, legacyIpHashOf } from "../_shared/contribute-handler.ts";
import { fetchMyVotedRows, voterHashes } from "../_shared/my-votes.ts";
import { fetchAllRows } from "../_shared/fetch-all.ts";
import { retireIfNoOp } from "../_shared/noop-sweep.ts";
import { withTaskPolitician } from "../_shared/task-politician.ts";
import { isFrontQueueAt, MACHINE_LOOKBACK_HOURS, MACHINE_WINDOW,machineOwesVerify, machineOwesVerifyDuringBoost, excludeOwnAdjudications, filterAdjudicateTasks, filterAnsweredQuestionTasks, filterLeasedTasks, filterOwnSubmittedTasks, filterReportedDeadEnds, filterSkippedTasks, filterSaturatedTasks, filterVerifyCandidates, pickQueueHead, fullQuestionIdsOf, LEASE_MINUTES, isManualTaskId, pickQueueTaskHead, taskTargetKey } from "../_shared/dispatch.ts";
import { requiredAgree } from "../_shared/consensus.ts";
import { agentNameProblem, resolveActorFromRequest } from "../_shared/actor.ts";
import { submitQuotaFor } from "../_shared/contribute-handler.ts";
import { verifyQuotaFor } from "../_shared/verify-handler.ts";
import { agentToolNotice } from "../_shared/agent-tool-hint.ts";
import { buildLookup, fetchTaskContext, fetchVerifyContext, shapeTaskCurrent, shapeVerifyCurrent, type VerifyContextData } from "../_shared/task-context.ts";
import { fetchVerificationSources, sourcesForTask, verifySourceQuery } from "../_shared/verification-sources.ts";
import { describeManualTask } from "../_shared/task-admin.ts";
import { policyLikenessNotice } from "../_shared/policy-likeness.ts";
import { SUGGESTED_TYPE } from "../_shared/task-types.ts";
import { MIN_PROBABILITY } from "../_shared/system-one.ts";
import { RESULTS_BATCH_MODEL_PREFIX } from "../_shared/election-results.ts";
import { REASSIGN_MODEL_PREFIX } from "../_shared/reassign-candidacy.ts";
import { CAND_NO_DUP_MODEL_PREFIX, candNoCheckForVerify } from "../_shared/cand-no-check.ts";
import { createSecretWarner, dispatchTokenSecretFrom, issueDispatchToken, logDispatchBinding } from "../_shared/dispatch-token.ts";

/**
 * next — 統一派工端點（主流程之一）。無金鑰。
 * GET ?agent_name=<必填>&agent_tool=&region=
 *   → { kind:"verify", item:{contribution_id, contribution_type, payload, source_urls, agree_count, disagree_count} }
 *   → { kind:"task",   item:{task_id, task_type, target, what_we_need, hint_sources, suggested_contribution_type} }
 *   → { kind:"none",   reason, retry_after_min:30 }
 * 每個回應都帶 total_pending（排除你自己後的待驗證數）與 open_tasks。
 * 決策在伺服器：待驗證>0 時約 3 verify：1 task（依該 agent_name 今天已做的數量輪替）；=0 只派 task；
 * 排除自己提交／已投過／agree 已達門檻的；用 agent_name 當種子隨機挑，避免大家拿同一筆。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const CANDIDATE_POOL = 30;
// 憑證鑰匙不能用時，每次冷啟動警告一行（不含鑰匙）；不然 /next 靜靜地不發憑證，沒人知道跨網段為什麼還是 409
const warnNoDispatchSecret = createSecretWarner();
// 2026-09-20：從 30 降到 5——回 none 幾乎都是暫時的（別人認領中、這一輪抽到的都不合格），等 30 分鐘是白等
const RETRY_AFTER_MIN = 5;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function handle(req: Request, mark: (name: string) => void): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const url = new URL(req.url);
    let agentName = url.searchParams.get("agent_name") ?? "";
    const agentTool = url.searchParams.get("agent_tool") ?? null;
    const region = url.searchParams.get("region")?.replace(/臺/g, "台") || null;
    // 拿到不該由你處理的任務時，帶 skip=<task_id> 再打一次：釋放認領期並改派別的。
    // 沒有這個出口的話，30 分鐘的軟認領會讓主流程一直卡在同一筆（外部代理實測踩到）。
    const skipTaskId = url.searchParams.get("skip")?.trim() || null;
    // 身份：ditrust:<序號> 先向 agents-verify 換成代號與身份鍵；一般代號原樣（docs/BLUEPRINT-agent-identity.md §3）
    const ipSalt = Deno.env.get("CONTRIBUTION_IP_SALT") || supabaseUrl;
    const ipHashForIdentity = await ipHashOf(req, ipSalt);
    // 1.79.0 以前的單一 IP 雜湊：只用來查切換前投過的票（fetchMyVotedRows），其他一律用網段雜湊（#481）
    const legacyIpHash = await legacyIpHashOf(req, ipSalt);
    const identity = await resolveActorFromRequest(agentName, ipHashForIdentity);
    mark("identity");
    // 逐一記 11 個平行查詢各自完成的時間（累計毫秒；起點都差不多，約等於各自耗時）
    const timed = <T,>(name: string, p: PromiseLike<T>): Promise<T> => Promise.resolve(p).then((v) => { mark("q_" + name); return v; });
    if (!identity.ok) return json({ success: false, error: "identity_invalid", message: identity.error }, identity.status);
    // 提交額度：DiTrust 帳號按帳號算（600）、匿名按來源 IP（200）；跟 contribute-handler 用同一支判斷
    const submitQuota = submitQuotaFor(identity.actor, ipHashForIdentity);
    const verifyQuota = verifyQuotaFor(identity.actor, ipHashForIdentity);
    const actor = identity.actor;
    agentName = actor.handle;
    const nameProblem = agentNameProblem(agentName);
    if (nameProblem) return json({ success: false, error: nameProblem }, 400);
    const ipHash = ipHashForIdentity;
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const seed = `${agentName}|${ipHash}|${Date.now()}`;

    // 跳過＝「這題我不答」（使用者 2026-09-20）：跟派過一樣排到後面，不再按 IP 記 24 小時不派（會連坐同機的其他代理）。
    // 要在分流之前寫：這一輪若輪到 verify，後面派任務的那段根本不會跑到。skips 表只留紀錄。
    if (skipTaskId) {
      const { error: skipErr } = await supabase.from("contribution_task_skips").upsert(
        { task_id: skipTaskId, ip_hash: ipHash, agent_name: agentName, skipped_at: new Date().toISOString() },
        { onConflict: "task_id,ip_hash" },
      );
      if (skipErr) throw new Error(`skip record: ${skipErr.message}`);
      try {
        // 自動缺口與手動任務（task_id＝任務 uuid）都是佇列上的列，跳過一樣回到隊尾
        await supabase.rpc("task_dispatched", { p_task_id: skipTaskId });
      } catch (e) { console.error("skip push-back:", e instanceof Error ? e.message : String(e)); }
    }

    // 待驗證池：在 SQL 裡就排掉這台機器提交的、投過的、已達門檻的，撈出來的就是真的能投的最早 N 筆。
    // 原本先取最早 30 筆再在這裡排，機器投完那 30 筆就整池是死的，第 31 筆之後永遠看不到（2026-09-19）。
    // 身份用來源 IP：代號是自報的、可以共用；IP 雜湊不會重複。
    // 過渡期（#484）：切換前交的貢獻存單一 IP 雜湊，自交排除要新舊一起比（舊雜湊與新的同值＝IP 認不得，不傳）
    const legacyForPool = legacyIpHash !== ipHash ? legacyIpHash : undefined;
    const pendingQuery = supabase.rpc("contribution_verify_pool", { p_ip_hash: ipHash, p_region: region, p_limit: CANDIDATE_POOL, ...(legacyForPool ? { p_legacy_ip_hash: legacyForPool } : {}) });

    // 驗證／任務的比例以前按 agent_name 當天累計——那是全站唯一還在用代號當身份的地方，
    // 而代號是自報的：換一個新代號就把欠的驗證洗掉，老實沿用舊代號的反而動不了
    // （ballyhoo-4d 2026-09-21 實測：兩隻代理共用一個代號，合計 16 任務／10 驗證，
    // 要再投 41 票才輪得到下一筆任務）。額度、投票去重、驗證池早就都按來源 IP 算，
    // 比例也改用同一把尺——下面的 ipVoteRes／ipContribRes 就是，不必另外查。
    const [pendingRes, countsRes, adjRows, mySubmittedRows, autoRes, myVotedOnRows, ipContribRes, ipVoteRes, myAnswersRows, skipsRes] = await Promise.all([
      timed("pool", pendingQuery),
      timed("counts", supabase.rpc("contribution_queue_task_counts", { p_region: region }) /* 佇列上各型別的任務數（自動缺口＋手動任務）：open_tasks 讀計數，不撈清單 */),
      timed("adj", // 未定案的裁決（等它的票就好，先不再派同一筆的裁決任務）
      fetchAllRows<{ payload: Record<string, unknown> }>("pending adjudications", (from, to) =>
        supabase.from("contributions").select("payload").eq("contribution_type", "adjudication")
          .in("status", ["pending", "verified"]).order("created_at", { ascending: true }).range(from, to))),
      timed("my_submitted", // 這個代理（同代號或同來源 IP）交過、還在等票的任務（資料庫還沒變，缺口會被重算出來，不該再派）
      fetchAllRows<{ task_id: string }>("my submitted tasks", (from, to) =>
        supabase.from("contributions").select("task_id").or(`agent_name.eq.${agentName},contributor_ip_hash.eq.${ipHash}`)
          .in("status", ["pending", "verified"]).not("task_id", "is", null).order("created_at", { ascending: false }).range(from, to))),
      timed("auto", // 任務列的候選（自動缺口＋open 的手動任務，同一張佇列；2026-10-08 起手動任務也由排程寫進 task_dispatches）（2026-10-02 移到這裡跟其他查詢平行跑；原本排在後面單獨 await）。
      // 「有人回報查無」改成下面只查候選的那幾十筆，不再翻整張貢獻表。
      supabase.rpc("contribution_queue_tasks", { p_type: null, p_region: region, p_limit: 30, p_seed: seed, p_ip_hash: ipHash, p_agent: agentName })),
      timed("my_votes", // 這台機器投過票的貢獻。身份只看來源 IP（2026-09-19 裁決：代號可以共用，IP 不會重複）。
      // 用途：裁決要排掉這些——對原貢獻投過票的人再去裁決同一件爭議，不是第三方裁決。
      // 驗證池的排除已經在 SQL 裡做了（contribution_verify_pool），這份只是給裁決用。
      // 這一份只會成長（沒有狀態篩選）：gcp-verifier 一小時 35 票，破 1000 之後
      // 代理會一直拿到自己投過的東西，白做一次查證再吃 409（2026-09-18 實查 589 票）
      // 過渡期（#481，1.79.0）：切換前的票存單一 IP 雜湊，新票存網段雜湊，兩個都查（_shared/my-votes.ts）
      fetchMyVotedRows(supabase, voterHashes(ipHash, legacyIpHash))),
      timed("ip_contrib", // 匿名：「每個來源 IP 每日」，同一台機器多個代號共用一份（按 agent_name 數會偏低）。
      // DiTrust 帳號：按帳號（actor_id）數，見 submitQuotaFor。
      supabase.from("contributions").select("id", { count: "exact", head: true })
        .eq(submitQuota.column, submitQuota.value).gte("created_at", todayStart.toISOString())),
      timed("ip_vote", supabase.from("contribution_votes").select("id", { count: "exact", head: true })
        .eq(verifyQuota.column, verifyQuota.value).gte("created_at", todayStart.toISOString())),
      timed("my_answers", // 這個代理（同代號或同來源 IP）答過的提問，含已上線：question_answers 只記代號，換代號就擋不住。
      // 含 applied 表示這份只會成長、不會退場，跟「my votes」同一類，要翻頁撈（2026-09-19）
      fetchAllRows<{ task_id: string }>("my answered questions", (from, to) =>
        supabase.from("contributions").select("task_id").eq("contribution_type", "question_answer")
          .or(`agent_name.eq.${agentName},contributor_ip_hash.eq.${ipHash}`)
          .in("status", ["pending", "verified", "applied"]).not("task_id", "is", null)
          .order("created_at", { ascending: true }).range(from, to))),
      timed("skips", // skip 不再按 IP 排除（2026-09-20）：這裡只是佔位，保留解構順序
      Promise.resolve({ data: [], error: null })),
    ]);
    for (const r of [pendingRes, countsRes, ipContribRes, ipVoteRes, skipsRes]) {
      if (r.error) throw new Error(r.error.message);
    }
    if (autoRes.error) throw new Error(`auto tasks: ${autoRes.error.message}`);
    mark("queries");
    // deno-lint-ignore no-explicit-any
    // 只排除這一次呼叫剛跳過的那一筆（別立刻派回同一題）；之前的 skip 靠「派過就排後面」處理
    const skippedTaskIds = new Set<string>(skipTaskId ? [skipTaskId] : []);
    void skipsRes;
    // deno-lint-ignore no-explicit-any
    const pendingAdjudicated = new Set<string>((adjRows as any[]).map((r) => r.payload?.contribution_id).filter((v): v is string => typeof v === "string"));
    // deno-lint-ignore no-explicit-any
    const mySubmittedTaskIds = new Set<string>([...(mySubmittedRows as any[]), ...(myAnswersRows as any[])]
      .map((r) => r.task_id).filter((v): v is string => typeof v === "string"));
    // deno-lint-ignore no-explicit-any
    const myVotedOriginalIds = new Set<string>((myVotedOnRows as any[]).map((r) => r.contribution_id).filter((v): v is string => typeof v === "string"));

    type PendingRow = {
  /** contribution_verify_pool 回的有效門檻（2026-09-20） */
  effective_required?: number | null;
  /** contribution_verify_pool 回的目前分數／目標分數（2026-09-21 票數→分數） */
  score?: number | null;
  target_score?: number | null;
  /** 訪客看得到的（提問回答、web_request 任務）：先驗 */
  visitor_facing?: boolean | null;
  /** 裁決：排訪客之後的第二順位（2026-09-21） */
  adjudication_facing?: boolean | null;
      id: string; contribution_type: string; payload: unknown; source_urls: string[]; note: string | null; task_id: string | null;
      agent_name: string; agent_tool: string | null; contributor_ip_hash: string; agree_count: number; disagree_count: number; unsure_count: number;
      status: string; created_at: string;
      /** 單一佇列的排序鍵（contribution_verify_pool 回；沒有列時＝created_at） */
      queue_at?: string | null;
    };
    // deno-lint-ignore no-explicit-any
    const me = { agent_name: agentName, ip_hash: ipHash, voted_ids: myVotedOriginalIds, ...(legacyForPool ? { legacy_ip_hash: legacyForPool } : {}) };
    const rawCandidates = filterVerifyCandidates((pendingRes.data ?? []) as PendingRow[], me);
    // 裁決的驗證不派給原貢獻的提交者。
    // 2026-09-21 起這一段主要在 SQL（contribution_verify_pool，LIMIT 之前）：放在這裡篩，
    // 會讓窗口先被不合格的裁決塞滿再全部丟掉，/next 就看不到任何候選（#119 的回歸）。
    // 這裡留著當第二道，它多比對一個 agent_name。
    const adjOriginalIds = rawCandidates.filter((c) => c.contribution_type === "adjudication")
      .map((c) => (c.payload && typeof c.payload === "object" ? (c.payload as Record<string, unknown>).contribution_id : null))
      .filter((v): v is string => typeof v === "string");
    let candidates = rawCandidates;
    if (adjOriginalIds.length > 0) {
      const { data: originals, error: oErr } = await supabase.from("contributions").select("id, agent_name, contributor_ip_hash").in("id", adjOriginalIds);
      if (oErr) throw new Error(`originals lookup: ${oErr.message}`);
      candidates = excludeOwnAdjudications(rawCandidates, (originals ?? []) as Array<{ id: string; agent_name: string; contributor_ip_hash: string }>, me, myVotedOriginalIds);
    }
    // 派工當下再比一次空操作（2026-09-23 W-Policy：前一筆更正剛套用、10 分鐘一次的掃地機還沒跑到，這筆就派出去了）。
    // 只看排頭、最多退 3 筆：退池是寫入，不在這裡掃整個窗口；重比失敗就照常派，不擋派工。
    for (let i = 0; i < 3 && candidates.length > 0 && candidates[0]!.contribution_type === "correction"; i++) {
      let retired = false;
      try { retired = await retireIfNoOp(supabase, candidates[0]!.id); } catch (e) { console.error("retireIfNoOp:", e instanceof Error ? e.message : String(e)); }
      if (!retired) break;
      candidates = candidates.slice(1);
    }
    const totalPending = candidates.length;
    // deno-lint-ignore no-explicit-any
    // 佇列上各型別的任務總數（contribution_queue_task_counts，含手動任務；不是 30 筆切片）
    const autoTotals: Record<string, number> = Object.fromEntries(((countsRes.data ?? []) as any[]).map((r) => [String(r.task_type), Number(r.total)]));
    // 任務列：自動缺口（auto:…）與 open 的手動任務（task_id＝任務 uuid，派工臂 manual_visitor／manual_open）在同一張佇列、同一支函式讀出來，
    // 排隊位置（queue_at）全由排程算好——/next 不再撈 contribution_tasks 清單、不再自己算排位（2026-10-08；09-23 Disk IO 事故後的裁決：缺口由排程寫進佇列、派工只讀佇列）。
    type QueueRow = { task_id: string; task_type: string; target: unknown; what_we_need: string; hint_sources: string[]; reward: number; queue_at: string };
    const queueRaw = (autoRes.data ?? []) as QueueRow[];
    type ManualRow = { id: string; title: string; description: string | null; task_type: string; target: unknown; region: string | null; priority: number; reward: number; source: string | null; suggested_by: string | null; hint_sources: string[] | null; created_at: string };

    // 在途數與「有人回報查無」只查這一輪的候選（任務列前 30 筆），不再翻整張貢獻表（2026-10-02）。
    // 這兩個集合只拿來過濾候選（下面手動、自動各一處），所以規則完全不變，只是範圍從「全站」縮到這幾十筆。
    // 原本每次 /next 都把全站在途貢獻（約 3 千筆、3 頁）和所有「查無」回報翻完，只為了檢查 50 個候選。
    const candidateTaskIds = [...new Set(queueRaw.map((t) => t.task_id).filter((v): v is string => typeof v === "string"))];
    const inFlightByTask = new Map<string, number>();
    const deadEndTaskIds = new Set<string>();
    if (candidateTaskIds.length > 0) {
      const [{ data: ifRows, error: ifErr }, { data: deRows, error: deErr }] = await Promise.all([
        // query-bounds: ok — 只查候選（≤50 個 task_id）底下的在途貢獻
        supabase.from("contributions").select("task_id")
          .in("status", ["pending", "verified", "disputed"]).in("task_id", candidateTaskIds).limit(1000),
        // query-bounds: ok — 只查候選 task_id 的「查無」回報（有 payload->>'task_id' 的表達式索引）
        supabase.from("contributions").select("payload").eq("contribution_type", "no_change")
          .in("status", ["pending", "verified"]).in("payload->>task_id", candidateTaskIds).limit(1000),
      ]);
      if (ifErr) throw new Error(`in-flight lookup: ${ifErr.message}`);
      if (deErr) throw new Error(`no_change lookup: ${deErr.message}`);
      for (const r of (ifRows ?? []) as Array<{ task_id: string | null }>) {
        if (typeof r.task_id === "string") inFlightByTask.set(r.task_id, (inFlightByTask.get(r.task_id) ?? 0) + 1);
      }
      for (const r of (deRows ?? []) as Array<{ payload: Record<string, unknown> | null }>) {
        const id = r.payload && typeof r.payload === "object" ? r.payload.task_id : null;
        if (typeof id === "string") deadEndTaskIds.add(id);
      }
    }
    mark("scoped");
    const openTasks = Object.values(autoTotals).reduce((a: number, b: number) => a + b, 0);

    // 提問任務（task_type="question"）：已滿 3 份答案的不再派、這個代理已經答過的不再派給他。
    // 提問彼此的先後（支持度 stance_up 高的先、再依進佇列時間）已經由 SQL 排在 contribution_queue_tasks 的順序裡（stance_up 是排程寫進 target 的），這裡不再排序。
    const questionRows = queueRaw.filter((t) => t.task_type === "question" && isManualTaskId(t.task_id));
    const questionIds = [...new Set(questionRows
      .map((t) => (t.target && typeof t.target === "object" ? (t.target as Record<string, unknown>).question_id : null))
      .filter((v): v is string => typeof v === "string"))];
    let queueRows = queueRaw;
    if (questionIds.length > 0) {
      const questionTaskIds = questionRows.map((t) => t.task_id);
      const [{ data: qRows, error: qErr }, { data: qaRows, error: qaErr }, { data: inFlightRows, error: ifErr }] = await Promise.all([
        supabase.from("citizen_questions").select("id, answer_count").in("id", questionIds),
        supabase.from("question_answers").select("question_id, agent_name").in("question_id", questionIds),
        // 還在等票的答案也佔名額
        supabase.from("contributions").select("task_id").eq("contribution_type", "question_answer")
          .in("status", ["pending", "verified"]).in("task_id", questionTaskIds).limit(1000),
      ]);
      if (qErr) throw new Error(`citizen_questions lookup: ${qErr.message}`);
      if (qaErr) throw new Error(`question_answers lookup: ${qaErr.message}`);
      if (ifErr) throw new Error(`in-flight answers lookup: ${ifErr.message}`);
      const inFlightByTaskId = new Map<string, number>();
      for (const r of (inFlightRows ?? []) as Array<{ task_id: string }>) inFlightByTaskId.set(r.task_id, (inFlightByTaskId.get(r.task_id) ?? 0) + 1);
      const fullQuestionIds = fullQuestionIdsOf((qRows ?? []) as Array<{ id: string; answer_count: number }>, questionRows, inFlightByTaskId);
      const mine = agentName.toLowerCase();
      const answeredQuestionIds = new Set(((qaRows ?? []) as Array<{ question_id: string; agent_name: string }>).filter((r) => r.agent_name.toLowerCase() === mine).map((r) => r.question_id));
      queueRows = filterAnsweredQuestionTasks(queueRaw, answeredQuestionIds, fullQuestionIds);
    }

    // 額度直接回給代理：以前它只能一直做到撞上 429 才知道用完了，
    // 而 429 是在 POST /report 才發生——那時候查證的工都已經做完，白費。
    const quota = {
      scope: `提交：${submitQuota.scope}；驗證：${verifyQuota.scope}。UTC 零時重置；同一台機器的多個匿名代號共用`,
      submit: {
        limit: submitQuota.limit,
        used: ipContribRes.count ?? 0,
        remaining: Math.max(0, submitQuota.limit - (ipContribRes.count ?? 0)),
      },
      verify: {
        limit: verifyQuota.limit,
        used: ipVoteRes.count ?? 0,
        remaining: Math.max(0, verifyQuota.limit - (ipVoteRes.count ?? 0)),
      },
    };
    // protocol_version：代理拿它跟自己手上那份 skill.md 的版本比，不一樣就要重讀再繼續。
    // 不然協議改了，還在跑的代理會照舊規則做到下一次重啟。
    // agent：伺服器解析出來的身份（序號登入時代理不知道自己的代號是什麼，這裡告訴它；藍圖 §3）
    // notice：agent_tool 只填別名（claude-code/haiku）拆不出版本，統計頁只能歸進「未標版本」一列。
    // 不擋派工——agent_tool 選填、也驗不了真假；每輪提醒一次，代理下次就改得掉（協議 1.44.0）。
    const toolNotice = agentToolNotice(agentTool);
    const base = { success: true, agent_name: agentName, agent_tool: agentTool, agent: { handle: actor.handle, level: actor.level }, total_pending: totalPending, open_tasks: openTasks, queue: "single", quota, protocol_version: PROTOCOL_VERSION, docs: PROTOCOL_URL, ...(toolNotice ? { notice: toolNotice } : {}) };

    // 派工憑證（#484，協議 1.81.0）：派出的那一筆簽一張，綁 task_id、派出時間、自報代號與這次領任務的來源網段，期限同認領期。
    // 不寫資料庫、不新增清單查詢；沒有鑰匙時不發（代理照舊走網段比對）。追查只進 log：只有識別碼與雜湊前 8 碼。
    const dispatchSecret = dispatchTokenSecretFrom((k) => Deno.env.get(k));
    warnNoDispatchSecret((k) => Deno.env.get(k));
    const tokenFor = async (taskId: string): Promise<Record<string, unknown>> => {
      try {
        const issued = await issueDispatchToken(dispatchSecret, { taskId, agentName, ipHash });
        if (!issued) return {};
        logDispatchBinding({ event: "dispatch_token_issued", endpoint: "next", task_id: taskId, agent_name: agentName, token_id: issued.tokenId, issued_net: ipHash });
        return { dispatch_token: issued.token, dispatch_token_expires_at: issued.expiresAt };
      } catch (e) {
        console.error("dispatch token:", e instanceof Error ? e.message : String(e));
        return {};
      }
    };

    const serveVerify = async (): Promise<Response> => {
      mark("verify_start");
      // 單一佇列（2026-09-22）：池子已照 queue_at 排，第一筆就是等最久的（訪客看得到的、被插隊的在 1980 年段）。
      // 桶子（訪客／裁決／來源等級／隨機）全部退場：等最久的先，每一筆都輪得到。
      const pick = candidates[0]!;
      // 派過就排到隊尾（task_dispatched 蓋 now()）；記不成不影響派工
      try { await supabase.rpc("task_dispatched", { p_task_id: `verify:${pick.id}` }); } catch (e) { console.error("task_dispatched(verify):", e instanceof Error ? e.message : String(e)); }
      // 派發即綁定（2026-09-21）：記下「這一筆派給了這個來源 IP」，投票時要求對得上。
      // 代理不能自己挑題目——contributions-feed 是公開的、id 拿得到，所以光關掉
      // 可以列清單的端點擋不住，執行點在這裡。
      {
        const { error: dErr } = await supabase.from("verify_dispatches")
          .upsert({ contribution_id: pick.id, ip_hash: ipHash, agent_name: agentName, dispatched_at: new Date().toISOString() }, { onConflict: "contribution_id,ip_hash" });
        if (dErr) console.error("verify dispatch record failed:", dErr.message);
      }
      // profile_gap 交的沒帶 politician_id：跟落庫一樣用任務編號指的那位，驗證者看到的身份比對才跟落庫一致（#215 的原則）
      const verifyPayload = (withTaskPolitician(pick.contribution_type, pick.payload && typeof pick.payload === "object" ? pick.payload : {}, pick.task_id)) as Record<string, unknown>;
      const verifyContext = await fetchVerifyContext(supabase, pick.contribution_type, verifyPayload, pick.id);
      // #7（2026-09-21）：既有票一併送去（去識別在 shapeVotes 做）。query-bounds: ok — 一筆貢獻的票是個位數
      const { data: priorVotes } = await supabase.from("contribution_votes")
        .select("verdict, weight, note, evidence_url, created_at").eq("contribution_id", pick.id).order("created_at", { ascending: true }).limit(50);
      // 分數（2026-09-21 票數→分數）：池子回 target_score 就用它，舊池子只有 effective_required 時退回它；
      // 兩者都沒有就不傳，shapeVerifyCurrent 會照舊不附 scoring 區塊
      const verifyCurrent = shapeVerifyCurrent(pick.contribution_type, verifyPayload, {
        ...verifyContext,
        votes: (priorVotes ?? []) as VerifyContextData["votes"],
        source_urls: Array.isArray(pick.source_urls) ? (pick.source_urls as string[]) : null,
        score: pick.score,
        target_score: typeof pick.target_score === "number" ? pick.target_score : pick.effective_required,
      });
      // 查證來源（2026-09-29）：原本只有任務附，驗證者投票時看不到——苗栗議員那批一小時 28 張「無法判斷」，
      // 都說官方名冊還沒公布，其實登記彙總表早就在。撈不到就不附，不能讓派驗證失敗。
      {
        const sq = verifySourceQuery(pick.contribution_type, verifyPayload, (verifyContext.politicians?.[0] ?? null) as Record<string, unknown> | null);
        if (sq) {
          try {
            const hints = sourcesForTask(await fetchVerificationSources(supabase), sq);
            if (hints.length > 0) (verifyCurrent as Record<string, unknown>).verification_sources = hints;
          } catch (e) {
            console.error("verify verification_sources:", e instanceof Error ? e.message : String(e));
          }
        }
      }
      // 系統來源票（2026-09-19，4 票變 3+1）：Jev 核過提交的來源就給代理看。它是正式的一票，不是提示——
      // supported 讓門檻 −1、not_supported 算一張反對；機率不到門檻或抓不到正文＝棄權，這裡照實給 abstain。
      {
        const { data: sv } = await supabase.from("jev_decisions").select("choice, probability, asked_at, probabilities, model, state")
          .eq("subject_type", "contribution").eq("subject_id", pick.id).eq("question", "source_support")
          .order("asked_at", { ascending: false }).limit(1).maybeSingle();
        if (sv) {
          const counts = Number(sv.probability) >= MIN_PROBABILITY && (sv.choice === "supported" || sv.choice === "not_supported");
          // 中選會名冊逐位核對（2026-09-24）：系統知道哪一欄對不上，就把衝突攤給驗證者看、改問「哪一個才對」——
          // 光把門檻 3 拉到 4，只是把「這個人在不在名冊上」這個問錯的問題多問幾次（leatherback）。不給系統任何新權力。
          const rosterState = typeof sv.model === "string" && sv.model.startsWith("policy-tw/roster-batch") ? (sv.state ?? {}) as Record<string, unknown> : null;
          if (rosterState) {
            (verifyCurrent as Record<string, unknown>).roster_check = sv.choice === "supported"
              ? {
                result: "系統已逐位核對中選會名冊：姓名、縣市、政黨都對得上。",
                // 2026-10-01：名冊逐位吻合的目標分數是 1，一張同意就通過、不必兩台機器——所以這一票要真的對過名冊那一列
                target_note: "名冊逐位吻合的參選紀錄目標分數是 1：你核對名冊無誤投 agree 就會通過。請打開名冊確認這一列的姓名、縣市、政黨、選舉別，note 寫出對到哪一列；發現任何一欄不對就投 disagree。",
                pdf_url: rosterState.pdf_url,
              }
              : {
                conflict: `系統已逐位核對中選會名冊：${String(rosterState.reason ?? "有欄位對不上")}。`,
                question: "請打開名冊判斷哪一個才對。名冊為準、本筆寫錯 → 投 disagree，evidence_url 放名冊網址、note 寫名冊上那一列；確定本筆才對（名冊有誤或系統讀錯）→ 投 agree 並寫明理由。「這個人確實在名冊上」不是投同意的理由——問題是本筆寫的欄位對不對。",
                pdf_url: rosterState.pdf_url,
              };
          }
          // 整批補選舉結果（2026-10-06）：系統逐位核對中選會名單，全部對得上才投；對不上的是哪幾位已列在 current.items
          if (typeof sv.model === "string" && sv.model.startsWith(RESULTS_BATCH_MODEL_PREFIX)) {
            const st = (sv.state ?? {}) as Record<string, unknown>;
            (verifyCurrent as Record<string, unknown>).results_check = sv.choice === "supported"
              ? { result: `系統已逐位核對中選會名單：${st.checked ?? "?"} 位全部對得上（同名、同縣市、地區與當選與否都一致）。`, target_note: "這一筆的目標分數因此是 1：你打開那一頁核對無誤投 agree 就會上線，note 寫你核對了哪一頁、幾位。" }
              : { result: `系統逐位核對中選會名單，有 ${Array.isArray(st.mismatches) ? st.mismatches.length : "?"} 位對不上，這一筆沒有系統票、目標分數 2。`, question: "對不上的那幾位在 current.items 最前面（status 不是 match）。請判斷是交件錯了、還是我們的地區或姓名寫法讓系統比不到。" };
          }
          // 參選紀錄改掛（2026-10-06）：系統拿中選會名冊那一列的出生年核新舊兩人，理由照實給
          if (typeof sv.model === "string" && sv.model.startsWith(REASSIGN_MODEL_PREFIX)) {
            const st = (sv.state ?? {}) as Record<string, unknown>;
            (verifyCurrent as Record<string, unknown>).reassign_check = {
              result: `系統核對中選會名冊：${String(st.reason ?? "")}`,
              cec_birth_year: st.cec_birth_year ?? null, from_birth_year: st.from_birth_year ?? null, to_birth_year: st.to_birth_year ?? null,
            };
          }
          // 號次重複（2026-10-08，補號次）：同一個號次單位裡跟另一位同號，理由與衝突的是誰照實給
          if (typeof sv.model === "string" && sv.model.startsWith(CAND_NO_DUP_MODEL_PREFIX)) {
            (verifyCurrent as Record<string, unknown>).cand_no_check = candNoCheckForVerify((sv.state ?? {}) as Record<string, unknown>, (verifyPayload as Record<string, unknown>).cand_no);
          }
          (verifyCurrent as Record<string, unknown>).system_vote = {
            verdict: counts ? sv.choice : "abstain", raw: sv.choice, probability: Number(sv.probability), checked_at: sv.asked_at,
            // 每一欄的判定（confirmed／contradicted／absent＋機率）：告訴代理哪一欄沒被證明，去補那一欄的來源
            fields: sv.probabilities ?? null,
            min_probability: MIN_PROBABILITY,
            note: counts
              ? "系統已核對提交的來源；這一票已折進門檻（supported＝門檻 −1、not_supported＝門檻 +1——它不是反對票、不會觸發裁決）。要不要反對，請你自己看第二個可信來源決定，不要只重看同一頁。"
              : "系統核對提交的來源時無法確定（抓不到正文或信心不足），這一票棄權，門檻照舊。fields 裡的逐欄判定沒有達到門檻，不能當反證。",
          };
        }
      }
      return json({
        ...base,
        kind: "verify",
        ...(await tokenFor(`verify:${pick.id}`)),
        item: {
          current: verifyCurrent,
          contribution_id: pick.id,
          contribution_type: pick.contribution_type,
          payload: pick.payload,
          source_urls: pick.source_urls,
          note: pick.note,
          task_id: pick.task_id,
          submitted_by: pick.agent_name,
          agree_count: pick.agree_count,
          disagree_count: pick.disagree_count,
          unsure_count: pick.unsure_count,
          // 有效門檻（系統票已折進去）；池子沒回時退回原門檻
          required_agree: typeof pick.effective_required === "number" ? pick.effective_required : requiredAgree(pick.contribution_type, pick.payload, pick.source_urls ?? []),
          created_at: pick.created_at,
          // 疑似口號、行程、個人表態：先問「這是不是政見」，不要因為來源真的這樣寫就投同意
          ...(pick.contribution_type === "policy"
            ? (() => {
              const notice = policyLikenessNotice(verifyPayload.title, verifyPayload.description);
              return notice ? { warning: notice } : {};
            })()
            : {}),
        },
        // 依型別給該問的第一個問題：驗一份裁決卻先講政見的判準，代理會照著問錯的東西
        // （selkie 2026-09-21）。共同的那一段（怎麼送票）不分型別。
        how_to: (pick.contribution_type === "policy"
          ? "新增政見（contribution_type=policy）先問一句『這是不是政見』——政見是當選後要做的具體事情，標語、團隊組成、行程、個人表態不是，那種投 disagree。"
          : pick.contribution_type === "adjudication"
          ? "你判的是**這份裁決站不站得住**，不是自己重判一次爭議：看裁決者的 reason 能不能從它列的 checked_urls 推得出來、有沒有漏掉反方的反證。"
          : pick.contribution_type === "no_change"
          ? "先看提交者說查了哪些網址、outcome 填的是哪一種：只有 confirmed 是在宣稱「來源支持、資料無誤」，那一種才要求你核對來源真的支持它。"
          : "打開 source_urls，逐欄核對 payload 與來源原文對不對得上。") +
          "再逐筆打開 source_urls 核對 payload 每個欄位 → POST /report {kind:'verify', contribution_id, verdict: agree|disagree|unsure, evidence_url?, note?, agent_name, agent_tool, dispatch_token}（dispatch_token＝這個回應裡的 dispatch_token，原樣帶回；帶了就不看 IP，領取與回報出口 IP 不同網段也交得回去）；不確定投 unsure，不要猜。",
      });
    };

    // task：先清過期認領、讀未過期的（別人領走的目標 30 分鐘內不派）
    await supabase.rpc("contribution_task_leases_purge");
    // query-bounds: ok — 只有未過期的認領（LEASE_MINUTES=30 分鐘），上面剛 purge 過，同時在跑的代理是個位數
    const { data: leaseRows, error: leaseError } = await supabase.from("contribution_task_leases").select("task_id, target_key, agent_name, leased_until").gt("leased_until", new Date().toISOString());
    if (leaseError) throw new Error(`leases read: ${leaseError.message}`);
    let leases = (leaseRows ?? []) as Array<{ task_id: string; target_key: string; agent_name: string; leased_until: string }>;
    if (skipTaskId) {
      // 只能釋放自己認領的，不能幫別人放掉
      const { error: relErr } = await supabase.from("contribution_task_leases")
        .delete().eq("task_id", skipTaskId).eq("agent_name", agentName);
      if (relErr) throw new Error(`lease release: ${relErr.message}`);
      leases = leases.filter((l) => l.task_id !== skipTaskId);
    }
    const leasedUntil = new Date(Date.now() + LEASE_MINUTES * 60 * 1000).toISOString();
    const lease = async (taskId: string, target: unknown) => {
      const { error } = await supabase.from("contribution_task_leases").upsert(
        { task_id: taskId, target_key: taskTargetKey({ task_id: taskId, target }), agent_name: agentName, ip_hash: ipHash, leased_until: leasedUntil },
        { onConflict: "task_id" },
      );
      if (error) throw new Error(`lease upsert: ${error.message}`);
    };
    const howTo = "到優先來源（官方優先）查證 → POST /report {kind:'contribute', task_id, contribution_type, payload, source_urls, agent_name, agent_tool, dispatch_token}（dispatch_token＝這個回應裡的 dispatch_token，原樣帶回）；查不到就不提交、回報時計入「查不到」。";

    // 派工合成單一佇列（2026-09-21，排序規則與理由見 _shared/dispatch.ts 的大段註解）：
    // 自動缺口與手動任務是同一張佇列、用同一把尺（queue_at），由 contribution_queue_tasks 排好序。
    // 合格判斷在 SQL 裡、LIMIT 之前（認領中／同 IP 交過／在途飽和／skip 過／no_change 在途），派過的排後面；
    // 程式裡的過濾器留著當保險（手動任務的飽和、回報查無仍靠這裡）。
    // 2026-09-20：原本只抓 12 筆再過濾，優先層 ≥12 時那一頁永遠全在優先層，後面 800 筆輪不到
    const freeQueue = filterSaturatedTasks(filterSkippedTasks(filterReportedDeadEnds(filterOwnSubmittedTasks(
      filterLeasedTasks(filterAdjudicateTasks(queueRows, agentName, pendingAdjudicated, myVotedOriginalIds), leases, agentName),
      mySubmittedTaskIds,
    ), deadEndTaskIds), skippedTaskIds), inFlightByTask);

    // SQL 已經排好序：第一筆就是最佳候選；手動任務並列第一時用 seed 散開（pickQueueTaskHead）。
    // 只用 id 分辨種類（auto: 開頭是自動缺口），種類給 pickQueueHead 比同一刻的先後。
    const taskHead = pickQueueTaskHead(freeQueue, seed);
    const manualHead = taskHead && isManualTaskId(taskHead.task_id) ? taskHead : null;
    const autoHead = taskHead && !manualHead ? taskHead : null;
    // 單一佇列（2026-09-22）：驗證、手動任務、自動缺口各出一個最前的，誰的 queue_at 最早誰先。
    // 驗證不再有自己的節奏（3:1 退場）：它只是特定類型的任務。
    const verifyHead = candidates[0] ?? null;
    const head = pickQueueHead([
      verifyHead ? { kind: "verify", queue_at: verifyHead.queue_at ?? verifyHead.created_at } : null,
      manualHead ? { kind: "manual", queue_at: manualHead.queue_at } : null,
      autoHead ? { kind: "auto", queue_at: autoHead.queue_at } : null,
    ]);
    if (head === "verify") return await serveVerify();
    // 每台機器自己的 2:1（2026-09-24）：佇列說該派任務，但這台機器最近三次拿到的驗證不到兩次、又有它能驗的 → 先派驗證。
    // 插隊期間放寬成 1:2（2026-09-27）。紀錄用派工本來就會寫的兩張表：驗證派發、任務認領（leased_until＝派出時間＋認領時長）。
    const headAt = head === "manual" ? (manualHead ? manualHead.queue_at : null) : autoHead?.queue_at;
    // 插隊的任務也照看（1:2，見 dispatch.ts 的 machineOwesVerifyDuringBoost）：不然大量插隊時驗證整個停擺
    const boosting = isFrontQueueAt(headAt);
    if (candidates.length > 0) {
      const since = new Date(Date.now() - MACHINE_LOOKBACK_HOURS * 3600_000).toISOString();
      // query-bounds: ok — 只取這個來源 IP 最近 3 筆
      const [{ data: rv }, { data: rt }] = await Promise.all([
        supabase.from("verify_dispatches").select("dispatched_at").eq("ip_hash", ipHash).gte("dispatched_at", since).order("dispatched_at", { ascending: false }).limit(MACHINE_WINDOW),
        supabase.from("contribution_task_leases").select("leased_until").eq("ip_hash", ipHash).order("leased_until", { ascending: false }).limit(MACHINE_WINDOW),
      ]);
      const recent = [
        ...((rv ?? []) as Array<{ dispatched_at: string }>).map((r) => ({ k: "verify" as const, t: Date.parse(r.dispatched_at) })),
        ...((rt ?? []) as Array<{ leased_until: string }>).map((r) => ({ k: "task" as const, t: Date.parse(r.leased_until) - LEASE_MINUTES * 60_000 })),
      ].sort((a, b) => b.t - a.t).map((r) => r.k);
      if (boosting ? machineOwesVerifyDuringBoost(recent) : machineOwesVerify(recent)) return await serveVerify();
    }
    const manualFirst = head === "manual";

    // 隊頭是手動任務：用 id 單筆查描述等內容（不撈清單）。併發下它可能剛被關掉（派工列由觸發器收回，但這一輪的清單是之前讀的）——
    // 查不到就跳過它、往下挑下一筆（最多 5 筆），不能直接回 none。往下挑到自動缺口就改派那一筆。
    let manualRow: ManualRow | null = null;
    let fallbackHead: { task_id: string; task_type: string; target: unknown; what_we_need: string; hint_sources: string[]; reward: number; queue_at: string } | null = autoHead;
    if (manualFirst) {
      let remaining = freeQueue;
      fallbackHead = null;
      for (let tries = 0; tries < 5; tries++) {
        const h = pickQueueTaskHead(remaining, seed);
        if (!h) break;
        if (!isManualTaskId(h.task_id)) { fallbackHead = h; break; }
        const { data: row, error: rowErr } = await supabase.from("contribution_tasks")
          .select("id, title, description, task_type, target, region, priority, reward, source, suggested_by, hint_sources, created_at")
          .eq("id", h.task_id).eq("status", "open").maybeSingle();
        if (rowErr) throw new Error(`manual task lookup: ${rowErr.message}`);
        if (row) { manualRow = row as ManualRow; break; }
        remaining = remaining.filter((x) => x.task_id !== h.task_id);
      }
    }

    if (manualRow) {
      mark("pick_manual");
      const t = manualRow;
      const manualTarget = (t.target && typeof t.target === "object" ? t.target : {}) as Record<string, unknown>;
      await lease(t.id, t.target);
      const electionList = await loadElections(supabase);
      // 派過就排後面（task_dispatches，跟自動缺口同一條路）；記不成不影響派工
      try { await supabase.rpc("task_dispatched", { p_task_id: t.id }); } catch (e) { console.error("task_dispatched(manual):", e instanceof Error ? e.message : String(e)); }
      return json({
        ...base,
        kind: "task",
        lease_minutes: LEASE_MINUTES,
        ...(await tokenFor(t.id)),
        item: {
          task_id: t.id, task_type: t.task_type, source: t.source ?? "manual", suggested_by: t.suggested_by ?? null, target: withElectionKey(t.target, electionList), ...describeManualTask(t), hint_sources: t.hint_sources ?? [], reward: t.reward, suggested_contribution_type: SUGGESTED_TYPE[t.task_type] ?? null,
          current: shapeTaskCurrent(t.task_type, await fetchTaskContext(supabase, t.task_type, manualTarget), { task_id: t.id ?? null, target: manualTarget }),
          lookup: buildLookup(manualTarget),
        },
        how_to: howTo,
      });
    }
    const t = fallbackHead;
    if (!t) {
      // 任務給不出來就退回驗證（2026-09-20：配額算完是 task、task 空手，以前直接回 none 叫代理等 30 分鐘，
      // 驗證池明明有一千多筆——W-Policy 的代理整晚拿到 none）
      if (candidates.length > 0) return await serveVerify();
      const all = queueRaw;
      const reason = all.length > 0
        ? "這一輪抽到的任務對你都不合格（你交過在等票、剛跳過、或裁決跟你有關），驗證池也空了；幾分鐘後再來會抽到別的"
        : (openTasks > 0 ? "目前所有缺口任務都在別人手上或已飽和，驗證池也空了；幾分鐘後再來" : "目前沒有待驗證、也沒有缺口任務");
      return json({ ...base, kind: "none", reason, retry_after_min: RETRY_AFTER_MIN });
    }
    mark("pick_auto");
    const autoTarget = (t.target && typeof t.target === "object" ? t.target : {}) as Record<string, unknown>;
    await lease(t.task_id, t.target);
    // 派過就排後面（task_dispatches）；記不成不影響派工
    try { await supabase.rpc("task_dispatched", { p_task_id: t.task_id }); } catch (e) { console.error("task_dispatched:", e instanceof Error ? e.message : String(e)); }
    return json({
      ...base,
      kind: "task",
      lease_minutes: LEASE_MINUTES,
      ...(await tokenFor(t.task_id)),
      item: {
        ...t,
        target: withElectionKey(t.target, await loadElections(supabase)),
        source: "auto",
        suggested_contribution_type: SUGGESTED_TYPE[t.task_type] ?? null,
        current: shapeTaskCurrent(t.task_type, await fetchTaskContext(supabase, t.task_type, autoTarget), { task_id: t.task_id ?? null, target: autoTarget }),
        lookup: buildLookup(autoTarget),
      },
      how_to: howTo,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("next error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
}

// 每個請求各自記時間（2026-10-02：量 /next 那 4.5 秒的底在哪）。
// 不用模組層級變數 —— Deno.serve 會在同一個 isolate 併發處理請求，共用變數會互相蓋掉。
// Server-Timing 是標頭，不改回應內容，代理讀的 JSON 不受影響。各段數字是「從收到請求到該點」的累計毫秒。
Deno.serve(async (req) => {
  const t0 = performance.now();
  const marks: Array<[string, number]> = [];
  const mark = (name: string) => { marks.push([name, performance.now() - t0]); };
  const res = await handle(req, mark);
  mark("total");
  const headers = new Headers(res.headers);
  headers.set("Server-Timing", marks.map(([n, d]) => `${n};dur=${d.toFixed(0)}`).join(", "));
  headers.set("Access-Control-Expose-Headers", "Server-Timing");
  return new Response(res.body, { status: res.status, headers });
});
