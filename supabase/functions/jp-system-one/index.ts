import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { jpClient } from "../_shared/jp/client.ts";
import { askJev, JEV_KEY_MISSING, jevKeyFromEnv, MIN_PROBABILITY } from "../_shared/system-one.ts";
import { batchHttpStatus } from "../_shared/batch-status.ts";
import { type PrecheckCandidate, precheckOne } from "../_shared/jp/precheck.ts";

/**
 * jp-system-one — 日本站の系統票（Jev が提出者の出典を確かめる）。正見 system-one の ?action=precheck だけを日本站に搬んだもの。
 *
 *   ?action=precheck POST   pending で出典つき、まだ判定していない candidacy／politician／policy を拾い（SQL policy_jp.system_one_precheck_candidates）、
 *                           出典を取って Jev に欄ごとに聞き、policy_jp.jev_decisions に source_support を一列書いて共識を計算し直す。
 *                           pg_cron policy-jp-system-one-precheck-10min が 10 分ごとに叩く（migration 20261011100000）。
 *
 * 金鑰は取らない（cron の呼び出しは開源の migration に書いてある）。代わりに成本上限：10 分以内に policy_jp.jev_decisions の
 * source_support が limit 件に達していれば、このラウンドは聞かない（正見と同じ守り方）。Jev の金鑰は正見と同じ secret を読む（新しい secret は要らない）。
 *
 * 系統票の意味は正見と同じ：supported ≥ 0.95 → 目標 −1（最少 1）、not_supported ≥ 0.95 → 目標 +1、それ以外は棄權。
 * candidacy が「異なる接続元 2 か所」を要るのは変わらない（contribution_needs_two_ips、計分は一字も変えていない）。
 * 宣稱の組み方・逐欄の説明・文字コード・PDF は _shared/jp/system-one.ts、一件の処理は _shared/jp/precheck.ts。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
/** 一ラウンドの上限と成本上限の時間窓（正見 BACKFILL_MAX／BACKFILL_WINDOW_MINUTES と同じ） */
const PRECHECK_MAX = 300;
const WINDOW_MINUTES = 10;
/** 正見の 2026-09-19 の教訓（WORKER_RESOURCE_LIMIT）：2 件ずつ並行、40 秒で切り上げ、残りは次のラウンド（候選清單は冪等） */
const BUDGET_MS = 40_000;
const CONCURRENCY = 2;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  if (req.method !== "POST" || action !== "precheck") return json({ success: false, error: "POST ?action=precheck のみ" }, 404);
  try {
    const supabase = jpClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const apiKey = jevKeyFromEnv((k) => Deno.env.get(k));
    if (!apiKey) return json({ success: false, error: JEV_KEY_MISSING }, 500);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), PRECHECK_MAX);
    const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();
    const { count, error: cErr } = await supabase.from("jev_decisions")
      .select("id", { count: "exact", head: true }).eq("subject_type", "contribution").eq("question", "source_support").gte("asked_at", since);
    if (cErr) throw new Error(`jev_decisions recent count: ${cErr.message}`);
    const budget = Math.max(0, limit - (count ?? 0));
    if (budget === 0) return json({ success: true, asked: 0, reason: `${WINDOW_MINUTES} 分以内に ${count} 件判定済み、このラウンドは聞かない` });

    const { data: cands, error: qErr } = await supabase.rpc("system_one_precheck_candidates", { p_limit: budget });
    if (qErr) throw new Error(`precheck candidates: ${qErr.message}`);
    const list = (cands ?? []) as PrecheckCandidate[];
    const ask = (state: Record<string, unknown>, questions: Parameters<typeof askJev>[2]) => askJev(apiKey, state, questions);
    let asked = 0, cost = 0, cursor = 0, outOfTime = false;
    const tally: Record<string, number> = {};
    const failures: Array<{ contribution_id: string; error: string }> = [];
    const startedAt = Date.now();
    while (cursor < list.length) {
      if (Date.now() - startedAt > BUDGET_MS) { outOfTime = true; break; }
      const chunk = list.slice(cursor, cursor + CONCURRENCY);
      cursor += chunk.length;
      const results = await Promise.allSettled(chunk.map((c) => precheckOne(supabase, c, ask)));
      results.forEach((r, i) => {
        if (r.status === "rejected") { failures.push({ contribution_id: chunk[i].contribution_id, error: r.reason instanceof Error ? r.reason.message : String(r.reason) }); return; }
        tally[r.value.key] = (tally[r.value.key] ?? 0) + 1;
        cost += r.value.cost;
        asked++;
      });
      // Jev が落ちていたらラウンドごと止める（何十件も同じ失敗を繰り返さない）
      if (failures.length >= 5) break;
    }
    return json({ success: true, asked, cost_usd: Number(cost.toFixed(6)), candidates: list.length, remaining: list.length - cursor, out_of_time: outOfTime, elapsed_ms: Date.now() - startedAt, tally, failures, min_probability: MIN_PROBABILITY }, batchHttpStatus(asked, failures));
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
