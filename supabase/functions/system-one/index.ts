import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ipHashOf } from "../_shared/contribute-handler.ts";
import { computeVoteBudget, dimensionQuestions, VOTE_DIMENSIONS } from "../_shared/vote-budget.ts";
import { aggregateFieldVerdicts, askJev, buildPolicyAsk, buildSourceSupportAsk, claimOf, combineSources, type DecisionRecord, type ElectionLite, fetchSource, focusText, MIN_PROBABILITY, type PolicyLite, toRecords, validateRecord, hasUsableText, aggregateExtract, buildExtractAsk, parseExtractTask, nameHit, buildPairAsk, textSimilarity, SAME_CONTENT_THRESHOLD, subjectNamesOf } from "../_shared/system-one.ts";

/**
 * system-one — Jev（TypeSafe System One）在這個系統裡唯一的出入口。設計理由見 docs/BLUEPRINT-jev-decisions.md。
 *
 * 三個動作，三種守衛，一張表：
 *   ?action=record   POST { api_key, records[] }        外部批次腳本把已經問好的判決寫進來。SYSTEM_ONE_API_KEY。
 *   ?action=ask      POST { subject_type, subject_id }   伺服器端自己組 state、問 Jev、寫紀錄。只收 service role bearer——
 *                                                        這個動作會花錢，只讓其他 Edge Function（落庫後的觸發）叫得動。
 *   ?action=backfill POST                                撿還沒問過的、或答不出來但參考資料變多的，問掉。不帶金鑰，
 *                                                        因為 pg_cron 的呼叫寫在 migration 裡而這是開源倉庫；
 *                                                        改用成本上限守：10 分鐘內已問滿 limit 就不再問。
 *   ?action=precheck POST                                系統來源票：撿 pending 且還沒判過的貢獻，抓提交的來源、問 Jev
 *                                                        支不支持宣稱，寫 jev_decisions 後重算共識。守法同 backfill。
 *   ?action=extract  POST { task_id, url }          代理替 election_result_missing／candidate_status_stale 任務找到「第一來源」後，
 *                                                  讓 Jev 從那一頁選值（有限域欄位）。不帶金鑰，同 judge 的配額。回建議的 contribution。
 *   ?action=judge    POST { contribution_id, url }       給代理用的第二來源判定（使用者 2026-09-19：「jev 提供端點，別給 key」）：
 *                                                        伺服器自己抓那一頁（代理只能給網址、不能餵假文本），每欄一題判定，
 *                                                        記 jev_decisions(question=second_source) 並回每欄結果。不是系統票。
 *                                                        公開、按來源 IP 配額：每 IP 每 10 分鐘 60 次、全域 300 次。
 *
 * 系統來源票（2026-09-19 使用者裁決，4 票變 3+1）：Jev 核「提交者附的那個來源」，supported ≥門檻讓代理門檻 −1
 * （最少仍要 1 張代理票）、not_supported 算一張反對、其餘棄權。計票在 SQL 的 contribution_apply_consensus。
 *
 * 三件這支端點自己守住的事：
 *   1. 只新增不更新。撞到 unique(subject_type, subject_id, question, model, state_hash) 就算 skipped——
 *      同 state 同模型不能重骰；state 變了才會多一列，舊的留著當歷史。
 *   2. model 必須是帶日期的完整版本，不收 alias。
 *   3. state 不能是空的。
 */

import { cecCandidacyPage } from "../_shared/cec-check.ts";
import { buildFollowupAsk, FOLLOWUP_MIN_PROBABILITY, followupTask, SUBMISSION_FOLLOWUP_QUESTION, submissionFollowupTask, submissionText, worthAsking, worthAskingSubmission, type FollowupChoice, type FollowupContribution, type FollowupVote, type SubmissionForFollowup } from "../_shared/vote-followup.ts";
import { createTask, findOpenTaskForTarget } from "../_shared/task-admin.ts";
import { SECOND_SOURCE_TYPES } from "../_shared/task-context.ts";
import { CEC_ROSTER_URL_RE, cecRosterText, checkBatch, parseRoster, ROSTER_BATCH_MODEL, type RosterRow } from "../_shared/cec-roster.ts";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_RECORDS = 500;
/**
 * 每次最多問幾筆，以及成本上限的時間窗。上限是防外人狂打不帶金鑰的端點，不是預算：
 * 最壞情況 = MAX × (1440 / WINDOW) 筆／天 × 每筆約 $0.0002。2026-09-19 使用者：「n 也太小了吧」——
 * 原本 50／10 分鐘，precheck 一輪 20 筆，積壓 1,400 多筆要清一整天；改成 300／10 分鐘，最壞每天約 $9，可接受。
 */
const BACKFILL_MAX = 300;
const BACKFILL_WINDOW_MINUTES = 10;
const CONFLICT = "subject_type,subject_id,question,model,state_hash";

// deno-lint-ignore no-explicit-any
type Sb = any;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function bearerOf(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}

