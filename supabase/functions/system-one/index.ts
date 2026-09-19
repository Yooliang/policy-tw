import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { aggregateFieldVerdicts, askJev, buildPolicyAsk, buildSourceSupportAsk, claimOf, type DecisionRecord, type ElectionLite, fetchSource, focusText, MIN_PROBABILITY, type PolicyLite, toRecords, validateRecord } from "../_shared/system-one.ts";

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
/** backfill 每次最多問幾筆；以及成本上限的時間窗 */
const BACKFILL_MAX = 50;
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
      for (const c of (cands ?? []) as Array<{ contribution_id: string; contribution_type: string; payload: Record<string, unknown>; source_urls: string[] }>) {
        try {
          const srcUrl = c.source_urls[0];
          const page = await fetchSource(srcUrl);
          const claim = claimOf(c.contribution_type, c.payload ?? {});
          let rows: DecisionRecord[];
          if (page.kind !== "html" || page.text.length < 200) {
            // 抓不到正文就棄權（cannot_tell、機率 0），但一樣留紀錄：候選查詢靠這列知道「判過了」，
            // 而且對帳時分得出「來源抓不到」跟「Jev 看不出來」是兩回事
            rows = [{
              subject_type: "contribution", subject_id: c.contribution_id, question: "source_support",
              choice: "cannot_tell", probability: 0, confidence: null, probabilities: null,
              model: "policy-tw/fetch-only-00000000", state: { claim, page: { url: srcUrl, text: "", fetch: page.kind, note: page.note } }, cost_usd: 0,
            }];
            tally[`fetch:${page.kind}`] = (tally[`fetch:${page.kind}`] ?? 0) + 1;
          } else {
            const names = [c.payload?.name, c.payload?.politician_name, c.payload?.title].map((v) => typeof v === "string" ? v : null);
            const { state, questions } = buildSourceSupportAsk(claim, srcUrl, focusText(page.text, names));
            const res = await askJev(apiKey, state, questions);
            cost += res.usage.cost;
            // 每欄一題，收斂成一票；欄位細節放 probabilities 給 /next 與對帳看
            const agg = aggregateFieldVerdicts(c.contribution_type, claim, res.answers);
            rows = [{
              subject_type: "contribution", subject_id: c.contribution_id, question: "source_support",
              choice: agg.choice, probability: agg.probability, confidence: null,
              probabilities: agg.fields as unknown as Record<string, number>, model: res.model, state, cost_usd: Number(res.usage.cost.toFixed(8)),
            }];
            const k = `${agg.choice}${agg.probability >= MIN_PROBABILITY ? "≥" : "<"}門檻`;
            tally[k] = (tally[k] ?? 0) + 1;
          }
          await insertRecords(supabase, rows);
          // 有票就重算共識：supported 可能讓門檻剛好達標、not_supported 可能直接進裁決
          const { error: aErr } = await supabase.rpc("contribution_apply_consensus", { p_contribution_id: c.contribution_id });
          if (aErr) throw new Error(`apply_consensus: ${aErr.message}`);
          asked++;
        } catch (e) {
          failures.push({ contribution_id: c.contribution_id, error: e instanceof Error ? e.message : String(e) });
          if (failures.length >= 3) break;
        }
      }
      return json({ success: true, asked, cost_usd: Number(cost.toFixed(6)), candidates: (cands ?? []).length, tally, failures, min_probability: MIN_PROBABILITY });
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
