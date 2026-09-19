import { PROTOCOL_URL, PROTOCOL_VERSION } from "../_shared/protocol.ts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ipHashOf } from "../_shared/contribute-handler.ts";
import { fetchAllRows } from "../_shared/fetch-all.ts";
import { chooseKind, excludeOwnAdjudications, filterAdjudicateTasks, filterAnsweredQuestionTasks, filterLeasedTasks, filterOwnSubmittedTasks, filterReportedDeadEnds, filterSkippedTasks, filterSaturatedTasks, filterVerifyCandidates, fullQuestionIdsOf, LEASE_MINUTES, pickBySeed, pickManualTask, SKIP_MEMORY_HOURS, sortQuestionTasksBySupport, taskTargetKey, VERIFY_TASK_RATIO } from "../_shared/dispatch.ts";
import { requiredAgree } from "../_shared/consensus.ts";
import { agentNameProblem, resolveActorFromRequest } from "../_shared/actor.ts";
import { CONTRIBUTE_DAILY_LIMIT_PER_IP } from "../_shared/contribute-handler.ts";
import { VERIFY_DAILY_LIMIT_PER_IP } from "../_shared/verify-handler.ts";
import { bestSourceKind, sourceRank } from "../_shared/source-priority.ts";
import { buildLookup, fetchTaskContext, fetchVerifyContext, shapeTaskCurrent, shapeVerifyCurrent } from "../_shared/task-context.ts";
import { describeManualTask } from "../_shared/task-admin.ts";
import { policyLikenessNotice } from "../_shared/policy-likeness.ts";
import { SUGGESTED_TYPE } from "../_shared/task-types.ts";

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
// 2026-09-20：從 30 降到 5——回 none 幾乎都是暫時的（別人認領中、這一輪抽到的都不合格），等 30 分鐘是白等
const RETRY_AFTER_MIN = 5;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
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
    const ipHashForIdentity = await ipHashOf(req, Deno.env.get("CONTRIBUTION_IP_SALT") || supabaseUrl);
    const identity = await resolveActorFromRequest(agentName, ipHashForIdentity);
    if (!identity.ok) return json({ success: false, error: "identity_invalid", message: identity.error }, identity.status);
    const actor = identity.actor;
    agentName = actor.handle;
    const nameProblem = agentNameProblem(agentName);
    if (nameProblem) return json({ success: false, error: nameProblem }, 400);
    const ipHash = ipHashForIdentity;
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const seed = `${agentName}|${ipHash}|${Date.now()}`;

    // 記住這個 IP 跳過了哪個任務：SKIP_MEMORY_HOURS 內不再派回來（別人照樣可以領）。
    // 要在分流之前寫：這一輪若輪到 verify，後面派任務的那段根本不會跑到。
    if (skipTaskId) {
      const { error: skipErr } = await supabase.from("contribution_task_skips").upsert(
        { task_id: skipTaskId, ip_hash: ipHash, agent_name: agentName, skipped_at: new Date().toISOString() },
        { onConflict: "task_id,ip_hash" },
      );
      if (skipErr) throw new Error(`skip record: ${skipErr.message}`);
    }

    // 待驗證池：在 SQL 裡就排掉這台機器提交的、投過的、已達門檻的，撈出來的就是真的能投的最早 N 筆。
    // 原本先取最早 30 筆再在這裡排，機器投完那 30 筆就整池是死的，第 31 筆之後永遠看不到（2026-09-19）。
    // 身份用來源 IP：代號是自報的、可以共用；IP 雜湊不會重複。
    const pendingQuery = supabase.rpc("contribution_verify_pool", { p_ip_hash: ipHash, p_region: region, p_limit: CANDIDATE_POOL });

    const [pendingRes, myVotesRes, myContribRes, countsRes, manualRes, adjRows, mySubmittedRows, deadEndRows, myVotedOnRows, ipContribRes, ipVoteRes, myAnswersRows, skipsRes] = await Promise.all([
      pendingQuery,
      supabase.from("contribution_votes").select("id", { count: "exact", head: true }).eq("agent_name", agentName).gte("created_at", todayStart.toISOString()),
      supabase.from("contributions").select("id", { count: "exact", head: true }).eq("agent_name", agentName).gte("created_at", todayStart.toISOString()),
      supabase.rpc("contribution_auto_task_counts", { p_region: region }),
      supabase.from("contribution_tasks").select("id, title, description, task_type, target, region, priority, reward, source, suggested_by, hint_sources, created_at").eq("status", "open")
        // 派過的排到後面（2026-09-17：「任務自己要有個時間戳，派過就向後排」）：
        // 原本只按 priority／created_at 排，最舊的那幾筆永遠佔著 pickManualTask 的前 3 名視窗。
        .order("priority", { ascending: false }).order("last_dispatched_at", { ascending: true, nullsFirst: true }).order("created_at", { ascending: true }).limit(20),
      // 未定案的裁決（等它的票就好，先不再派同一筆的裁決任務）
      fetchAllRows<{ payload: Record<string, unknown> }>("pending adjudications", (from, to) =>
        supabase.from("contributions").select("payload").eq("contribution_type", "adjudication")
          .in("status", ["pending", "verified"]).order("created_at", { ascending: true }).range(from, to)),
      // 這個代理（同代號或同來源 IP）交過、還在等票的任務（資料庫還沒變，缺口會被重算出來，不該再派）
      fetchAllRows<{ task_id: string }>("my submitted tasks", (from, to) =>
        supabase.from("contributions").select("task_id").or(`agent_name.eq.${agentName},contributor_ip_hash.eq.${ipHash}`)
          .in("status", ["pending", "verified"]).not("task_id", "is", null).order("created_at", { ascending: false }).range(from, to)),
      // 任何人回報過「查了沒東西」且還在等票的任務：期間不要再派給別人重查
      fetchAllRows<{ payload: Record<string, unknown> }>("no_change reports", (from, to) =>
        supabase.from("contributions").select("payload").eq("contribution_type", "no_change")
          .in("status", ["pending", "verified"]).order("created_at", { ascending: true }).range(from, to)),
      // 這台機器投過票的貢獻。身份只看來源 IP（2026-09-19 裁決：代號可以共用，IP 不會重複）。
      // 用途：裁決要排掉這些——對原貢獻投過票的人再去裁決同一件爭議，不是第三方裁決。
      // 驗證池的排除已經在 SQL 裡做了（contribution_verify_pool），這份只是給裁決用。
      // 這一份只會成長（沒有狀態篩選）：gcp-verifier 一小時 35 票，破 1000 之後
      // 代理會一直拿到自己投過的東西，白做一次查證再吃 409（2026-09-18 實查 589 票）
      fetchAllRows<{ contribution_id: string }>("my votes", (from, to) =>
        supabase.from("contribution_votes").select("contribution_id")
          .eq("verifier_ip_hash", ipHash)
          .order("created_at", { ascending: true }).range(from, to)),
      // 額度是「每個來源 IP 每日」算的，不是每個代號。同一台機器跑三個代號共用同一份，
      // 所以這裡要按 ip_hash 數，按 agent_name 數會給出偏低的用量、讓代理以為還有很多。
      supabase.from("contributions").select("id", { count: "exact", head: true })
        .eq("contributor_ip_hash", ipHash).gte("created_at", todayStart.toISOString()),
      supabase.from("contribution_votes").select("id", { count: "exact", head: true })
        .eq("verifier_ip_hash", ipHash).gte("created_at", todayStart.toISOString()),
      // 這個代理（同代號或同來源 IP）答過的提問，含已上線：question_answers 只記代號，換代號就擋不住。
      // 含 applied 表示這份只會成長、不會退場，跟「my votes」同一類，要翻頁撈（2026-09-19）
      fetchAllRows<{ task_id: string }>("my answered questions", (from, to) =>
        supabase.from("contributions").select("task_id").eq("contribution_type", "question_answer")
          .or(`agent_name.eq.${agentName},contributor_ip_hash.eq.${ipHash}`)
          .in("status", ["pending", "verified", "applied"]).not("task_id", "is", null)
          .order("created_at", { ascending: true }).range(from, to)),
      // 這個來源 IP 最近按過 skip 的任務
      supabase.from("contribution_task_skips").select("task_id").eq("ip_hash", ipHash)
        .gte("skipped_at", new Date(Date.now() - SKIP_MEMORY_HOURS * 3600 * 1000).toISOString()).limit(1000),
    ]);
    for (const r of [pendingRes, myVotesRes, myContribRes, countsRes, manualRes, ipContribRes, ipVoteRes, skipsRes]) {
      if (r.error) throw new Error(r.error.message);
    }
    // deno-lint-ignore no-explicit-any
    const skippedTaskIds = new Set<string>(((skipsRes.data ?? []) as any[]).map((r) => r.task_id).filter((v): v is string => typeof v === "string"));
    if (skipTaskId) skippedTaskIds.add(skipTaskId);
    // deno-lint-ignore no-explicit-any
    const pendingAdjudicated = new Set<string>((adjRows as any[]).map((r) => r.payload?.contribution_id).filter((v): v is string => typeof v === "string"));
    // deno-lint-ignore no-explicit-any
    const mySubmittedTaskIds = new Set<string>([...(mySubmittedRows as any[]), ...(myAnswersRows as any[])]
      .map((r) => r.task_id).filter((v): v is string => typeof v === "string"));
    // deno-lint-ignore no-explicit-any
    // 任務底下還在等票幾筆：李四川那筆有 21 筆，於是它永遠不會關、也就永遠被派。
    // 要翻頁撈——PostgREST 一次只回 1000 列，寫 .limit(5000) 只會拿到前 1000 筆，
    // 排在後面的任務就會被當成「底下沒人做」一直派（2026-09-17 抓到同一個坑害貢獻榜失準）。
    const inFlightRows = await fetchAllRows<{ task_id: string }>(
      "in-flight by task",
      (from, to) => supabase.from("contributions").select("task_id")
        .in("status", ["pending", "verified", "disputed"]).not("task_id", "is", null)
        .order("created_at", { ascending: true }).range(from, to),
    );
    const inFlightByTask = new Map<string, number>();
    for (const r of inFlightRows) {
      const id = r.task_id;
      if (typeof id === "string") inFlightByTask.set(id, (inFlightByTask.get(id) ?? 0) + 1);
    }
    const deadEndTaskIds = new Set<string>((deadEndRows as any[])
      .map((r) => (r.payload && typeof r.payload === "object" ? r.payload.task_id : null))
      .filter((v): v is string => typeof v === "string"));
    // deno-lint-ignore no-explicit-any
    const myVotedOriginalIds = new Set<string>((myVotedOnRows as any[]).map((r) => r.contribution_id).filter((v): v is string => typeof v === "string"));

    type PendingRow = {
  /** contribution_verify_pool 回的有效門檻（2026-09-20） */
  effective_required?: number | null;
      id: string; contribution_type: string; payload: unknown; source_urls: string[]; note: string | null; task_id: string | null;
      agent_name: string; agent_tool: string | null; contributor_ip_hash: string; agree_count: number; disagree_count: number; unsure_count: number;
      status: string; created_at: string;
    };
    // deno-lint-ignore no-explicit-any
    const me = { agent_name: agentName, ip_hash: ipHash, voted_ids: myVotedOriginalIds };
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
      const questionTaskIds = manualRaw.filter((t) => t.task_type === "question").map((t) => t.task_id);
      const [{ data: qRows, error: qErr }, { data: qaRows, error: qaErr }, { data: inFlightRows, error: ifErr }] = await Promise.all([
        supabase.from("citizen_questions").select("id, stance_up, answer_count").in("id", questionIds),
        supabase.from("question_answers").select("question_id, agent_name").in("question_id", questionIds),
        // 還在等票的答案也佔名額
        supabase.from("contributions").select("task_id").eq("contribution_type", "question_answer")
          .in("status", ["pending", "verified"]).in("task_id", questionTaskIds).limit(1000),
      ]);
      if (qErr) throw new Error(`citizen_questions lookup: ${qErr.message}`);
      if (qaErr) throw new Error(`question_answers lookup: ${qaErr.message}`);
      if (ifErr) throw new Error(`in-flight answers lookup: ${ifErr.message}`);
      const stanceById = new Map(((qRows ?? []) as Array<{ id: string; stance_up: number }>).map((r) => [r.id, r.stance_up]));
      const inFlightByTaskId = new Map<string, number>();
      for (const r of (inFlightRows ?? []) as Array<{ task_id: string }>) inFlightByTaskId.set(r.task_id, (inFlightByTaskId.get(r.task_id) ?? 0) + 1);
      const fullQuestionIds = fullQuestionIdsOf((qRows ?? []) as Array<{ id: string; answer_count: number }>, manualRaw, inFlightByTaskId);
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
    // 額度直接回給代理：以前它只能一直做到撞上 429 才知道用完了，
    // 而 429 是在 POST /report 才發生——那時候查證的工都已經做完，白費。
    const quota = {
      scope: "每個來源 IP，UTC 零時重置；同一台機器的多個代號共用",
      submit: {
        limit: CONTRIBUTE_DAILY_LIMIT_PER_IP,
        used: ipContribRes.count ?? 0,
        remaining: Math.max(0, CONTRIBUTE_DAILY_LIMIT_PER_IP - (ipContribRes.count ?? 0)),
      },
      verify: {
        limit: VERIFY_DAILY_LIMIT_PER_IP,
        used: ipVoteRes.count ?? 0,
        remaining: Math.max(0, VERIFY_DAILY_LIMIT_PER_IP - (ipVoteRes.count ?? 0)),
      },
    };
    // protocol_version：代理拿它跟自己手上那份 skill.md 的版本比，不一樣就要重讀再繼續。
    // 不然協議改了，還在跑的代理會照舊規則做到下一次重啟。
    // agent：伺服器解析出來的身份（序號登入時代理不知道自己的代號是什麼，這裡告訴它；藍圖 §3）
    const base = { success: true, agent_name: agentName, agent_tool: agentTool, agent: { handle: actor.handle, level: actor.level }, total_pending: totalPending, open_tasks: openTasks, ratio: `${VERIFY_TASK_RATIO}:1`, quota, protocol_version: PROTOCOL_VERSION, docs: PROTOCOL_URL };

    const serveVerify = async (): Promise<Response> => {
      // 優先派來源等級高的（官方 > 媒體 > 社群 > 其他），同等級內隨機
      const ranked = [...candidates].sort((a, b) => sourceRank(bestSourceKind(b.source_urls)) - sourceRank(bestSourceKind(a.source_urls)));
      const topRank = sourceRank(bestSourceKind(ranked[0].source_urls));
      const pick = pickBySeed(ranked.filter((c) => sourceRank(bestSourceKind(c.source_urls)) === topRank), seed)!;
      const verifyPayload = (pick.payload && typeof pick.payload === "object" ? pick.payload : {}) as Record<string, unknown>;
      const verifyCurrent = shapeVerifyCurrent(pick.contribution_type, verifyPayload, await fetchVerifyContext(supabase, pick.contribution_type, verifyPayload));
      // 系統來源票（2026-09-19，4 票變 3+1）：Jev 核過提交的來源就給代理看。它是正式的一票，不是提示——
      // supported 讓門檻 −1、not_supported 算一張反對；機率不到門檻或抓不到正文＝棄權，這裡照實給 abstain。
      {
        const { data: sv } = await supabase.from("jev_decisions").select("choice, probability, asked_at, probabilities")
          .eq("subject_type", "contribution").eq("subject_id", pick.id).eq("question", "source_support")
          .order("asked_at", { ascending: false }).limit(1).maybeSingle();
        if (sv) {
          const counts = Number(sv.probability) >= 0.95 && (sv.choice === "supported" || sv.choice === "not_supported");
          (verifyCurrent as Record<string, unknown>).system_vote = {
            verdict: counts ? sv.choice : "abstain", raw: sv.choice, probability: Number(sv.probability), checked_at: sv.asked_at,
            // 每一欄的判定（confirmed／contradicted／absent＋機率）：告訴代理哪一欄沒被證明，去補那一欄的來源
            fields: sv.probabilities ?? null,
            min_probability: 0.95,
            note: counts
              ? "系統已核對提交的來源；這一票已折進門檻（supported＝門檻 −1、not_supported＝門檻 +1——它不是反對票、不會觸發裁決）。要不要反對，請你自己看第二個可信來源決定，不要只重看同一頁。"
              : "系統核對提交的來源時無法確定（抓不到正文或信心不足），這一票棄權，門檻照舊。fields 裡的逐欄判定沒有達到門檻，不能當反證。",
          };
        }
      }
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
        how_to: "新增政見（contribution_type=policy）先問一句『這是不是政見』——政見是當選後要做的具體事情，標語、團隊組成、行程、個人表態不是，那種投 disagree。" +
          "再逐筆打開 source_urls 核對 payload 每個欄位 → POST /report {kind:'verify', contribution_id, verdict: agree|disagree|unsure, evidence_url?, note?, agent_name, agent_tool}；不確定投 unsure，不要猜。",
      });
    };
    if (kind === "verify" && candidates.length > 0) return await serveVerify();

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
    const howTo = "到優先來源（官方優先）查證 → POST /report {kind:'contribute', task_id, contribution_type, payload, source_urls, agent_name, agent_tool}；查不到就不提交、回報時計入「查不到」。";

    // 手動任務優先（priority 高者），否則自動缺口隨機一筆
    const freeManual = filterSaturatedTasks(filterSkippedTasks(filterReportedDeadEnds(filterOwnSubmittedTasks(
      filterLeasedTasks(filterAdjudicateTasks(manual, agentName, pendingAdjudicated, myVotedOriginalIds), leases, agentName),
      mySubmittedTaskIds,
    ), deadEndTaskIds), skippedTaskIds), inFlightByTask);
    if (freeManual.length > 0) {
      // 依 priority 分層挑，不要整池隨機——否則 priority 與提問的表態數都是白寫的
      const t = pickManualTask(freeManual, seed)!;
      const manualTarget = (t.target && typeof t.target === "object" ? t.target : {}) as Record<string, unknown>;
      await lease(t.id, t.target);
      // 派出就蓋章，下一次排到後面（自動缺口是即時算出來的，沒有列可蓋）
      await supabase.from("contribution_tasks").update({ last_dispatched_at: new Date().toISOString() }).eq("id", t.id);
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
    // 合格判斷在 SQL 裡、LIMIT 之前（認領中／同 IP 交過／在途飽和／skip 過／no_change 在途），派過的排後面；
    // 程式裡的過濾器留著當保險。2026-09-20：原本只抓 12 筆再過濾，優先層 ≥12 時那一頁永遠全在優先層，後面 800 筆輪不到
    const autoRes = await supabase.rpc("contribution_auto_tasks", { p_type: null, p_region: region, p_limit: 30, p_seed: seed, p_ip_hash: ipHash, p_agent: agentName });
    if (autoRes.error) throw new Error(`auto tasks: ${autoRes.error.message}`);
    type AutoTask = { task_id: string; task_type: string; target: unknown; what_we_need: string; hint_sources: string[]; reward: number };
    const freeAuto = filterSaturatedTasks(filterSkippedTasks(filterReportedDeadEnds(filterOwnSubmittedTasks(
      filterLeasedTasks(filterAdjudicateTasks((autoRes.data ?? []) as AutoTask[], agentName, pendingAdjudicated, myVotedOriginalIds), leases, agentName),
      mySubmittedTaskIds,
    ), deadEndTaskIds), skippedTaskIds), inFlightByTask);
    const t = freeAuto[0];
    if (!t) {
      // 任務給不出來就退回驗證（2026-09-20：配額算完是 task、task 空手，以前直接回 none 叫代理等 30 分鐘，
      // 驗證池明明有一千多筆——W-Policy 的代理整晚拿到 none）
      if (candidates.length > 0) return await serveVerify();
      const all = (autoRes.data ?? []) as AutoTask[];
      const reason = all.length > 0
        ? "這一輪抽到的任務對你都不合格（你交過在等票、剛跳過、或裁決跟你有關），驗證池也空了；幾分鐘後再來會抽到別的"
        : (openTasks > 0 ? "目前所有缺口任務都在別人手上或已飽和，驗證池也空了；幾分鐘後再來" : "目前沒有待驗證、也沒有缺口任務");
      return json({ ...base, kind: "none", reason, retry_after_min: RETRY_AFTER_MIN });
    }
    const autoTarget = (t.target && typeof t.target === "object" ? t.target : {}) as Record<string, unknown>;
    await lease(t.task_id, t.target);
    // 派過就排後面（task_dispatches）；記不成不影響派工
    try { await supabase.rpc("task_dispatched", { p_task_id: t.task_id }); } catch (e) { console.error("task_dispatched:", e instanceof Error ? e.message : String(e)); }
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
