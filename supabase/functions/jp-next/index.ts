import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { JP_PROTOCOL_URL, JP_PROTOCOL_VERSION } from "../_shared/jp/protocol.ts";
import { jpClient } from "../_shared/jp/client.ts";
import { ipHashOf, submitQuotaFor } from "../_shared/jp/contribute-handler.ts";
import { verifyQuotaFor } from "../_shared/jp/verify-handler.ts";
import { requiredAgree } from "../_shared/jp/consensus.ts";
import { jpDispatchTokenSecretFrom, createJpSecretWarner } from "../_shared/jp/dispatch-secret.ts";
import { fetchMyVotedRows, voterHashes } from "../_shared/my-votes.ts";
import { fetchAllRows } from "../_shared/fetch-all.ts";
import { isFrontQueueAt, MACHINE_WINDOW, machineOwesVerify, machineOwesVerifyDuringBoost, filterLeasedTasks, filterOwnSubmittedTasks, filterReportedDeadEnds, filterSkippedTasks, filterSaturatedTasks, filterVerifyCandidates, pickQueueHead, LEASE_MINUTES, isManualTaskId, pickQueueTaskHead, taskTargetKey } from "../_shared/dispatch.ts";
import { agentNameProblem, resolveActorFromRequest } from "../_shared/actor.ts";
import { agentToolNotice } from "../_shared/agent-tool-hint.ts";
import { MIN_PROBABILITY } from "../_shared/system-one.ts";
import { issueDispatchToken, logDispatchBinding } from "../_shared/dispatch-token.ts";