/** 只新增。回 inserted／skipped */
async function insertRecords(supabase: Sb, rows: DecisionRecord[]): Promise<{ inserted: number; skipped: number }> {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };
  const { data, error } = await supabase.from("jev_decisions")
    .upsert(rows, { onConflict: CONFLICT, ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(`jev_decisions insert: ${error.message}`);
  const inserted = (data ?? []).length;
  return { inserted, skipped: rows.length - inserted };
}

/** 組一筆政見的 state 並問 Jev。回傳寫入結果與答案；找不到政見回 null */
async function askPolicy(supabase: Sb, apiKey: string, policyId: string) {
  const { data: target, error: tErr } = await supabase.from("policies")
    .select("id, politician_id, title, description, election_id").eq("id", policyId).is("removed_at", null).maybeSingle();
  if (tErr) throw new Error(`policies read: ${tErr.message}`);
  if (!target) return null;
  // query-bounds: ok — 同一個人的政見，目前最多 26 筆，而且一個人不會有上千條政見
  const [{ data: sibs, error: sErr }, { data: els, error: eErr }] = await Promise.all([
    supabase.from("policies").select("id, title, description, election_id").eq("politician_id", target.politician_id).is("removed_at", null),
    supabase.from("politician_elections").select("election_id, election_type, candidate_status, election_result").eq("politician_id", target.politician_id),
  ]);
  if (sErr) throw new Error(`policies siblings: ${sErr.message}`);
  if (eErr) throw new Error(`politician_elections: ${eErr.message}`);
  const { state, questions } = buildPolicyAsk(target as PolicyLite, (sibs ?? []) as PolicyLite[], (els ?? []) as ElectionLite[]);
  const res = await askJev(apiKey, state, questions);
  const rows = toRecords("policy", target.id, state, res);
  const wrote = await insertRecords(supabase, rows);
  return { model: res.model, answers: res.answers, cost_usd: res.usage.cost, ...wrote };
}

/** 提交說明的範圍外問題：記錄判定，≥門檻且同一目標沒有 open 任務就開（跟投票備註同一套） */
async function settleSubmissionFollowup(
  supabase: Sb, c: SubmissionForFollowup, ans: { choice?: string; probabilities?: Record<string, number>; confidence?: number | null } | undefined, model: string,
) {
  const choice = (ans?.choice ?? "none") as FollowupChoice;
  const prob = ans?.probabilities?.[choice] ?? 0;
  await insertRecords(supabase, [{ subject_type: "contribution", subject_id: c.id, question: "followup", choice, probability: prob, confidence: ans?.confidence ?? null,
    probabilities: ans?.probabilities ?? null, model, state: { submission_text: submissionText(c) }, cost_usd: 0 }]);
  if (choice === "none" || prob < FOLLOWUP_MIN_PROBABILITY) return;
  const p = c.payload ?? {};
  const pid = (c.applied_politician_id ?? (typeof p.politician_id === "string" ? p.politician_id : null)) as string | null;
  const { data: who } = pid ? await supabase.from("politicians").select("name").eq("id", pid).maybeSingle() : { data: null };
  const task = submissionFollowupTask(c, choice as Exclude<FollowupChoice, "none">, (who as { name?: string } | null)?.name ?? null);
  const existing = await findOpenTaskForTarget(supabase, { politician_id: task.target_politician_id ?? (task.target_extra?.politician_id as string | undefined) ?? null, policy_id: task.target_policy_id ?? null, task_type: "other" });
  if (existing) return;
  await createTask(supabase, task, { source: "suggested", suggested_by: c.agent_name ?? "unknown", created_by: "jev-followup" });
}

type VoteBudgetRow = { id: string; contribution_type: string; payload: Record<string, unknown> | null; source_urls: string[] | null };

/**
 * 票數預算（影子模式）：對一筆貢獻逐維問 Jev、算出它「應該」要幾票，寫進 jev_decisions（question=vote_budget）。
 * 只記錄、不套用門檻。單筆端點（vote_budget）與排程掃描（vote_budget_sweep）共用。
 */
async function voteBudgetFor(supabase: Sb, apiKey: string, c: VoteBudgetRow, requester: string | null) {
  const payload = (c.payload ?? {}) as Record<string, unknown>;
  const claim = claimOf(c.contribution_type, payload);

  // 來源正文：抓第一個抓得到的。抓不到就讓每一維自己判不出來（＝往嚴格的方向算）
  let page: { url: string; text: string; note: string } | null = null;
  for (const u of (c.source_urls ?? []).slice(0, 2)) {
    const got = await fetchSource(u);
    if (got.kind === "html" && got.text) { page = { url: u, text: got.text.slice(0, 12000), note: got.note ?? "" }; break; }
  }

  // 中選會折扣：參選類才問得到（cec-check 拿的是結構化資料，不是網頁）
  const { confirmed: cecConfirmed, note: cecNote } = await cecConfirmedFor(c.contribution_type, payload, claim);

  const state: Record<string, unknown> = {
    target: claim,
    contribution_type: c.contribution_type,
    // note 要留著（2026-09-21）：裡面是 raw|archive|text 三個長度——candlefish 驗 archive 回退時發現 judge 存的是縮減版、
    // 看不出回退有沒有出手；每一層都只回報自己看到的，這三個數字就是在補「沒看到什麼」。
    page: page ? { url: page.url, text: page.text, note: page.note } : { url: null, text: "", note: "抓不到正文" },
  };
  // 提交說明裡的範圍外問題：同一次呼叫多問一題（2026-09-26），不另外花一次 Jev
  // query-bounds: ok — 按 id 取一列
  const { data: meta } = await supabase.from("contributions").select("note, agent_name, created_at, applied_politician_id, applied_policy_id").eq("id", c.id).maybeSingle();
  const sub: SubmissionForFollowup = { id: c.id, contribution_type: c.contribution_type, payload: payload, ...((meta ?? {}) as Record<string, unknown>) };
  const askFollowup = worthAskingSubmission(sub);
  if (askFollowup) state.submission_text = submissionText(sub);
  const res = await askJev(apiKey, state, { ...dimensionQuestions(c.contribution_type), ...(askFollowup ? { followup: SUBMISSION_FOLLOWUP_QUESTION } : {}) });
  const budget = computeVoteBudget(c.contribution_type, res.answers, cecConfirmed);

  await insertRecords(supabase, [{
    subject_type: "contribution", subject_id: c.id, question: "vote_budget",
    choice: String(budget.threshold), probability: 0, confidence: null,
    probabilities: Object.fromEntries(budget.dimensions.map((d) => [d.key, d.probability])),
    model: res.model, state: { ...state, budget }, cost_usd: Number(res.usage.cost.toFixed(8)), requester_ip_hash: requester,
  }]);
  if (askFollowup) {
    try { await settleSubmissionFollowup(supabase, sub, res.answers.followup, res.model); } catch (e) { console.error("submission followup:", e instanceof Error ? e.message : String(e)); }
  }
  return { budget, cecConfirmed, cecNote, page, cost: Number(res.usage.cost.toFixed(8)) };
}

/**
 * 參選類的中選會折扣（票數預算用）：candidacy／correction 帶姓名與屆別時查得到就算確認。
 * precheck 已經為 candidacy 查過中選會的，直接帶進來不重查。
 */
async function cecConfirmedFor(contributionType: string, payload: Record<string, unknown>, claim: Record<string, unknown>, known?: { count: number } | null): Promise<{ confirmed: boolean; note: string }> {
  if (contributionType !== "candidacy" && contributionType !== "correction") return { confirmed: false, note: "非參選類，不查中選會" };
  if (known !== undefined) return known && known.count > 0 ? { confirmed: true, note: `中選會查到 ${known.count} 筆` } : { confirmed: false, note: "中選會查不到" };
  const name = [payload.name, claim.name, payload.subject_name].find((x) => typeof x === "string") as string | undefined;
  const eid = Number(payload.election_id ?? claim.election_id);
  if (!name || !Number.isInteger(eid)) return { confirmed: false, note: "缺姓名或屆別，查不了" };
  const hit = await cecCandidacyPage(name, eid);
  return hit && hit.count > 0 ? { confirmed: true, note: `中選會查到 ${hit.count} 筆` } : { confirmed: false, note: "中選會查不到" };
}

/**
 * 投票備註的範圍外問題（followup）：記錄 Jev 的判定，≥門檻就開任務。
 * 新票稽核（evidence）與備註掃描（followups）共用——同一張票只問 Jev 一次。
 */
async function settleFollowup(
  supabase: Sb, v: FollowupVote, c: FollowupContribution,
  ans: { choice: string; probabilities?: Record<string, number>; confidence?: number } | undefined,
  model: string, state: Record<string, unknown>, costUsd: number, dry: boolean,
): Promise<Record<string, unknown> | null> {
  const choice = (ans?.choice ?? "none") as FollowupChoice;
  const prob = ans?.probabilities?.[choice] ?? 0;
  if (!dry) {
    await insertRecords(supabase, [{ subject_type: "vote", subject_id: v.id, question: "followup", choice, probability: prob, confidence: ans?.confidence ?? null,
      probabilities: ans?.probabilities ?? null, model, state, cost_usd: costUsd }]);
  }
  if (choice === "none" || prob < FOLLOWUP_MIN_PROBABILITY) return null;
  const p = c.payload ?? {};
  const pid = (c.applied_politician_id ?? (typeof p.politician_id === "string" ? p.politician_id : null)) as string | null;
  const { data: who } = pid ? await supabase.from("politicians").select("name").eq("id", pid).maybeSingle() : { data: null };
  const task = followupTask(v, c, choice as Exclude<FollowupChoice, "none">, (who as { name?: string } | null)?.name ?? null);
  const entry: Record<string, unknown> = { vote_id: v.id, contribution_id: c.id, choice, probability: Number(prob.toFixed(2)), title: task.title, note: String(v.note).slice(0, 300) };
  if (!dry) {
    const existing = await findOpenTaskForTarget(supabase, { politician_id: task.target_politician_id ?? (task.target_extra?.politician_id as string | undefined) ?? null, policy_id: task.target_policy_id ?? null, task_type: "other" });
    if (existing) entry.skipped = `已有 open 任務 ${existing.id}`;
    else {
      const t = await createTask(supabase, task, { source: "suggested", suggested_by: v.agent_name ?? "unknown", created_by: "jev-followup" });
      entry.task_id = t.id;
    }
  }
  return entry;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "只收 POST" }, 405);

  try {
    const url = new URL(req.url);
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(url.searchParams.get("action") ?? body.action ?? "record");

    // ---- ask：落庫後的觸發叫這個。只收 service role，因為會花錢 ----
    if (action === "ask") {
      if (bearerOf(req) !== serviceKey) return json({ success: false, error: "ask 只收 service role" }, 401);
      const apiKey = Deno.env.get("OPENROUTER_API_KEY");
      if (!apiKey) return json({ success: false, error: "OPENROUTER_API_KEY is not configured" }, 500);
      if (body.subject_type !== "policy" || typeof body.subject_id !== "string") {
        return json({ success: false, error: "目前只支援 subject_type=policy，subject_id 必填" }, 400);
      }
      const out = await askPolicy(supabase, apiKey, body.subject_id);
      if (!out) return json({ success: false, error: "找不到該政見（或已移除）" }, 404);
      return json({ success: true, ...out });
    }

    // ---- backfill：排程叫這個。不帶金鑰，靠成本上限 ----
    if (action === "backfill") {
      const apiKey = Deno.env.get("OPENROUTER_API_KEY");
      if (!apiKey) return json({ success: false, error: "OPENROUTER_API_KEY is not configured" }, 500);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), BACKFILL_MAX);
      // 成本上限：時間窗內已經問滿就什麼都不做。這樣不管誰打、打幾次，花費上限都是固定的。
      const since = new Date(Date.now() - BACKFILL_WINDOW_MINUTES * 60 * 1000).toISOString();
      const { count, error: cErr } = await supabase.from("jev_decisions")
        .select("id", { count: "exact", head: true }).eq("subject_type", "policy").eq("question", "is_policy").gte("asked_at", since);
      if (cErr) throw new Error(`jev_decisions recent count: ${cErr.message}`);
      const budget = Math.max(0, limit - (count ?? 0));
      if (budget === 0) return json({ success: true, asked: 0, reason: `${BACKFILL_WINDOW_MINUTES} 分鐘內已問過 ${count} 筆，這輪不問` });

      const { data: cands, error: qErr } = await supabase.rpc("system_one_backfill_candidates", { p_limit: budget });
      if (qErr) throw new Error(`backfill candidates: ${qErr.message}`);
      let asked = 0, inserted = 0, cost = 0;
      const failures: Array<{ policy_id: string; error: string }> = [];
      for (const c of (cands ?? []) as Array<{ policy_id: string; reason: string }>) {
        try {
          const out = await askPolicy(supabase, apiKey, c.policy_id);
          if (!out) continue;
          asked++; inserted += out.inserted; cost += out.cost_usd;
        } catch (e) {
          failures.push({ policy_id: c.policy_id, error: e instanceof Error ? e.message : String(e) });
          // OpenRouter 掛了就整輪停，不要 20 筆各撞一次
          if (failures.length >= 3) break;
        }
      }
      return json({ success: true, asked, inserted, cost_usd: Number(cost.toFixed(6)), candidates: (cands ?? []).length, failures, min_probability: MIN_PROBABILITY });
    }

    // ---- precheck：系統來源票。排程叫這個。不帶金鑰，靠成本上限 ----
    if (action === "precheck") {
      const apiKey = Deno.env.get("OPENROUTER_API_KEY");
      if (!apiKey) return json({ success: false, error: "OPENROUTER_API_KEY is not configured" }, 500);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), BACKFILL_MAX);
      const since = new Date(Date.now() - BACKFILL_WINDOW_MINUTES * 60 * 1000).toISOString();
      const { count, error: cErr } = await supabase.from("jev_decisions")
        .select("id", { count: "exact", head: true }).eq("subject_type", "contribution").eq("question", "source_support").gte("asked_at", since);
      if (cErr) throw new Error(`jev_decisions recent count: ${cErr.message}`);
      const budget = Math.max(0, limit - (count ?? 0));
      if (budget === 0) return json({ success: true, asked: 0, reason: `${BACKFILL_WINDOW_MINUTES} 分鐘內已判過 ${count} 筆，這輪不判` });

      const { data: cands, error: qErr } = await supabase.rpc("system_one_precheck_candidates", { p_limit: budget });
      if (qErr) throw new Error(`precheck candidates: ${qErr.message}`);
      let asked = 0, cost = 0;
      const tally: Record<string, number> = {};
      const failures: Array<{ contribution_id: string; error: string }> = [];
      type Cand = { contribution_id: string; contribution_type: string; payload: Record<string, unknown>; source_urls: string[] };
      const list = (cands ?? []) as Cand[];
      // 一輪可能有 200 筆，序列抓網頁會撞到 edge function 的執行上限：改成一次 5 筆並行，
      // 並給 50 秒時間預算，到了就收工回報——沒做完的下一輪 cron 會再撿（候選查詢是冪等的）
      const startedAt = Date.now();
      // 2026-09-19 手動打 limit=100 撞到 WORKER_RESOURCE_LIMIT（546）：每筆最多抓三個來源＋PDF 抽字，
      // 5 筆並行等於同時 15 個抓取加 pdf.js，edge runtime 的記憶體撐不住。降到 2 筆並行、40 秒預算，
      // 一輪做不完由下一輪 cron 接（候選查詢冪等）；cron 的 limit 也從 200 降到 60。
      const BUDGET_MS = 40_000;
      const CONCURRENCY = 2;
      /** merge_politician：來源是那兩筆資料本身。問 Jev 同一人（配對已判過就直接用），映成這筆貢獻的 source_support */
      const onePair = async (c: Cand): Promise<void> => {
        const keep = String(c.payload.keep_id ?? ""), remove = String(c.payload.remove_id ?? "");
        const pairKey = [keep, remove].sort().join("|");
        const { data: prior } = await supabase.from("jev_decisions").select("choice, probability, model, state")
          .eq("subject_type", "politician_pair").eq("subject_id", pairKey).eq("question", "same_person").gte("asked_at", new Date(Date.now() - 30 * 86400_000).toISOString())
          .order("asked_at", { ascending: false }).limit(1).maybeSingle();
        let choice: string, probability: number, model: string, state: Record<string, unknown>;
        if (prior) {
          choice = String(prior.choice); probability = Number(prior.probability); model = String(prior.model); state = (prior.state ?? {}) as Record<string, unknown>;
        } else {
          const [pa, pb, ea, eb] = await Promise.all([
            supabase.from("politicians").select("id, name, party, region, birth_year, current_position").eq("id", keep).maybeSingle(),
            supabase.from("politicians").select("id, name, party, region, birth_year, current_position").eq("id", remove).maybeSingle(),
            supabase.from("politician_elections").select("election_id, election_type, candidate_status").eq("politician_id", keep).limit(20),
            supabase.from("politician_elections").select("election_id, election_type, candidate_status").eq("politician_id", remove).limit(20),
          ]);
          if (!pa.data || !pb.data) { tally["fetch:noperson"] = (tally["fetch:noperson"] ?? 0) + 1; return; }
          const el = (rows: unknown[] | null) => (rows ?? []).map((e) => { const r = e as Record<string, unknown>; return `${r.election_id} ${r.election_type ?? ""} ${r.candidate_status ?? ""}`; });
          const { state: st, questions } = buildPairAsk({ ...(pa.data as Record<string, unknown>), elections: el(ea.data) } as never, { ...(pb.data as Record<string, unknown>), elections: el(eb.data) } as never);
          const res = await askJev(apiKey, st, questions);
          cost += res.usage.cost; asked++;
          const ans = res.answers.same_person;
          choice = ans.choice; probability = Number((ans.probabilities?.[ans.choice] ?? 0).toFixed(4)); model = res.model; state = st;
          await insertRecords(supabase, [{ subject_type: "politician_pair", subject_id: pairKey, question: "same_person", choice, probability, confidence: null, probabilities: ans.probabilities ?? null, model, state, cost_usd: Number(res.usage.cost.toFixed(8)) }]);
        }
        // 配對判定 → 這筆貢獻的系統票：代理說同一人而 Jev 說 same → supported；相反 → not_supported；unclear → cannot_tell
        const agentSays = c.payload.same_person === false ? "diff" : "same";
        const mapped = choice === "unclear" ? "cannot_tell" : choice === agentSays ? "supported" : "not_supported";
        await insertRecords(supabase, [{
          subject_type: "contribution", subject_id: c.contribution_id, question: "source_support",
          choice: mapped, probability, confidence: null, probabilities: { same_person: { verdict: choice, p: probability } } as unknown as Record<string, number>,
          model, state: { claim: { keep_id: keep, remove_id: remove, same_person: agentSays === "same" }, pair: state }, cost_usd: 0,
        }]);
        const key = `${mapped}${probability >= MIN_PROBABILITY ? "≥" : "<"}門檻`;
        tally[key] = (tally[key] ?? 0) + 1;
      };
      const one = async (c: Cand): Promise<void> => {
        if (c.contribution_type === "merge_politician") return await onePair(c);
        const payload = { ...(c.payload ?? {}) };
        // payload 沒帶名字（correction／candidacy／policy_progress）就回查，不分型別（2026-09-22，見 subjectRef）
        const subjects = await subjectNamesOf(supabase, payload);
        if (subjects[0]) payload.subject_name = subjects[0];
        const claim = claimOf(c.contribution_type, payload);
        const names = [payload.name, payload.politician_name, payload.title, ...subjects].map((v) => typeof v === "string" ? v : null);
        // 參選紀錄先問中選會的結構化資料（2026-09-20：系統不解析 PDF／Excel）；查不到（2026 登記期）才看提交者附的網頁
        const cec = c.contribution_type === "candidacy" && typeof payload.name === "string" && typeof payload.election_id === "number"
          ? await cecCandidacyPage(payload.name, payload.election_id)
          : null;
        const urls = cec ? [cec.url] : c.source_urls.slice(0, 3);
        const fetched = cec
          ? [{ url: cec.url, kind: "html" as const, text: cec.text, note: `cec-api（${cec.count} 筆）` }]
          : await Promise.all(c.source_urls.slice(0, 3).map(async (u) => ({ url: u, ...(await fetchSource(u)) })));
        const usable = fetched.filter((p) => p.kind === "html" && hasUsableText(p.text, names));
        const combined = combineSources(usable, names);
        const srcUrl = urls[0];
        let rows: DecisionRecord[];
        let key: string;
        // 主角名字不在文本裡（索引頁、附件沒接進來）→ 棄權，不問 Jev：它只會在別人的資料上判「矛盾」（2026-09-19 卡伊．馬賴）
        const noName = !!combined && !nameHit(combined, names);
        if (!combined || !hasUsableText(combined, names) || noName) {
          // 全部抓不到正文就棄權（cannot_tell、機率 0），但一樣留紀錄：候選查詢靠這列知道「判過了」，
          // 而且對帳時分得出「來源抓不到」跟「Jev 看不出來」是兩回事
          const notes = (noName ? "主角名字不在文本裡 | " : "") + fetched.map((p) => `${p.kind}:${p.note}`).join(" | ");
          rows = [{
            subject_type: "contribution", subject_id: c.contribution_id, question: "source_support",
            choice: "cannot_tell", probability: 0, confidence: null, probabilities: null,
            model: "policy-tw/fetch-only-00000000", state: { claim, page: { url: srcUrl, urls, text: "", fetch: fetched[0]?.kind ?? "error", note: notes } }, cost_usd: 0,
          }];
          key = noName ? "fetch:noname" : `fetch:${fetched[0]?.kind ?? "error"}`;
        } else {
          const { state, questions } = buildSourceSupportAsk(claim, srcUrl, combined);
          (state.page as Record<string, unknown>).urls = urls;
          // 票數預算的風險題跟來源核對一起問（2026-09-23 小良哥：「可以集中一次問嗎」）：同一份正文、同一次呼叫。
          // 題名不衝突（來源題是 field:*、預算題是維度名）；維度題的 instructions 讀的是 state.target。
          const budgetQs = dimensionQuestions(c.contribution_type);
          const withBudget = Object.keys(budgetQs).length > 0;
          const askState = withBudget ? { ...state, target: claim, contribution_type: c.contribution_type } : state;
          const res = await askJev(apiKey, askState, { ...questions, ...budgetQs });
          cost += res.usage.cost;
          // 每欄一題，收斂成一票；欄位細節放 probabilities 給 /next 與對帳看
          const agg = aggregateFieldVerdicts(c.contribution_type, claim, res.answers);
          rows = [{
            subject_type: "contribution", subject_id: c.contribution_id, question: "source_support",
            choice: agg.choice, probability: agg.probability, confidence: null,
            probabilities: agg.fields as unknown as Record<string, number>, model: res.model, state: askState, cost_usd: Number(res.usage.cost.toFixed(8)),
          }];
          if (withBudget) {
            const cecInfo = await cecConfirmedFor(c.contribution_type, payload, claim, c.contribution_type === "candidacy" ? cec : undefined);
            const budget = computeVoteBudget(c.contribution_type, res.answers, cecInfo.confirmed);
            // 影子模式照舊：只記錄。費用已記在 source_support 那列，這列記 0 免得重算
            rows.push({
              subject_type: "contribution", subject_id: c.contribution_id, question: "vote_budget",
              choice: String(budget.threshold), probability: 0, confidence: null,
              probabilities: Object.fromEntries(budget.dimensions.map((d) => [d.key, d.probability])),
              model: res.model, state: { target: claim, contribution_type: c.contribution_type, page: state.page, budget, asked_with: "precheck" }, cost_usd: 0,
            });
          }
          key = `${agg.choice}${agg.probability >= MIN_PROBABILITY ? "≥" : "<"}門檻`;
        }
        await insertRecords(supabase, rows);
        // 有票就重算共識：supported 可能讓門檻剛好達標、not_supported 可能直接進裁決
        const { error: aErr } = await supabase.rpc("contribution_apply_consensus", { p_contribution_id: c.contribution_id });
        if (aErr) throw new Error(`apply_consensus: ${aErr.message}`);
        tally[key] = (tally[key] ?? 0) + 1;
        asked++;
      };
      let cursor = 0;
      let outOfTime = false;
      while (cursor < list.length && !outOfTime) {
        if (Date.now() - startedAt > BUDGET_MS) { outOfTime = true; break; }
        const chunk = list.slice(cursor, cursor + CONCURRENCY);
        cursor += chunk.length;
        const results = await Promise.allSettled(chunk.map(one));
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.status === "rejected") failures.push({ contribution_id: chunk[i].contribution_id, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
        }
        // OpenRouter 掛了就整輪停，不要 200 筆各撞一次
        if (failures.length >= 5) break;
      }
      return json({ success: true, asked, cost_usd: Number(cost.toFixed(6)), candidates: list.length, remaining: list.length - cursor, out_of_time: outOfTime, elapsed_ms: Date.now() - startedAt, tally, failures, min_probability: MIN_PROBABILITY });
    }

    // ---- legacy：早期匯入、有來源、沒查核履歷的政見，系統先核（排程）----
    if (action === "legacy") {
      const apiKey = Deno.env.get("OPENROUTER_API_KEY");
      if (!apiKey) return json({ success: false, error: "OPENROUTER_API_KEY is not configured" }, 500);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 60);
      // 候選：legacy_audit 任務會派的那些，扣掉已經判過的
      const { data: tasks, error: tErr } = await supabase.rpc("contribution_auto_tasks_legacy");
      if (tErr) throw new Error(`legacy tasks: ${tErr.message}`);
      type LT = { task_id: string; target: { policy_id: string; policy_title: string; name: string; source_url: string } };
      const all = (tasks ?? []) as LT[];
      const ids = all.map((t) => t.target.policy_id);
      const { data: done } = ids.length > 0
        ? await supabase.from("jev_decisions").select("subject_id").eq("subject_type", "policy").eq("question", "source_support").in("subject_id", ids.slice(0, 1000))
        : { data: [] };
      const doneSet = new Set(((done ?? []) as Array<{ subject_id: string }>).map((d) => d.subject_id));
      const list = all.filter((t) => !doneSet.has(t.target.policy_id)).slice(0, limit);
      let asked = 0, cost = 0;
      const tally: Record<string, number> = {};
      const failures: Array<{ policy_id: string; error: string }> = [];
      const startedAt = Date.now();
      const one = async (t: LT): Promise<void> => {
        const { data: pl } = await supabase.from("policies").select("id, title, description, election_id, category, politician_id").eq("id", t.target.policy_id).maybeSingle();
        if (!pl) return;
        const claim = claimOf("policy", { name: t.target.name, politician_name: t.target.name, title: pl.title, description: String(pl.description ?? "").slice(0, 300), ...(pl.election_id ? { election_id: pl.election_id } : {}), ...(pl.category ? { category: pl.category } : {}) });
        const names = [t.target.name, String(pl.title)];
        const page = await fetchSource(t.target.source_url);
        let row: DecisionRecord; let key: string;
        if (page.kind !== "html" || !hasUsableText(page.text, names) || !nameHit(page.text, names)) {
          row = { subject_type: "policy", subject_id: pl.id, question: "source_support", choice: "cannot_tell", probability: 0, confidence: null, probabilities: null,
            model: "policy-tw/fetch-only-00000000", state: { claim, page: { url: t.target.source_url, text: "", fetch: page.kind, note: page.note } }, cost_usd: 0 };
          key = `fetch:${page.kind}`;
        } else {
          const { state, questions } = buildSourceSupportAsk(claim, t.target.source_url, focusText(page.text, names));
          const res = await askJev(apiKey, state, questions);
          cost += res.usage.cost;
          const agg = aggregateFieldVerdicts("policy", claim, res.answers);
          row = { subject_type: "policy", subject_id: pl.id, question: "source_support", choice: agg.choice, probability: agg.probability, confidence: null,
            probabilities: agg.fields as unknown as Record<string, number>, model: res.model, state, cost_usd: Number(res.usage.cost.toFixed(8)) };
          key = `${agg.choice}${agg.probability >= MIN_PROBABILITY ? "≥" : "<"}門檻`;
        }
        await insertRecords(supabase, [row]);
        tally[key] = (tally[key] ?? 0) + 1; asked++;
      };
      let cursor = 0;
      while (cursor < list.length && Date.now() - startedAt < 40_000) {
        const chunk = list.slice(cursor, cursor + 2); cursor += chunk.length;
        const results = await Promise.allSettled(chunk.map(one));
        results.forEach((r, i) => { if (r.status === "rejected") failures.push({ policy_id: chunk[i].target.policy_id, error: r.reason instanceof Error ? r.reason.message : String(r.reason) }); });
        if (failures.length >= 5) break;
      }
      return json({ success: true, asked, cost_usd: Number(cost.toFixed(6)), candidates: list.length, backlog: all.length - doneSet.size, remaining: list.length - cursor, tally, failures });
    }

    // ---- judge：代理的第二來源判定。公開，按來源 IP 配額 ----
    // 票數預算（影子模式，2026-09-21）：Jev 對每一個風險維度各給一個機率，
    // 超過閾值的維度各加一票。**只記錄、不套用門檻**——0～5 的加成沒有校準資料，
    // 先看真實分布再決定要不要接上去。設計與理由見 docs/PROPOSAL-jev-vote-budget.md。
    if (action === "vote_budget") {
      const apiKey = Deno.env.get("OPENROUTER_API_KEY");
      if (!apiKey) return json({ success: false, error: "OPENROUTER_API_KEY is not configured" }, 500);
      const contributionId = typeof body.contribution_id === "string" ? body.contribution_id.trim() : "";
      if (!/^[0-9a-f-]{36}$/i.test(contributionId)) return json({ success: false, error: "contribution_id 必填（uuid）" }, 400);
      const requester = await ipHashOf(req, Deno.env.get("CONTRIBUTION_IP_SALT") || supabaseUrl);

      const { data: c, error: cErr } = await supabase.from("contributions")
        .select("id, contribution_type, payload, source_urls, status, agent_name").eq("id", contributionId).maybeSingle();
      if (cErr) throw new Error(`contributions read: ${cErr.message}`);
      if (!c) return json({ success: false, error: "not_found", message: "找不到這筆貢獻" }, 404);

      if ((VOTE_DIMENSIONS[c.contribution_type] ?? []).length === 0) {
        return json({ success: false, error: "no_dimensions", message: `${c.contribution_type} 還沒有定義風險維度（_shared/vote-budget.ts）` }, 400);
      }
      const r = await voteBudgetFor(supabase, apiKey, c as VoteBudgetRow, requester);

      return json({
        success: true,
        shadow_mode: true,
        note: "只記錄不套用：現行門檻仍由 contribution_effective_agree 決定",
        contribution_id: c.id,
        current_threshold_note: "要跟現行門檻對照請看 contribution-status 的 required_agree",
        cec: { confirmed: r.cecConfirmed, note: r.cecNote },
        source: r.page ? { url: r.page.url, chars: r.page.text.length } : { url: null, chars: 0, note: "抓不到正文，每一維都會落到「判不出來」" },
        budget: r.budget,
        cost_usd: r.cost,
      });
    }

    // ---- vote_budget_sweep：影子模式排進排程（小良哥 2026-09-23）----
    // 09-21 上線後只有 2 筆手動測試，「先看真實分布再決定」一直沒有分布可看。這裡每 10 分鐘撿 pending 且還沒算過
    // 票數預算的貢獻各問一次，只記錄不套用；累積到幾百筆再對照它們後來的結果（applied／rejected）決定閾值與要不要接上。
    if (action === "vote_budget_sweep") {
      const apiKey = Deno.env.get("OPENROUTER_API_KEY");
      if (!apiKey) return json({ success: false, error: "OPENROUTER_API_KEY is not configured" }, 500);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 60);
      const since = new Date(Date.now() - BACKFILL_WINDOW_MINUTES * 60 * 1000).toISOString();
      const { count, error: cErr } = await supabase.from("jev_decisions")
        .select("id", { count: "exact", head: true }).eq("subject_type", "contribution").eq("question", "vote_budget").gte("asked_at", since);
      if (cErr) throw new Error(`jev_decisions recent count: ${cErr.message}`);
      const budgetN = Math.max(0, limit - (count ?? 0));
      if (budgetN === 0) return json({ success: true, asked: 0, reason: `${BACKFILL_WINDOW_MINUTES} 分鐘內已算過 ${count} 筆，這輪不算` });

      const { data: cands, error: qErr } = await supabase.rpc("system_one_vote_budget_candidates", { p_limit: budgetN });
      if (qErr) throw new Error(`vote_budget candidates: ${qErr.message}`);
      const list = (cands ?? []) as VoteBudgetRow[];
      const startedAt = Date.now();
      const BUDGET_MS = 40_000;
      // 2026-09-23 小良哥：「十分鐘內有提交的都稽查」。三天內最多一個十分鐘 36 筆，併發 2 在 40 秒內做不完
      const CONCURRENCY = 6;
      let asked = 0, cost = 0;
      const tally: Record<string, number> = {};
      const failures: Array<{ contribution_id: string; error: string }> = [];
      let cursor = 0;
      while (cursor < list.length && Date.now() - startedAt < BUDGET_MS) {
        const chunk = list.slice(cursor, cursor + CONCURRENCY); cursor += chunk.length;
        const results = await Promise.allSettled(chunk.map((c) => voteBudgetFor(supabase, apiKey, c, null)));
        results.forEach((r, i) => {
          if (r.status === "rejected") { failures.push({ contribution_id: chunk[i].id, error: r.reason instanceof Error ? r.reason.message : String(r.reason) }); return; }
          asked++; cost += r.value.cost;
          const k = `${chunk[i].contribution_type}:${r.value.budget.threshold}`;
          tally[k] = (tally[k] ?? 0) + 1;
        });
        if (failures.length >= 5) break;
      }
      return json({ success: true, shadow_mode: true, asked, cost_usd: Number(cost.toFixed(6)), candidates: list.length, remaining: list.length - cursor, tally, failures });
    }

    // ---- roster_batch：引用中選會登記名冊的待驗參選紀錄，逐位比對姓名／縣市／政黨，寫系統票（2026-09-24 小良哥選 B）----
    // 09-20「系統不解析 PDF」的例外，只限 web.cec.gov.tw 的名冊（_shared/cec-roster.ts）。不用 Jev：純比對。
    if (action === "roster_batch") {
      type Cand = { id: string; payload: Record<string, unknown>; source_urls: string[] | null };
      // 還沒核過、引用中選會名冊的待驗參選紀錄（SQL 端篩，陣列欄位的網址比對不好走 REST 篩選）
      const { data: cands, error: cErr } = await supabase.rpc("roster_batch_candidates", { p_limit: 500 });
      if (cErr) throw new Error(`roster candidates: ${cErr.message}`);
      const list = (cands ?? []) as Cand[];
      const todo = list;
      const byUrl = new Map<string, Cand[]>();
      for (const c of todo) {
        const url = (c.source_urls ?? []).find((u) => CEC_ROSTER_URL_RE.test(u));
        if (url && typeof c.payload?.name === "string") byUrl.set(url, [...(byUrl.get(url) ?? []), c]);
      }
      const report: Array<Record<string, unknown>> = [];
      // 一輪最多讀 3 份名冊（PDF 抽字吃記憶體；見 precheck 那次 WORKER_RESOURCE_LIMIT）
      for (const [url, group] of [...byUrl.entries()].slice(0, 3)) {
        let rows: RosterRow[];
        try { rows = parseRoster(await cecRosterText(url)); } catch (e) { report.push({ url, error: e instanceof Error ? e.message : String(e) }); continue; }
        // 解析出的人比要核對的還少，多半是這份名冊的版面沒認出來：整份跳過、不判，免得把對的判成「不支持」（09-24 嘉義縣名冊誤判 5 筆）
        if (rows.length < Math.max(10, group.length)) { report.push({ url, skipped: `名冊只解析出 ${rows.length} 位，少於要核對的 ${group.length} 筆，這份先不判` }); continue; }
        const check = checkBatch(rows, group.map((c) => ({ id: c.id, name: String(c.payload.name), party: typeof c.payload.party === "string" ? c.payload.party : null, region: typeof c.payload.region === "string" ? c.payload.region : null })));
        // 超過一半「找不到姓名」多半是版面沒認出來（09-24 宜蘭縣名冊 34 筆全誤判）：整份不判，交給人逐筆驗
        const notFound = check.failed.filter((f) => f.reason.includes("找不到")).length;
        if (notFound * 2 > group.length) { report.push({ url, rows_parsed: rows.length, skipped: `${notFound}／${group.length} 筆找不到姓名，疑似名冊版面沒認出來，這份先不判` }); continue; }
        const failedBy = new Map(check.failed.map((f) => [f.id, f.reason]));
        const records = group.map((c) => {
          const ok = check.passed.includes(c.id);
          return {
            subject_type: "contribution", subject_id: c.id, question: "source_support",
            choice: ok ? "supported" : "not_supported", probability: 1, confidence: null, probabilities: null,
            model: ROSTER_BATCH_MODEL,
            state: { pdf_url: url, name: c.payload.name, region: c.payload.region, party: c.payload.party, rows_parsed: rows.length, ...(ok ? { result: "名冊上姓名、縣市、政黨都對得上" } : { reason: failedBy.get(c.id) }) },
            cost_usd: 0,
          };
        });
        await insertRecords(supabase, records as DecisionRecord[]);
        for (const c of group) {
          const { error } = await supabase.rpc("contribution_apply_consensus", { p_contribution_id: c.id });
          if (error) throw new Error(`apply_consensus: ${error.message}`);
        }
        report.push({ url, rows_parsed: rows.length, checked: group.length, passed: check.passed.length, failed: check.failed.length });
      }
      return json({ success: true, candidates: list.length, report });
    }

    // ---- costs：AI 判定帳戶的儲值與已用，存給捐款頁（2026-09-24）。排程每 15 分鐘；不回任何金鑰相關內容 ----
    if (action === "costs") {
      const apiKey = Deno.env.get("OPENROUTER_API_KEY");
      if (!apiKey) return json({ success: false, error: "OPENROUTER_API_KEY is not configured" }, 500);
      const res = await fetch("https://openrouter.ai/api/v1/credits", { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return json({ success: false, error: `openrouter credits ${res.status}` }, 502);
      const body = await res.json().catch(() => null) as { data?: { total_credits?: number; total_usage?: number } } | null;
      const credits = Number(body?.data?.total_credits), usage = Number(body?.data?.total_usage);
      if (!Number.isFinite(credits) || !Number.isFinite(usage)) return json({ success: false, error: "openrouter credits 回應格式不對" }, 502);
      const { error } = await supabase.from("platform_costs")
        .upsert({ id: 1, openrouter_credits: credits, openrouter_usage: usage, refreshed_at: new Date().toISOString() }, { onConflict: "id" });
      if (error) throw new Error(`platform_costs upsert: ${error.message}`);
      return json({ success: true, balance_usd: Number((credits - usage).toFixed(2)) });
    }

    // ---- submission_followups：補跑——已交的提交補讀一輪說明（2026-09-26 小良哥「先補跑一輪」）----
    // 新進的提交在票數預算那次呼叫就會問（#269）；這裡給之前就交了的。一筆一次 Jev、只問 followup 這一題。
    // since_hours 預設 168（7 天）、limit 預設 60（上限 200）；dry=1 只回判定、不寫紀錄不開任務。
    if (action === "submission_followups") {
      const apiKey = Deno.env.get("OPENROUTER_API_KEY");
      if (!apiKey) return json({ success: false, error: "OPENROUTER_API_KEY is not configured" }, 500);
      const dry = url.searchParams.get("dry") === "1";
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 60, 1), 200);
      const sinceHours = Math.min(Math.max(Number(url.searchParams.get("since_hours")) || 168, 1), 24 * 30);
      const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
      // query-bounds: ok — 有 order 有 limit（1000）
      const { data: rows, error: cErr } = await supabase.from("contributions")
        .select("id, contribution_type, payload, note, agent_name, created_at, applied_politician_id, applied_policy_id")
        .gte("created_at", since).order("created_at", { ascending: false }).limit(1000);
      if (cErr) throw new Error(`submission followups: ${cErr.message}`);
      const withText = ((rows ?? []) as SubmissionForFollowup[]).filter(worthAskingSubmission);
      const ids = withText.map((c) => c.id);
      // query-bounds: ok — in() 最多 1000 個 id，一個 id 最多一兩筆判定
      const { data: done } = ids.length > 0
        ? await supabase.from("jev_decisions").select("subject_id").eq("subject_type", "contribution").eq("question", "followup").in("subject_id", ids).limit(1000)
        : { data: [] };
      const doneSet = new Set(((done ?? []) as Array<{ subject_id: string }>).map((d) => d.subject_id));
      const todo = withText.filter((c) => !doneSet.has(c.id));
      const list = todo.slice(0, limit);
      const startedAt = Date.now();
      let asked = 0;
      const found: Array<Record<string, unknown>> = [];
      for (let i = 0; i < list.length && Date.now() - startedAt < 100_000; i += 5) {
        const chunk = list.slice(i, i + 5);
        const results = await Promise.allSettled(chunk.map(async (c) => {
          const state = { target: claimOf(c.contribution_type, (c.payload ?? {}) as Record<string, unknown>), contribution_type: c.contribution_type, submission_text: submissionText(c) };
          const res = await askJev(apiKey, state, { followup: SUBMISSION_FOLLOWUP_QUESTION });
          const ans = res.answers.followup;
          const choice = String(ans?.choice ?? "none");
          const prob = ans?.probabilities?.[choice] ?? 0;
          if (choice !== "none") found.push({ id: c.id, type: c.contribution_type, choice, probability: Number(prob.toFixed(2)), text: submissionText(c).slice(0, 200) });
          if (!dry) await settleSubmissionFollowup(supabase, c, ans, res.model);
        }));
        asked += results.filter((r) => r.status === "fulfilled").length;
        for (const r of results) if (r.status === "rejected") console.error("submission_followups:", r.reason);
      }
      return json({ success: true, dry, candidates: todo.length, asked, remaining: Math.max(0, todo.length - asked), flagged: found.length, opened_threshold: FOLLOWUP_MIN_PROBABILITY, found });
    }

    // ---- followups：Jev 讀投票備註，範圍外的問題開成任務（2026-09-23 小良哥）----
    // 協議叫驗證者把範圍外的缺陷另提 task_suggestion，實際上多半只寫在 note 裡、沒有下游。
    // dry=1：只回判定結果，不寫紀錄、不開任務（拿來掃一遍現況）。
    if (action === "followups") {
      const apiKey = Deno.env.get("OPENROUTER_API_KEY");
      if (!apiKey) return json({ success: false, error: "OPENROUTER_API_KEY is not configured" }, 500);
      const dry = url.searchParams.get("dry") === "1";
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 60, 1), 200);
      const sinceHours = Math.min(Math.max(Number(url.searchParams.get("since_hours")) || 1, 1), 24 * 14);
      const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
      // ids=逗號分隔的票 id：指定幾張票來測（不看時間窗）
      const onlyIds = (url.searchParams.get("ids") ?? "").split(",").map((x) => x.trim()).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 200);
      // query-bounds: ok — 下面接 .order().limit(1000)
      let vq = supabase.from("contribution_votes").select("id, contribution_id, verdict, note, agent_name, created_at").not("note", "is", null);
      vq = onlyIds.length > 0 ? vq.in("id", onlyIds) : vq.gte("created_at", since);
      // query-bounds: ok — 有 order 有 limit（1000）
      const { data: votes, error: vErr } = await vq.order("created_at", { ascending: false }).limit(1000);
      if (vErr) throw new Error(`followup votes: ${vErr.message}`);
      const withNote = ((votes ?? []) as Array<FollowupVote & { contribution_id: string }>).filter(worthAsking);
      const ids = withNote.map((v) => v.id);
      // query-bounds: ok — in() 最多 1000 個 id，一個 id 最多幾筆判定
      const { data: done } = ids.length > 0 && !dry
        ? await supabase.from("jev_decisions").select("subject_id").eq("subject_type", "vote").eq("question", "followup").in("subject_id", ids).limit(1000)
        : { data: [] };
      const doneSet = new Set(((done ?? []) as Array<{ subject_id: string }>).map((d) => d.subject_id));
      const list = withNote.filter((v) => !doneSet.has(v.id)).slice(0, limit);
      const cids = [...new Set(list.map((v) => v.contribution_id))];
      // query-bounds: ok — in() 最多 200 個 id，每個 id 一列
      const { data: cs } = cids.length > 0
        ? await supabase.from("contributions").select("id, contribution_type, payload, applied_politician_id, applied_policy_id").in("id", cids).limit(1000)
        : { data: [] };
      const byId = new Map(((cs ?? []) as FollowupContribution[]).map((c) => [c.id, c]));
      const startedAt = Date.now();
      let asked = 0, cost = 0, created = 0;
      const found: Array<Record<string, unknown>> = [];
      const seen: Array<Record<string, unknown>> = [];
      const failures: Array<{ vote_id: string; error: string }> = [];
      const one = async (v: FollowupVote & { contribution_id: string }) => {
        const c = byId.get(v.contribution_id);
        if (!c) return;
        const { state, questions } = buildFollowupAsk(v, c);
        const res = await askJev(apiKey, state, questions);
        asked++; cost += res.usage.cost;
        const ans = res.answers.followup;
        seen.push({ vote_id: v.id, choice: ans?.choice, p: Number((ans?.probabilities?.[ans?.choice ?? ""] ?? 0).toFixed(2)) });
        const entry = await settleFollowup(supabase, v, c, ans, res.model, state, Number(res.usage.cost.toFixed(8)), dry);
        if (entry) { found.push(entry); if (entry.task_id) created++; }
      };
      let cursor = 0;
      while (cursor < list.length && Date.now() - startedAt < 40_000) {
        const chunk = list.slice(cursor, cursor + 6); cursor += chunk.length;
        const results = await Promise.allSettled(chunk.map(one));
        results.forEach((r, i) => { if (r.status === "rejected") failures.push({ vote_id: chunk[i].id, error: r.reason instanceof Error ? r.reason.message : String(r.reason) }); });
        if (failures.length >= 5) break;
      }
      return json({ success: true, dry, since, scanned: withNote.length, asked, remaining: list.length - cursor, created, cost_usd: Number(cost.toFixed(6)), found, ...(url.searchParams.get("all") === "1" ? { seen } : {}), failures });
    }

    // ---- evidence：代理投票附的 evidence_url，系統自己核（2026-09-23 小良哥：代理不該把判斷外包給 Jev）----
    // +2／−2 不再由代理先打 judge 取得：票先是 ±1，這裡（cron 每 5 分鐘）抓那個網址、問 Jev 是否支持這張票的判定，
    // 核得過才把 judge_backed 翻 true → BEFORE 觸發器重算 weight → AFTER 觸發器重算共識。
    if (action === "evidence") {
      const apiKey = Deno.env.get("OPENROUTER_API_KEY");
      if (!apiKey) return json({ success: false, error: "OPENROUTER_API_KEY is not configured" }, 500);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 60);
      type Vote = { id: string; contribution_id: string; verdict: string; evidence_url: string; note: string | null; agent_name: string | null; created_at: string };
      // query-bounds: ok — 有 order 有 limit（≤60）
      const { data: votes, error: vErr } = await supabase.from("contribution_votes")
        .select("id, contribution_id, verdict, evidence_url, note, agent_name, created_at")
        .not("evidence_url", "is", null).is("evidence_checked_at", null).in("verdict", ["agree", "disagree"])
        // 新的先：正在等票的那些筆才需要 +2；上線時 1,118 張積壓多半在已定案的貢獻上，那些下面直接標 not_pending 不問 Jev
        .order("created_at", { ascending: false }).limit(limit);
      if (vErr) throw new Error(`evidence votes: ${vErr.message}`);
      const list = (votes ?? []) as Vote[];
      const startedAt = Date.now();
      const BUDGET_MS = 40_000;
      const CONCURRENCY = 2;
      let asked = 0, cost = 0;
      const tally: Record<string, number> = {};
      const failures: Array<{ vote_id: string; error: string }> = [];
      const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
      const finish = async (v: Vote, verdictOut: string, backed: boolean) => {
        const { error } = await supabase.from("contribution_votes")
          .update({ judge_backed: backed, evidence_checked_at: new Date().toISOString(), evidence_verdict: verdictOut }).eq("id", v.id);
        if (error) throw new Error(`vote update: ${error.message}`);
        tally[verdictOut] = (tally[verdictOut] ?? 0) + 1;
      };
      const one = async (v: Vote): Promise<void> => {
        const { data: c, error: cErr } = await supabase.from("contributions").select("id, contribution_type, payload, source_urls, status, applied_politician_id, applied_policy_id").eq("id", v.contribution_id).maybeSingle();
        if (cErr) throw new Error(`contribution read: ${cErr.message}`);
        if (!c) return await finish(v, "no_contribution", false);
        // 已定案（applied／rejected／superseded／withdrawn）的貢獻，票再加分也改變不了什麼，不花 Jev
        if (c.status !== "pending" && c.status !== "verified") return await finish(v, "not_pending", false);
        if (!SECOND_SOURCE_TYPES.includes(c.contribution_type)) return await finish(v, "not_eligible", false);
        // 第二來源必須是另一個網域：提交者附的那一頁系統票已經核過
        const submitted = new Set(((c.source_urls ?? []) as string[]).map(hostOf));
        if (submitted.has(hostOf(v.evidence_url))) return await finish(v, "same_source", false);
        const payload = { ...(c.payload ?? {}) } as Record<string, unknown>;
        const subjects = await subjectNamesOf(supabase, payload);
        if (subjects[0]) payload.subject_name = subjects[0];
        const claim = claimOf(c.contribution_type, payload);
        const names = [payload.name, payload.politician_name, payload.title, ...subjects].map((x) => typeof x === "string" ? x : null);
        const page = await fetchSource(v.evidence_url);
        if (page.kind !== "html" || !hasUsableText(page.text, names)) return await finish(v, "fetch_failed", false);
        if (!nameHit(page.text, names)) return await finish(v, "no_subject", false);
        const { state, questions } = buildSourceSupportAsk(claim, v.evidence_url, focusText(page.text, names));
        // 備註的範圍外問題跟第二來源一起問（2026-09-23 小良哥：「可以集中一次問嗎」）
        const fu = worthAsking(v) ? buildFollowupAsk(v, c as FollowupContribution) : null;
        const res = await askJev(apiKey, fu ? { ...state, ...fu.state } : state, fu ? { ...questions, ...fu.questions } : questions);
        cost += res.usage.cost; asked++;
        if (fu) await settleFollowup(supabase, v, c as FollowupContribution, res.answers.followup, res.model, fu.state, 0, false);
        const agg = aggregateFieldVerdicts(c.contribution_type, claim, res.answers);
        const strong = agg.probability >= MIN_PROBABILITY;
        // agree 要「支持」；disagree 要「核心欄位矛盾」（非核心欄對不上不算反證，跟 judge 的規則一樣）
        const backed = strong && (
          (v.verdict === "agree" && agg.choice === "supported") ||
          (v.verdict === "disagree" && agg.choice === "not_supported" && agg.contradicted_core)
        );
        await insertRecords(supabase, [{
          subject_type: "vote", subject_id: v.id, question: "second_source",
          choice: agg.choice, probability: agg.probability, confidence: null,
          probabilities: agg.fields as unknown as Record<string, number>, model: res.model,
          state: { ...state, page: { ...((state.page ?? { url: v.evidence_url }) as Record<string, unknown>), note: page.note }, vote: { verdict: v.verdict, contribution_id: v.contribution_id, backed } },
          cost_usd: Number(res.usage.cost.toFixed(8)),
        }]);
        await finish(v, `${agg.choice}${strong ? "" : "<門檻"}`, backed);
      };
      let cursor = 0;
      let outOfTime = false;
      while (cursor < list.length && !outOfTime) {
        if (Date.now() - startedAt > BUDGET_MS) { outOfTime = true; break; }
        const chunk = list.slice(cursor, cursor + CONCURRENCY);
        cursor += chunk.length;
        const results = await Promise.allSettled(chunk.map(one));
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.status === "rejected") failures.push({ vote_id: chunk[i].id, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
        }
        if (failures.length >= 5) break;
      }
      return json({ success: true, asked, cost_usd: Number(cost.toFixed(6)), candidates: list.length, remaining: list.length - cursor, out_of_time: outOfTime, elapsed_ms: Date.now() - startedAt, tally, failures });
    }

    if (action === "judge") {
      const apiKey = Deno.env.get("OPENROUTER_API_KEY");
      if (!apiKey) return json({ success: false, error: "OPENROUTER_API_KEY is not configured" }, 500);
      const contributionId = typeof body.contribution_id === "string" ? body.contribution_id.trim() : "";
      const targetUrl = typeof body.url === "string" ? body.url.trim() : "";
      if (!/^[0-9a-f-]{36}$/i.test(contributionId)) return json({ success: false, error: "contribution_id 必填（uuid）" }, 400);
      if (!/^https?:\/\/\S+$/.test(targetUrl)) return json({ success: false, error: "url 必填（http(s) 網址）" }, 400);
      const requester = await ipHashOf(req, Deno.env.get("CONTRIBUTION_IP_SALT") || supabaseUrl);

      // 配額：每 IP 每 10 分鐘 JUDGE_PER_IP 次、全域 BACKFILL_MAX 次。不帶金鑰的端點只能這樣守
      const JUDGE_PER_IP = 60;
      const since = new Date(Date.now() - BACKFILL_WINDOW_MINUTES * 60 * 1000).toISOString();
      const [{ count: mine }, { count: all }] = await Promise.all([
        supabase.from("jev_decisions").select("id", { count: "exact", head: true }).eq("question", "second_source").eq("requester_ip_hash", requester).gte("asked_at", since),
        supabase.from("jev_decisions").select("id", { count: "exact", head: true }).eq("question", "second_source").gte("asked_at", since),
      ]);
      if ((mine ?? 0) >= JUDGE_PER_IP || (all ?? 0) >= BACKFILL_MAX) {
        return json({ success: false, error: "rate_limited", message: `${BACKFILL_WINDOW_MINUTES} 分鐘內判定次數已滿，稍後再試` }, 429);
      }

      const { data: c, error: cErr } = await supabase.from("contributions")
        .select("id, contribution_type, payload, source_urls, status").eq("id", contributionId).maybeSingle();
      if (cErr) throw new Error(`contributions read: ${cErr.message}`);
      if (!c) return json({ success: false, error: "not_found", message: "找不到這筆貢獻" }, 404);
      if (!SECOND_SOURCE_TYPES.includes(c.contribution_type)) {
        return json({ success: false, error: "not_eligible", message: "這種型別沒有來源可核" }, 400);
      }
      // 第二來源必須是另一個網域：拿提交的那一頁來問，等於系統票再投一次
      const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
      const submitted = new Set((c.source_urls ?? []).map(hostOf));
      if (submitted.has(hostOf(targetUrl))) {
        return json({ success: false, error: "same_source", message: "這是提交者附的來源網域，系統票已經核過；請找另一個獨立來源" }, 400);
      }

      const payload = { ...(c.payload ?? {}) } as Record<string, unknown>;
      // 2026-09-22 candlefish 第二次探測：原本只有 correction 回查主角，candidacy／policy_progress 的 payload 沒有 name
      // → 主角名單空 → 每一頁都棄權。改成不分型別回查（見 subjectRef）。
      const subjects = await subjectNamesOf(supabase, payload);
      if (subjects[0]) payload.subject_name = subjects[0];
      const claim = claimOf(c.contribution_type, payload);
      const names = [payload.name, payload.politician_name, payload.title, ...subjects].map((x) => typeof x === "string" ? x : null);
      const page = await fetchSource(targetUrl);
      if (page.kind === "pdf") {
        return json({ success: false, error: "unsupported_source", message: "系統不解析 PDF／試算表（只讀網頁）。請找網頁版的來源；參選紀錄可用中選會資料庫的查詢網址（db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名）" }, 422);
      }
      if (page.kind !== "html" || !hasUsableText(page.text, names)) {
        return json({ success: false, error: "fetch_failed", message: `抓不到正文（${page.note}）；試試 archive.org 的存檔網址或另一個來源` }, 422);
      }
      if (!nameHit(page.text, names)) {
        await insertRecords(supabase, [{
          subject_type: "contribution", subject_id: c.id, question: "second_source",
          choice: "cannot_tell", probability: 0, confidence: null, probabilities: null,
          // 棄權也要留抓取麵包屑（raw｜archive｜text）跟找過哪些名字，不然事後分不出「頁抓不到」與「名字對不上」
          model: "policy-tw/fetch-only-00000000", state: { claim, page: { url: targetUrl, text: "", note: `主角名字不在文本裡（找：${names.filter(Boolean).join("／") || "沒有名字可找"}）| ${page.note}` } }, cost_usd: 0, requester_ip_hash: requester,
        }]);
        const hint = names.some(Boolean)
          ? "這一頁沒提到主角（名字不在正文裡）：換一個真的講到這個人的來源；不要拿這頁投 disagree"
          : "這筆貢獻查不出主角名字（payload 沒有 name、也回查不到對象），系統無法核；請人工核";
        return json({ success: true, contribution_id: c.id, url: targetUrl, verdict: "cannot_tell", probability: 0, counts: false, fields: {}, min_probability: MIN_PROBABILITY, subjects: names.filter(Boolean), hint });
      }
      // 轉載不是第二來源（審查建議 7）：跟系統票當時存下來的正文比，太像就退件
      {
        const { data: prior } = await supabase.from("jev_decisions").select("state").eq("subject_type", "contribution").eq("subject_id", c.id)
          .eq("question", "source_support").order("asked_at", { ascending: false }).limit(1).maybeSingle();
        const priorText = (prior?.state as { page?: { text?: string } } | null)?.page?.text ?? "";
        if (priorText && textSimilarity(priorText, page.text) >= SAME_CONTENT_THRESHOLD) {
          return json({ success: false, error: "same_content", message: "這一頁是提交來源的轉載（正文幾乎相同），不算獨立的第二個來源；請找另一家自己採訪或另一份官方文件" }, 400);
        }
      }
      const { state, questions } = buildSourceSupportAsk(claim, targetUrl, focusText(page.text, names));
      const res = await askJev(apiKey, state, questions);
      const agg = aggregateFieldVerdicts(c.contribution_type, claim, res.answers);
      // 成功路徑也留抓取麵包屑（raw｜archive｜text）：只有失敗那條有的話，archive 回退有沒有出手事後查不到（candlefish 第三次探測）
      const stateOut = { ...state, page: { ...((state.page ?? { url: targetUrl }) as Record<string, unknown>), note: page.note } };
      await insertRecords(supabase, [{
        subject_type: "contribution", subject_id: c.id, question: "second_source",
        choice: agg.choice, probability: agg.probability, confidence: null,
        probabilities: agg.fields as unknown as Record<string, number>, model: res.model, state: stateOut,
        cost_usd: Number(res.usage.cost.toFixed(8)), requester_ip_hash: requester,
      }]);
      return json({
        success: true, contribution_id: c.id, url: targetUrl, subjects: names.filter(Boolean),
        verdict: agg.choice, probability: agg.probability, counts: agg.probability >= MIN_PROBABILITY, fields: agg.fields,
        core_fields: agg.core_fields, contradicted_core: agg.contradicted_core,
        min_probability: MIN_PROBABILITY,
        hint: agg.choice === "supported" && agg.probability >= MIN_PROBABILITY
          ? "這一頁足以證實：投 agree 時把這個網址放 evidence_url"
          : agg.choice === "not_supported" && agg.contradicted_core ? "這一頁與宣稱的核心欄位矛盾：投 disagree 並把這個網址放 evidence_url、note 寫哪一欄不對"
          : agg.choice === "not_supported" ? "只有非核心欄位（政黨寫法、上一屆選區之類）對不上：不構成反對，投 unsure 並在 note 說明哪一欄不同"
          : "這一頁證明不了關鍵欄位：換一個來源，或投 unsure 並說明找過哪裡",
      });
    }

    // ---- extract：代理找到第一來源，Jev 選值（使用者 2026-09-19：任務應該讓代理自己找來源，不一定要看既有的那個）----
    if (action === "extract") {
      const apiKey = Deno.env.get("OPENROUTER_API_KEY");
      if (!apiKey) return json({ success: false, error: "OPENROUTER_API_KEY is not configured" }, 500);
      const taskId = typeof body.task_id === "string" ? body.task_id.trim() : "";
      const targetUrl = typeof body.url === "string" ? body.url.trim() : "";
      const parsed = parseExtractTask(taskId);
      if (!parsed) return json({ success: false, error: "task_not_eligible", message: "task_id 要是 auto:election_result_missing:<id> 或 auto:candidate_status_stale:<id>；其他任務的值不是有限域，Jev 選不出來" }, 400);
      if (!/^https?:\/\/\S+$/.test(targetUrl)) return json({ success: false, error: "url 必填（http(s) 網址）" }, 400);
      const requester = await ipHashOf(req, Deno.env.get("CONTRIBUTION_IP_SALT") || supabaseUrl);

      const EXTRACT_PER_IP = 60;
      const since = new Date(Date.now() - BACKFILL_WINDOW_MINUTES * 60 * 1000).toISOString();
      const [{ count: mine }, { count: all }] = await Promise.all([
        supabase.from("jev_decisions").select("id", { count: "exact", head: true }).eq("question", "extract").eq("requester_ip_hash", requester).gte("asked_at", since),
        supabase.from("jev_decisions").select("id", { count: "exact", head: true }).eq("question", "extract").gte("asked_at", since),
      ]);
      if ((mine ?? 0) >= EXTRACT_PER_IP || (all ?? 0) >= BACKFILL_MAX) {
        return json({ success: false, error: "rate_limited", message: `${BACKFILL_WINDOW_MINUTES} 分鐘內判定次數已滿，稍後再試` }, 429);
      }

      const { data: pe, error: peErr } = await supabase.from("politician_elections")
        .select("id, politician_id, election_id, election_type, candidate_status, election_result, politicians(name, party, region)")
        .eq("id", parsed.pe_id).maybeSingle();
      if (peErr) throw new Error(`politician_elections read: ${peErr.message}`);
      const pol = (pe?.politicians ?? null) as { name?: string; party?: string | null; region?: string | null } | null;
      if (!pe || !pol?.name) return json({ success: false, error: "not_found", message: "找不到這筆參選紀錄" }, 404);
      const subject = { name: pol.name, party: pol.party ?? null, region: pol.region ?? null, election_id: Number(pe.election_id), election_type: (pe.election_type as string | null) ?? null };

      const page = await fetchSource(targetUrl);
      if (page.kind !== "html" || !hasUsableText(page.text, [subject.name])) {
        return json({ success: false, error: "fetch_failed", message: `抓不到正文（${page.note}）；試試 archive.org 的存檔網址或另一個來源` }, 422);
      }
      const { state, questions, field } = buildExtractAsk(parsed.task_type, subject, targetUrl, focusText(page.text, [subject.name]));
      const res = await askJev(apiKey, state, questions);
      const agg = aggregateExtract(parsed.task_type, res.answers as Record<string, { choice: string; probabilities: Record<string, number> }>);
      await insertRecords(supabase, [{
        subject_type: "politician_election", subject_id: String(pe.id), question: "extract",
        choice: agg.value ?? "absent", probability: agg.probability, confidence: null,
        probabilities: { same_person: agg.person.probability, [field]: agg.value ? agg.probability : 0 },
        model: res.model, state, cost_usd: Number(res.usage.cost.toFixed(8)), requester_ip_hash: requester,
      }]);

      // 建議的貢獻：照 skill.md 的規矩——結果用 candidacy 補、登記狀態用 correction 改
      const suggested = !agg.counts ? null
        : parsed.task_type === "election_result_missing"
          ? { contribution_type: "candidacy", task_id: taskId, source_urls: [targetUrl], payload: { politician_id: pe.politician_id, name: subject.name, election_id: subject.election_id, election_type: subject.election_type, region: subject.region, candidate_status: pe.candidate_status ?? "confirmed", election_result: agg.value } }
          : { contribution_type: "correction", task_id: taskId, source_urls: [targetUrl], payload: { target_table: "politician_elections", target_id: String(pe.id), changes: [{ field: "candidate_status", current_value: pe.candidate_status ?? null, correct_value: agg.value }], reason: `Jev 依 ${targetUrl} 判定 ${agg.value}（${agg.probability}）` } };
      return json({
        success: true, task_id: taskId, url: targetUrl, field,
        same_person: agg.person, value: agg.value, probability: agg.probability, counts: agg.counts, min_probability: MIN_PROBABILITY,
        current: { candidate_status: pe.candidate_status ?? null, election_result: pe.election_result ?? null },
        suggested_contribution: suggested,
        hint: agg.counts ? "這一頁足以定值：把 suggested_contribution 原樣 POST /contribute（可補 votes_received／vote_percentage、note）"
          : agg.person.choice !== "same_person" ? "這一頁講的可能不是這個人（同名？）：換一個來源"
          : agg.value === null ? "這一頁沒講這一欄：換一個來源" : "值有了但不到門檻：換一個更明確的來源，或交 no_change 說明找過哪裡",
      });
    }

    // ---- record：外部批次腳本寫入 ----
    if (action !== "record") return json({ success: false, error: `不認得的 action：${action}` }, 400);
    const expectedApiKey = Deno.env.get("SYSTEM_ONE_API_KEY");
    if (!expectedApiKey) return json({ success: false, error: "SYSTEM_ONE_API_KEY is not configured" }, 500);
    if (body.api_key !== expectedApiKey) return json({ success: false, error: "Invalid api_key" }, 401);

    const records = Array.isArray(body.records) ? body.records as Array<Partial<DecisionRecord>> : [];
    if (records.length === 0) return json({ success: false, error: "records 是空的" }, 400);
    if (records.length > MAX_RECORDS) return json({ success: false, error: `一次最多 ${MAX_RECORDS} 筆，這批有 ${records.length} 筆` }, 400);

    const errors: Array<{ index: number; message: string }> = [];
    const rows: DecisionRecord[] = [];
    records.forEach((r, i) => {
      const msg = validateRecord(r);
      if (msg) { errors.push({ index: i, message: msg }); return; }
      rows.push({
        subject_type: r.subject_type!, subject_id: r.subject_id!, question: r.question!, choice: r.choice!,
        probability: r.probability!, confidence: r.confidence ?? null, probabilities: r.probabilities ?? null,
        model: r.model!, state: r.state!, cost_usd: r.cost_usd ?? null,
      });
    });
    if (rows.length === 0) return json({ success: false, inserted: 0, skipped: 0, errors }, 400);
    const wrote = await insertRecords(supabase, rows);
    return json({ success: true, ...wrote, errors });
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
