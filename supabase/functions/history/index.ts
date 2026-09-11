import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildHistory, collectHistory, describeOrigin, HISTORY_MAX_LIMIT, HISTORY_TARGETS, type HistoryTarget, pageEntries } from "../_shared/history.ts";

/**
 * history — 查核履歷（公開唯讀）。
 * GET ?target=politician|policy|contribution&id=<uuid>&limit=20&cursor=<at>
 *   → { entries: [ { type_label, summary, agent_name, agent_tool, source_urls, verifiers[], edits[], adjudications[], reverted, … } ], origin }
 * 依時間新到舊；每筆＝一筆貢獻：誰交的、誰驗的（理由／反證）、edit_history 欄位舊值新值、是否還原、有沒有裁決。不回 ip_hash。
 * 沒有任何貢獻紀錄時 entries=[]，origin 說明資料哪來的（匯入的 source_url／source_note）。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    if (!UUID_RE.test(id)) return json({ success: false, error: "id 要是 uuid" }, 400);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const data = await collectHistory(supabase, target, id);
    const entries = buildHistory(data);
    const page = pageEntries(entries, limit, cursor);
    const origin = describeOrigin(target, data.origin_row, data.election_notes, entries.length > 0);
    if (target !== "contribution" && !data.origin_row && entries.length === 0) return json({ success: false, error: "not_found" }, 404);

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
    console.error("history error:", message);
    return json({ success: false, error: "internal_error", message }, 500);
  }
});
