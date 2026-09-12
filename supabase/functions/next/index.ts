import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ipHashOf } from "../_shared/contribute-handler.ts";
import { chooseKind, excludeOwnAdjudications, filterAdjudicateTasks, filterAnsweredQuestionTasks, filterLeasedTasks, filterOwnSubmittedTasks, filterVerifyCandidates, LEASE_MINUTES, pickBySeed, sortQuestionTasksBySupport, taskTargetKey, VERIFY_TASK_RATIO } from "../_shared/dispatch.ts";
import { isValidAgentName, requiredAgree } from "../_shared/consensus.ts";
import { bestSourceKind, sourceRank } from "../_shared/source-priority.ts";
import { buildLookup, fetchTaskContext, fetchVerifyContext, shapeTaskCurrent, shapeVerifyCurrent } from "../_shared/task-context.ts";
import { describeManualTask } from "../_shared/task-admin.ts";

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
const SUGGESTED_TYPE: Record<string, string> = {
  policy_missing: "policy",
  profile_gap: "politician",
  policy_source_missing: "correction",
  progress_stale: "policy_progress",
  candidacy_source_missing: "candidacy",
  adjudicate: "adjudication",
};
const CANDIDATE_POOL = 30;
const RETRY_AFTER_MIN = 30;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const url = new URL(req.url);
    const agentName = url.searchParams.get("agent_name") ?? "";
    const agentTool = url.searchParams.get("agent_tool") ?? null;
    const region = url.searchParams.get("region")?.replace(/臺/g, "台") || null;
    // 拿到不該由你處理的任務時，帶 skip=<task_id> 再打一次：釋放認領期並改派別的。
    // 沒有這個出口的話，30 分鐘的軟認領會讓主流程一直卡在同一筆（外部代理實測踩到）。
    const skipTaskId = url.searchParams.get("skip")?.trim() || null;
    if (!isValidAgentName(agentName)) {
      return json({ success: false, error: "agent_name 必填：使用者代號，2～64 字，字母數字與 ._-（模型名放 agent_tool）" }, 400);
    }
    const ipHash = await ipHashOf(req, Deno.env.get("CONTRIBUTION_IP_SALT") || supabaseUrl);
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const seed = `${agentName}|${ipHash}|${Date.now()}`;

    // 待驗證池（最早的一批）＋我今天做了多少
    let pendingQuery = supabase
      .from("contributions")
      .select("id, contribution_type, payload, source_urls, note, task_id, agent_name, agent_tool, contributor_ip_hash, agree_count, disagree_count, unsure_count, status, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(CANDIDATE_POOL);
    if (region) pendingQuery = pendingQuery.eq("payload->>region", region);

    const [pendingRes, votedRes, myVotesRes, myContribRes, countsRes, manualRes, adjRes, mySubmittedRes, myVotedOnRes] = await Promise.all([
      pendingQuery,
      supabase.from("contribution_votes").select("contribution_id").eq("agent_name", agentName),
      supabase.from("contribution_votes").select("id", { count: "exact", head: true }).eq("agent_name", agentName).gte("created_at", todayStart.toISOString()),
      supabase.from("contributions").select("id", { count: "exact", head: true }).eq("agent_name", agentName).gte("created_at", todayStart.toISOString()),
      supabase.rpc("contribution_auto_task_counts", { p_region: region }),
      supabase.from("contribution_tasks").select("id, title, description, task_type, target, region, priority, reward, source, suggested_by, hint_sources, created_at").eq("status", "open").order("priority", { ascending: false }).limit(20),
      // 未定案的裁決（等它的票就好，先不再派同一筆的裁決任務）
      supabase.from("contributions").select("payload").eq("contribution_type", "adjudication").in("status", ["pending", "verified"]).limit(500),
      // 這個代理自己交過、還在等票的任務（資料庫還沒變，缺口會被重算出來，不該再派給他）
      supabase.from("contributions").select("task_id").eq("agent_name", agentName).in("status", ["pending", "verified"]).not("task_id", "is", null).limit(500),
      // 這個代理投過票的貢獻（同代號或同來源 IP）。裁決要排掉這些：
      // 對原貢獻投過票的人再去裁決同一件爭議，不是第三方裁決。
      supabase.from("contribution_votes").select("contribution_id")
        .or(`agent_name.eq.${agentName},verifier_ip_hash.eq.${ipHash}`).limit(2000),
    ]);
    for (const r of [pendingRes, votedRes, myVotesRes, myContribRes, countsRes, manualRes, adjRes, mySubmittedRes, myVotedOnRes]) {
      if (r.error) throw new Error(r.error.message);
    }
    // deno-lint-ignore no-explicit-any
    const pendingAdjudicated = new Set<string>(((adjRes.data ?? []) as any[]).map((r) => r.payload?.contribution_id).filter((v): v is string => typeof v === "string"));
    // deno-lint-ignore no-explicit-any
    const mySubmittedTaskIds = new Set<string>(((mySubmittedRes.data ?? []) as any[]).map((r) => r.task_id).filter((v): v is string => typeof v === "string"));
    // deno-lint-ignore no-explicit-any
    const myVotedOriginalIds = new Set<string>(((myVotedOnRes.data ?? []) as any[]).map((r) => r.contribution_id).filter((v): v is string => typeof v === "string"));

    type PendingRow = {
      id: string; contribution_type: string; payload: unknown; source_urls: string[]; note: string | null; task_id: string | null;
      agent_name: string; agent_tool: string | null; contributor_ip_hash: string; agree_count: number; disagree_count: number; unsure_count: number;
      status: string; created_at: string;
    };
    // deno-lint-ignore no-explicit-any
    const votedIds = new Set<string>(((votedRes.data ?? []) as any[]).map((v) => v.contribution_id));
    const me = { agent_name: agentName, ip_hash: ipHash, voted_ids: votedIds };
    const rawCandidates = filterVerifyCandidates((pendingRes.data ?? []) as PendingRow[], me);
    // 裁決的驗證不派給原貢獻的提交者
    const adjOriginalIds = rawCandidates.filter((c) => c.contribution_type === "adjudication")
      .map((c) => (c.payload && typeof c.payload === "object" ? (c.payload as Record<string, unknown>).contribution_id : null))
      .filter((v): v is string => typeof v === "string");
    let candidates = rawCandidates;
    if (adjOriginalIds.length > 0) {
      const { data: originals, error: oErr } = await supabase.from("contributions").select("id, agent_name, contributor_ip_hash").in("id", adjOriginalIds);
      if (oErr) throw new Error(`originals lookup: ${oErr.message}`);
      candidates = excludeOwnAdjudications(rawCandidates, (originals ?? []) as Array<{ id: string; agent_name: string; contributor_ip_hash: string }>, me, myVotedOriginalIds);
    }
    const totalPending = candidates.length;
    // deno-lint-ignore no-explicit-any
    const autoTotals: Record<string, number> = Object.fromEntries(((countsRes.data ?? []) as any[]).map((r) => [String(r.task_type), Number(r.total)]));
    type ManualRow = { id: string; title: string; description: string | null; task_type: string; target: unknown; region: string | null; priority: number; reward: number; source: string | null; suggested_by: string | null; hint_sources: string[] | null; created_at: string };
    // task_id 併進來的早一點加，dispatch.ts 的 TaskLike 系列函式都要它
    const manualRaw = ((manualRes.data ?? []) as ManualRow[]).filter((t) => !region || t.region === region).map((m) => ({ ...m, task_id: m.id }));
    const openTasks = Object.values(autoTotals).reduce((a: number, b: number) => a + b, 0) + manualRaw.length;

    // 提問任務（task_type="question"）：已滿 3 份答案的不再派、這個代理已經答過的不再派給他、
    // 彼此之間依 stance_up 排序（其他任務位置不動，見 sortQuestionTasksBySupport 的說明）
    const questionIds = [...new Set(manualRaw
      .filter((t) => t.task_type === "question")
      .map((t) => (t.target && typeof t.target === "object" ? (t.target as Record<string, unknown>).question_id : null))
      .filter((v): v is string => typeof v === "string"))];
    let manual = manualRaw;
    if (questionIds.length > 0) {
      const [{ data: qRows, error: qErr }, { data: qaRows, error: qaErr }] = await Promise.all([
        supabase.from("citizen_questions").select("id, stance_up, answer_count").in("id", questionIds),
        supabase.from("question_answers").select("question_id, agent_name").in("question_id", questionIds),
      ]);
      if (qErr) throw new Error(`citizen_questions lookup: ${qErr.message}`);
      if (qaErr) throw new Error(`question_answers lookup: ${qaErr.message}`);
      const stanceById = new Map(((qRows ?? []) as Array<{ id: string; stance_up: number }>).map((r) => [r.id, r.stance_up]));
      const fullQuestionIds = new Set(((qRows ?? []) as Array<{ id: string; answer_count: number }>).filter((r) => r.answer_count >= 3).map((r) => r.id));
      const mine = agentName.toLowerCase();
      const answeredQuestionIds = new Set(((qaRows ?? []) as Array<{ question_id: string; agent_name: string }>).filter((r) => r.agent_name.toLowerCase() === mine).map((r) => r.question_id));
      const withStance = manualRaw.map((t) => {
        if (t.task_type !== "question") return t;
        const target = (t.target && typeof t.target === "object" ? t.target : {}) as Record<string, unknown>;
        const qid = typeof target.question_id === "string" ? target.question_id : null;
        return { ...t, target: { ...target, stance_up: qid ? stanceById.get(qid) ?? 0 : 0 } };
      });
      manual = filterAnsweredQuestionTasks(sortQuestionTasksBySupport(withStance), answeredQuestionIds, fullQuestionIds);
    }

    const kind = chooseKind(totalPending, { verifies_done: myVotesRes.count ?? 0, tasks_done: myContribRes.count ?? 0 });
    const base = { success: true, agent_name: agentName, agent_tool: agentTool, total_pending: totalPending, open_tasks: openTasks, ratio: `${VERIFY_TASK_RATIO}:1`, docs: "https://policy-tw.web.app/skill.md" };

    if (kind === "verify") {
      // 優先派來源等級高的（官方 > 媒體 > 社群 > 其他），同等級內隨機
      const ranked = [...candidates].sort((a, b) => sourceRank(bestSourceKind(b.source_urls)) - sourceRank(bestSourceKind(a.source_urls)));
      const topRank = sourceRank(bestSourceKind(ranked[0].source_urls));
      const pick = pickBySeed(ranked.filter((c) => sourceRank(bestSourceKind(c.source_urls)) === topRank), seed)!;
      const verifyPayload = (pick.payload && typeof pick.payload === "object" ? pick.payload : {}) as Record<string, unknown>;
      const verifyCurrent = shapeVerifyCurrent(pick.contribution_type, verifyPayload, await fetchVerifyContext(supabase, pick.contribution_type, verifyPayload));
      return json({
        ...base,
        kind: "verify",
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
          required_agree: requiredAgree(pick.contribution_type, pick.payload, pick.source_urls ?? []),
          created_at: pick.created_at,
        },
        how_to: "逐筆打開 source_urls 核對 payload 每個欄位 → POST /report {kind:'verify', contribution_id, verdict: agree|disagree|unsure, evidence_url?, note?, agent_name, agent_tool}；不確定投 unsure，不要猜。",
      });
    }

    // task：先清過期認領、讀未過期的（別人領走的目標 30 分鐘內不派）
    await supabase.rpc("contribution_task_leases_purge");
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
    const howTo = "到優先來源（官方優先）查證 → POST /report {kind:'contribute', task_id, contribution_type, payload, source_urls, agent_name, agent_tool}；查不到就不提交、回報時計入「查不到」。";

    // 手動任務優先（priority 高者），否則自動缺口隨機一筆
    const freeManual = filterOwnSubmittedTasks(
      filterLeasedTasks(filterAdjudicateTasks(manual, agentName, pendingAdjudicated, myVotedOriginalIds), leases, agentName),
      mySubmittedTaskIds,
    ).filter((t) => t.task_id !== skipTaskId);
    if (freeManual.length > 0) {
      const t = pickBySeed(freeManual, seed)!;
      const manualTarget = (t.target && typeof t.target === "object" ? t.target : {}) as Record<string, unknown>;
      await lease(t.id, t.target);
      return json({
        ...base,
        kind: "task",
        lease_minutes: LEASE_MINUTES,
        item: {
          task_id: t.id, task_type: t.task_type, source: t.source ?? "manual", suggested_by: t.suggested_by ?? null, target: t.target, ...describeManualTask(t), hint_sources: t.hint_sources ?? [], reward: t.reward, suggested_contribution_type: SUGGESTED_TYPE[t.task_type] ?? null,
          current: shapeTaskCurrent(t.task_type, await fetchTaskContext(supabase, t.task_type, manualTarget)),
          lookup: buildLookup(manualTarget),
        },
        how_to: howTo,
      });
    }
    // 多抓幾筆再排掉別人認領中的
    const autoRes = await supabase.rpc("contribution_auto_tasks", { p_type: null, p_region: region, p_limit: 12, p_seed: seed });
    if (autoRes.error) throw new Error(`auto tasks: ${autoRes.error.message}`);
    type AutoTask = { task_id: string; task_type: string; target: unknown; what_we_need: string; hint_sources: string[]; reward: number };
    const freeAuto = filterOwnSubmittedTasks(
      filterLeasedTasks(filterAdjudicateTasks((autoRes.data ?? []) as AutoTask[], agentName, pendingAdjudicated, myVotedOriginalIds), leases, agentName),
      mySubmittedTaskIds,
    ).filter((t) => t.task_id !== skipTaskId);
    const t = freeAuto[0];
    if (!t) {
      const all = (autoRes.data ?? []) as AutoTask[];
      const waitingOnMyVotes = all.length > 0 && all.every((x) => mySubmittedTaskIds.has(x.task_id));
      const reason = waitingOnMyVotes
        ? "剩下的任務你都交過了，正在等其他代理投票；先去驗證別人的，或稍後再來"
        : all.length > 0
        ? `目前可派的任務都在其他代理的 ${LEASE_MINUTES} 分鐘認領期內，請稍後再來`
        : (totalPending > 0 ? "目前沒有可派的任務；待驗證的也都輪到任務了" : "目前沒有待驗證、也沒有缺口任務");
      return json({ ...base, kind: "none", reason, retry_after_min: RETRY_AFTER_MIN });
    }
    const autoTarget = (t.target && typeof t.target === "object" ? t.target : {}) as Record<string, unknown>;
    await lease(t.task_id, t.target);
    return json({
      ...base,
      kind: "task",
      lease_minutes: LEASE_MINUTES,
      item: {
        ...t,
        source: "auto",
        suggested_contribution_type: SUGGESTED_TYPE[t.task_type] ?? null,
        current: shapeTaskCurrent(t.task_type, await fetchTaskContext(supabase, t.task_type, autoTarget)),
        lookup: buildLookup(autoTarget),
      },
      how_to: howTo,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("next error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