/**
 * jp-next — 日本站統一派工端點（對應正見的 next）。無金鑰，誰都能用（同正見 next，沒有白名單）。
 * GET ?agent_name=<必填>&agent_tool=&region=&skip=
 *   → { kind:"verify", item }／{ kind:"task", item }／{ kind:"none", reason, retry_after_min }
 * 複製自 ../next/index.ts：單一佇列（驗證：任務＝2:1 由 SQL 排好 queue_at）、認領期、skip、派工憑證、每台機器自己的 2:1、額度回報。
 * 拿掉的：裁決（adjudicate）與公民提問的篩選、noop-sweep、task-context／verification-sources／task-guidance 的正見任務現況、
 *   政見口號提示、Jev 的名冊／選舉結果／改掛／號次說明（只留 system_vote 本體）、elections 查詢、Server-Timing。
 * 只讀寫 schema policy_jp（jpClient）。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const CANDIDATE_POOL = 30;
const warnNoDispatchSecret = createJpSecretWarner();
const RETRY_AFTER_MIN = 5;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabase = jpClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const url = new URL(req.url);
    let agentName = url.searchParams.get("agent_name") ?? "";
    const agentTool = url.searchParams.get("agent_tool") ?? null;
    const region = url.searchParams.get("region") || null;
    const skipTaskId = url.searchParams.get("skip")?.trim() || null;
    const ipSalt = Deno.env.get("CONTRIBUTION_IP_SALT") || supabaseUrl;
    const ipHash = await ipHashOf(req, ipSalt);
    const identity = await resolveActorFromRequest(agentName, ipHash);
    if (!identity.ok) return json({ success: false, error: "identity_invalid", message: identity.error }, identity.status);
    const actor = identity.actor;
    agentName = actor.handle;
    const nameProblem = agentNameProblem(agentName);
    if (nameProblem) return json({ success: false, error: nameProblem }, 400);
    const submitQuota = submitQuotaFor(actor, ipHash);
    const verifyQuota = verifyQuotaFor(actor, ipHash);
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const seed = `${agentName}|${ipHash}|${Date.now()}`;

    // 跳過＝「這題我不答」：跟派過一樣排到後面（task_dispatched），skips 表只留紀錄
    if (skipTaskId) {
      const { error: skipErr } = await supabase.from("contribution_task_skips").upsert(
        { task_id: skipTaskId, ip_hash: ipHash, agent_name: agentName, skipped_at: new Date().toISOString() },
        { onConflict: "task_id,ip_hash" },
      );
      if (skipErr) throw new Error(`skip record: ${skipErr.message}`);
      try {
        await supabase.rpc("task_dispatched", { p_task_id: skipTaskId });
      } catch (e) { console.error("skip push-back:", e instanceof Error ? e.message : String(e)); }
    }

    // 待驗證池：在 SQL 裡就排掉自己提交的、投過的、已達門檻的
    const pendingQuery = supabase.rpc("contribution_verify_pool", { p_ip_hash: ipHash, p_region: region, p_limit: CANDIDATE_POOL });

    const [pendingRes, countsRes, mySubmittedRows, autoRes, myVotedOnRows, ipContribRes, ipVoteRes] = await Promise.all([
      pendingQuery,
      supabase.rpc("contribution_queue_task_counts", { p_region: region }),
      // 這個代理（同代號或同來源網段）交過、還在等票的任務
      fetchAllRows<{ task_id: string }>("my submitted tasks", (from, to) =>
        supabase.from("contributions").select("task_id").or(`agent_name.eq.${agentName},contributor_ip_hash.eq.${ipHash}`)
          .in("status", ["pending", "verified"]).not("task_id", "is", null).order("created_at", { ascending: false }).range(from, to)),
      supabase.rpc("contribution_queue_tasks", { p_type: null, p_region: region, p_limit: 30, p_seed: seed, p_ip_hash: ipHash, p_agent: agentName }),
      fetchMyVotedRows(supabase, voterHashes(ipHash)),
      supabase.from("contributions").select("id", { count: "exact", head: true })
        .eq(submitQuota.column, submitQuota.value).gte("created_at", todayStart.toISOString()),
      supabase.from("contribution_votes").select("id", { count: "exact", head: true })
        .eq(verifyQuota.column, verifyQuota.value).gte("created_at", todayStart.toISOString()),
    ]);
    for (const r of [pendingRes, countsRes, ipContribRes, ipVoteRes]) {
      if (r.error) throw new Error(r.error.message);
    }
    if (autoRes.error) throw new Error(`auto tasks: ${autoRes.error.message}`);
    const skippedTaskIds = new Set<string>(skipTaskId ? [skipTaskId] : []);
    // deno-lint-ignore no-explicit-any
    const mySubmittedTaskIds = new Set<string>((mySubmittedRows as any[]).map((r) => r.task_id).filter((v): v is string => typeof v === "string"));
    // deno-lint-ignore no-explicit-any
    const myVotedOriginalIds = new Set<string>((myVotedOnRows as any[]).map((r) => r.contribution_id).filter((v): v is string => typeof v === "string"));

    type PendingRow = {
      effective_required?: number | null; score?: number | null; target_score?: number | null; visitor_facing?: boolean | null; adjudication_facing?: boolean | null;
      id: string; contribution_type: string; payload: unknown; source_urls: string[]; note: string | null; task_id: string | null;
      agent_name: string; agent_tool: string | null; contributor_ip_hash: string; agree_count: number; disagree_count: number; unsure_count: number;
      status: string; created_at: string; queue_at?: string | null;
    };
    const me = { agent_name: agentName, ip_hash: ipHash, voted_ids: myVotedOriginalIds };
    const candidates = filterVerifyCandidates((pendingRes.data ?? []) as PendingRow[], me);
    const totalPending = candidates.length;
    // deno-lint-ignore no-explicit-any
    const autoTotals: Record<string, number> = Object.fromEntries(((countsRes.data ?? []) as any[]).map((r) => [String(r.task_type), Number(r.total)]));
    type QueueRow = { task_id: string; task_type: string; target: unknown; what_we_need: string; hint_sources: string[]; reward: number; queue_at: string };
    const queueRaw = (autoRes.data ?? []) as QueueRow[];
    type ManualRow = { id: string; title: string; description: string | null; task_type: string; target: unknown; region: string | null; priority: number; reward: number; source: string | null; suggested_by: string | null; hint_sources: string[] | null; created_at: string };

    // 在途數與「有人回報查無」只查這一輪的候選（任務列前 30 筆）
    const candidateTaskIds = [...new Set(queueRaw.map((t) => t.task_id).filter((v): v is string => typeof v === "string"))];
    const inFlightByTask = new Map<string, number>();
    const deadEndTaskIds = new Set<string>();
    if (candidateTaskIds.length > 0) {
      const [{ data: ifRows, error: ifErr }, { data: deRows, error: deErr }] = await Promise.all([
        // query-bounds: ok — 只查候選（≤30 個 task_id）底下的在途貢獻
        supabase.from("contributions").select("task_id")
          .in("status", ["pending", "verified", "disputed"]).in("task_id", candidateTaskIds).limit(1000),
        // query-bounds: ok — 只查候選 task_id 的「查無」回報
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
    const openTasks = Object.values(autoTotals).reduce((a: number, b: number) => a + b, 0);

    const quota = {
      scope: `提交：${submitQuota.scope}；驗證：${verifyQuota.scope}。UTC 零時重置；同一台機器的多個匿名代號共用`,
      submit: { limit: submitQuota.limit, used: ipContribRes.count ?? 0, remaining: Math.max(0, submitQuota.limit - (ipContribRes.count ?? 0)) },
      verify: { limit: verifyQuota.limit, used: ipVoteRes.count ?? 0, remaining: Math.max(0, verifyQuota.limit - (ipVoteRes.count ?? 0)) },
    };
    const toolNotice = agentToolNotice(agentTool);
    const base = { success: true, agent_name: agentName, agent_tool: agentTool, agent: { handle: actor.handle, level: actor.level }, total_pending: totalPending, open_tasks: openTasks, queue: "single", quota, protocol_version: JP_PROTOCOL_VERSION, docs: JP_PROTOCOL_URL, ...(toolNotice ? { notice: toolNotice } : {}) };

    // 派工憑證：派出的那一筆簽一張；鑰匙加了 policy_jp 鹽，正見的憑證在這裡驗不過（dispatch-secret.ts）
    const dispatchSecret = jpDispatchTokenSecretFrom((k) => Deno.env.get(k));
    warnNoDispatchSecret((k) => Deno.env.get(k));
    const tokenFor = async (taskId: string): Promise<Record<string, unknown>> => {
      try {
        const issued = await issueDispatchToken(dispatchSecret, { taskId, agentName, ipHash });
        if (!issued) return {};
        logDispatchBinding({ event: "dispatch_token_issued", endpoint: "jp-next", task_id: taskId, agent_name: agentName, token_id: issued.tokenId, issued_net: ipHash });
        return { dispatch_token: issued.token, dispatch_token_expires_at: issued.expiresAt };
      } catch (e) {
        console.error("dispatch token:", e instanceof Error ? e.message : String(e));
        return {};
      }
    };

    const serveVerify = async (): Promise<Response> => {
      const pick = candidates[0]!;
      try { await supabase.rpc("task_dispatched", { p_task_id: `verify:${pick.id}` }); } catch (e) { console.error("task_dispatched(verify):", e instanceof Error ? e.message : String(e)); }
      // 派發即綁定：記下「這一筆派給了這個來源網段」，投票時要求對得上
      {
        const { error: dErr } = await supabase.from("verify_dispatches")
          .upsert({ contribution_id: pick.id, ip_hash: ipHash, agent_name: agentName, dispatched_at: new Date().toISOString() }, { onConflict: "contribution_id,ip_hash" });
        if (dErr) console.error("verify dispatch record failed:", dErr.message);
      }
      // 既有票一併送去（不含投票者身分）。query-bounds: ok — 一筆貢獻的票是個位數
      const { data: priorVotes } = await supabase.from("contribution_votes")
        .select("verdict, weight, note, evidence_url, created_at").eq("contribution_id", pick.id).order("created_at", { ascending: true }).limit(50);
      const targetScore = typeof pick.target_score === "number" ? pick.target_score : pick.effective_required;
      const verifyCurrent: Record<string, unknown> = {
        votes: priorVotes ?? [],
        ...(typeof targetScore === "number" ? { scoring: { score: pick.score ?? 0, target_score: targetScore } } : {}),
      };
      // 系統來源票（Jev）：照正見，讀 policy_jp.jev_decisions；它是正式的一票（supported 門檻 −1、not_supported +1），
      // 機率不到門檻或抓不到正文＝棄權，這裡照實給 abstain。撈不到不擋派工。
      {
        const { data: sv } = await supabase.from("jev_decisions").select("choice, probability, asked_at, probabilities, model, state")
          .eq("subject_type", "contribution").eq("subject_id", pick.id).eq("question", "source_support")
          .order("asked_at", { ascending: false }).limit(1).maybeSingle();
        if (sv) {
          const counts = Number(sv.probability) >= MIN_PROBABILITY && (sv.choice === "supported" || sv.choice === "not_supported");
          verifyCurrent.system_vote = {
            verdict: counts ? sv.choice : "abstain", raw: sv.choice, probability: Number(sv.probability), checked_at: sv.asked_at,
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
          required_agree: typeof pick.effective_required === "number" ? pick.effective_required : requiredAgree(pick.contribution_type, pick.payload, pick.source_urls ?? []),
          created_at: pick.created_at,
        },
        how_to: (pick.contribution_type === "no_change"
          ? "先看提交者說查了哪些網址、outcome 填的是哪一種：只有 confirmed 是在宣稱「來源支持、資料無誤」，那一種才要求你核對來源真的支持它。"
          : "打開 source_urls，逐欄核對 payload 與來源原文對不對得上。") +
          "再逐筆打開 source_urls 核對 payload 每個欄位 → POST jp-report {kind:'verify', contribution_id, verdict: agree|disagree|unsure, evidence_url?, note?, agent_name, agent_tool, dispatch_token}（dispatch_token＝這個回應裡的 dispatch_token，原樣帶回）；不確定投 unsure，不要猜。",
      });
    };

    // task：先清過期認領、讀未過期的（別人領走的目標 30 分鐘內不派）
    await supabase.rpc("contribution_task_leases_purge");
    // query-bounds: ok — 只有未過期的認領（LEASE_MINUTES=30 分鐘），上面剛 purge 過
    const { data: leaseRows, error: leaseError } = await supabase.from("contribution_task_leases").select("task_id, target_key, agent_name, leased_until").gt("leased_until", new Date().toISOString());
    if (leaseError) throw new Error(`leases read: ${leaseError.message}`);
    let leases = (leaseRows ?? []) as Array<{ task_id: string; target_key: string; agent_name: string; leased_until: string }>;
    if (skipTaskId) {
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
    const howTo = "到優先來源（官方優先）查證 → POST jp-report {kind:'contribute', task_id, contribution_type, payload, source_urls, agent_name, agent_tool, dispatch_token}（dispatch_token＝這個回應裡的 dispatch_token，原樣帶回）；查不到就不提交、回報時計入「查不到」。";

    const freeQueue = filterSaturatedTasks(filterSkippedTasks(filterReportedDeadEnds(filterOwnSubmittedTasks(
      filterLeasedTasks(queueRaw, leases, agentName),
      mySubmittedTaskIds,
    ), deadEndTaskIds), skippedTaskIds), inFlightByTask);

    const taskHead = pickQueueTaskHead(freeQueue, seed);
    const manualHead = taskHead && isManualTaskId(taskHead.task_id) ? taskHead : null;
    const autoHead = taskHead && !manualHead ? taskHead : null;
    const verifyHead = candidates[0] ?? null;
    const head = pickQueueHead([
      verifyHead ? { kind: "verify", queue_at: verifyHead.queue_at ?? verifyHead.created_at } : null,
      manualHead ? { kind: "manual", queue_at: manualHead.queue_at } : null,
      autoHead ? { kind: "auto", queue_at: autoHead.queue_at } : null,
    ]);
    if (head === "verify") return await serveVerify();
    // 每台機器自己的 2:1：佇列說該派任務，但這台機器最近三次拿到的驗證不到兩次、又有它能驗的 → 先派驗證（插隊期間 1:2）
    const headAt = head === "manual" ? (manualHead ? manualHead.queue_at : null) : autoHead?.queue_at;
    const boosting = isFrontQueueAt(headAt);
    if (candidates.length > 0) {
      const since = new Date(Date.now() - 3 * 3600_000).toISOString();
      // query-bounds: ok — 只取這個來源網段最近 3 筆
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

    // 隊頭是手動任務：用 id 單筆查描述；併發下它可能剛被關掉，查不到就跳過往下挑（最多 5 筆）
    let manualRow: ManualRow | null = null;
    let fallbackHead: QueueRow | null = autoHead;
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
      const t = manualRow;
      await lease(t.id, t.target);
      try { await supabase.rpc("task_dispatched", { p_task_id: t.id }); } catch (e) { console.error("task_dispatched(manual):", e instanceof Error ? e.message : String(e)); }
      return json({
        ...base,
        kind: "task",
        lease_minutes: LEASE_MINUTES,
        ...(await tokenFor(t.id)),
        item: {
          task_id: t.id, task_type: t.task_type, source: t.source ?? "manual", suggested_by: t.suggested_by ?? null, target: t.target,
          what_we_need: t.description ? `${t.title}：${t.description}` : t.title,
          hint_sources: t.hint_sources ?? [], reward: t.reward, suggested_contribution_type: null,
        },
        how_to: howTo,
      });
    }
    const t = fallbackHead;
    if (!t) {
      // 任務給不出來就退回驗證
      if (candidates.length > 0) return await serveVerify();
      const reason = queueRaw.length > 0
        ? "這一輪抽到的任務對你都不合格（你交過在等票、剛跳過），驗證池也空了；幾分鐘後再來會抽到別的"
        : (openTasks > 0 ? "目前所有缺口任務都在別人手上或已飽和，驗證池也空了；幾分鐘後再來" : "目前沒有待驗證、也沒有缺口任務");
      return json({ ...base, kind: "none", reason, retry_after_min: RETRY_AFTER_MIN });
    }
    await lease(t.task_id, t.target);
    try { await supabase.rpc("task_dispatched", { p_task_id: t.task_id }); } catch (e) { console.error("task_dispatched:", e instanceof Error ? e.message : String(e)); }
    return json({
      ...base,
      kind: "task",
      lease_minutes: LEASE_MINUTES,
      ...(await tokenFor(t.task_id)),
      item: { ...t, source: "auto", suggested_contribution_type: null },
      how_to: howTo,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("jp-next error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
}

Deno.serve(handle);
