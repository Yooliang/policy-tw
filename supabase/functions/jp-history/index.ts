// jp-only:begin 檔頭與 import（日本站的 client、對象、撈資料）
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { jpClient } from "../_shared/jp/client.ts";
import { buildHistory, HISTORY_MAX_LIMIT, pageEntries } from "../_shared/history.ts";
import { collectJpHistory as collectHistory, JP_HISTORY_TARGETS as HISTORY_TARGETS, jpHistoryIdValid, type JpHistoryTarget as HistoryTarget } from "../_shared/jp/history.ts";

/**
 * jp-history — 日本站的查核履歷（公開唯讀，對應正見的 history）。
 * 照搬 history，只換 schema、對象與 id 的檢查；改正見那支時這支要跟著改
 * （守門：_shared/jp-history.test.ts 把兩支去掉標為日本專屬的區段後逐行比對）。
 * GET ?target=contribution|local_government|election&id=<uuid｜團體碼｜選舉 id>&limit=20&cursor=<at>
 *   → { entries: [ { agent_name, agent_tool, source_urls, sources, verifiers[], edits[], … } ], origin }
 * 日本專屬的差異（下面標 jp-only 的區段）：
 *   - client 固定 db.schema=policy_jp（_shared/jp/client.ts）。
 *   - 對象：contribution（uuid）、local_government（6 位團體碼）、election（policy_jp.elections.id）；撈法在 _shared/jp/history.ts。
 *   - origin：日本站沒有匯入的資料，沒有紀錄就是 unknown。
 * 回應的 type_label、summary 是正見的中文句子，日本站畫面不用（畫面自己用 payload 組日文）。
 */
// jp-only:end

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
// jp-only:begin id 的格式依對象而不同（_shared/jp/history.ts 的 jpHistoryIdValid）
// jp-only:end

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=30" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const url = new URL(req.url);
    const target = url.searchParams.get("target") as HistoryTarget | null;
    const id = url.searchParams.get("id") ?? "";
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), HISTORY_MAX_LIMIT);
    const cursor = url.searchParams.get("cursor");
    if (!target || !HISTORY_TARGETS.includes(target)) return json({ success: false, error: `target 要是 ${HISTORY_TARGETS.join("／")}` }, 400);
    // jp-only:begin id 檢查與 client
    if (!jpHistoryIdValid(target, id)) return json({ success: false, error: "id 的格式不對（contribution＝uuid、local_government＝6 位團體碼、election＝選舉 id）" }, 400);

    const supabase = jpClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    // jp-only:end
    const data = await collectHistory(supabase, target, id);
    const entries = buildHistory(data);
    const page = pageEntries(entries, limit, cursor);
    // jp-only:begin 沒有紀錄時的來源說明（日本站沒有匯入的資料）
    const origin = entries.length > 0 ? { kind: "contributions", note: null } : { kind: "unknown", note: null };
    if (target === "contribution" && entries.length === 0) return json({ success: false, error: "not_found" }, 404);
    // jp-only:end

    return json({
      success: true,
      target,
      id,
      total: entries.length,
      count: page.items.length,
      has_more: page.has_more,
      next_cursor: page.next_cursor,
      origin,
      entries: page.items,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // jp-only:begin 日誌名稱
    console.error("jp-history error:", message);
    // jp-only:end
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
