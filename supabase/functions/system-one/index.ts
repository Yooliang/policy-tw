import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ipHashOf } from "../_shared/contribute-handler.ts";
import { aggregateFieldVerdicts, askJev, buildPolicyAsk, buildSourceSupportAsk, claimOf, combineSources, type DecisionRecord, type ElectionLite, fetchSource, focusText, MIN_PROBABILITY, type PolicyLite, toRecords, validateRecord, hasUsableText, aggregateExtract, buildExtractAsk, parseExtractTask, nameHit } from "../_shared/system-one.ts";

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
      /** 更正沒帶對象名稱，頁面無從對起：用 target_table／target_id 把人物名或政見標題查出來 */
      const subjectNameOf = async (payload: Record<string, unknown>): Promise<string | null> => {
        const table = payload.target_table, id = payload.target_id;
        if (typeof table !== "string" || typeof id !== "string") return null;
        const col = table === "politicians" ? "name" : table === "policies" ? "title" : null;
        if (!col) return null;
        const { data } = await supabase.from(table).select(col).eq("id", id).maybeSingle();
        const row = data as Record<string, unknown> | null;
        return row && typeof row[col] === "string" ? row[col] as string : null;
      };
      const one = async (c: Cand): Promise<void> => {
        const payload = { ...(c.payload ?? {}) };
        if (c.contribution_type === "correction") {
          const subject = await subjectNameOf(payload);
          if (subject) payload.subject_name = subject;
        }
        const claim = claimOf(c.contribution_type, payload);
        const names = [payload.name, payload.politician_name, payload.title, payload.subject_name].map((v) => typeof v === "string" ? v : null);
        // 最多看三個來源：第一個常常只是中選會的附件索引頁，名單在 PDF 或後面的來源裡
        const urls = c.source_urls.slice(0, 3);
        const fetched = await Promise.all(urls.map(async (u) => ({ url: u, ...(await fetchSource(u)) })));
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
          const res = await askJev(apiKey, state, questions);
          cost += res.usage.cost;
          // 每欄一題，收斂成一票；欄位細節放 probabilities 給 /next 與對帳看
          const agg = aggregateFieldVerdicts(c.contribution_type, claim, res.answers);
          rows = [{
            subject_type: "contribution", subject_id: c.contribution_id, question: "source_support",
            choice: agg.choice, probability: agg.probability, confidence: null,
            probabilities: agg.fields as unknown as Record<string, number>, model: res.model, state, cost_usd: Number(res.usage.cost.toFixed(8)),
          }];
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

    // ---- judge：代理的第二來源判定。公開，按來源 IP 配額 ----
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
      if (!["policy", "candidacy", "politician", "correction", "policy_progress"].includes(c.contribution_type)) {
        return json({ success: false, error: "not_eligible", message: "這種型別沒有來源可核" }, 400);
      }
      // 第二來源必須是另一個網域：拿提交的那一頁來問，等於系統票再投一次
      const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
      const submitted = new Set((c.source_urls ?? []).map(hostOf));
      if (submitted.has(hostOf(targetUrl))) {
        return json({ success: false, error: "same_source", message: "這是提交者附的來源網域，系統票已經核過；請找另一個獨立來源" }, 400);
      }

      const payload = { ...(c.payload ?? {}) } as Record<string, unknown>;
      if (c.contribution_type === "correction") {
        const table = payload.target_table, id = payload.target_id;
        const col = table === "politicians" ? "name" : table === "policies" ? "title" : null;
        if (col && typeof table === "string" && typeof id === "string") {
          const { data: subj } = await supabase.from(table).select(col).eq("id", id).maybeSingle();
          const row = subj as Record<string, unknown> | null;
          if (row && typeof row[col] === "string") payload.subject_name = row[col];
        }
      }
      const claim = claimOf(c.contribution_type, payload);
      const names = [payload.name, payload.politician_name, payload.title, payload.subject_name].map((x) => typeof x === "string" ? x : null);
      const page = await fetchSource(targetUrl);
      if (page.kind !== "html" || !hasUsableText(page.text, names)) {
        return json({ success: false, error: "fetch_failed", message: `抓不到正文（${page.note}）；試試 archive.org 的存檔網址或另一個來源` }, 422);
      }
      if (!nameHit(page.text, names)) {
        await insertRecords(supabase, [{
          subject_type: "contribution", subject_id: c.id, question: "second_source",
          choice: "cannot_tell", probability: 0, confidence: null, probabilities: null,
          model: "policy-tw/fetch-only-00000000", state: { claim, page: { url: targetUrl, text: "", note: "主角名字不在文本裡" } }, cost_usd: 0, requester_ip_hash: requester,
        }]);
        return json({ success: true, contribution_id: c.id, url: targetUrl, verdict: "cannot_tell", probability: 0, counts: false, fields: {}, min_probability: MIN_PROBABILITY, hint: "這一頁沒提到主角（名字不在正文裡）：換一個真的講到這個人的來源；不要拿這頁投 disagree" });
      }
      const { state, questions } = buildSourceSupportAsk(claim, targetUrl, focusText(page.text, names));
      const res = await askJev(apiKey, state, questions);
      const agg = aggregateFieldVerdicts(c.contribution_type, claim, res.answers);
      await insertRecords(supabase, [{
        subject_type: "contribution", subject_id: c.id, question: "second_source",
        choice: agg.choice, probability: agg.probability, confidence: null,
        probabilities: agg.fields as unknown as Record<string, number>, model: res.model, state,
        cost_usd: Number(res.usage.cost.toFixed(8)), requester_ip_hash: requester,
      }]);
      return json({
        success: true, contribution_id: c.id, url: targetUrl,
        verdict: agg.choice, probability: agg.probability, counts: agg.probability >= MIN_PROBABILITY, fields: agg.fields,
        min_probability: MIN_PROBABILITY,
        hint: agg.choice === "supported" && agg.probability >= MIN_PROBABILITY
          ? "這一頁足以證實：投 agree 時把這個網址放 evidence_url"
          : agg.choice === "not_supported" ? "這一頁與宣稱矛盾：投 disagree 並把這個網址放 evidence_url、note 寫哪一欄不對"
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
