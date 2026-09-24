import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { listUrl, MOI_KINDS, MOI_PAGE_SIZE, parseMoiList } from "../_shared/moi-officials.ts";

/**
 * 內政部地方公職人員現職名單 → moi_officials（2026-09-24 小良哥：「這裡有一大堆現職的可以抓取」）。
 * 排程每天呼叫（?kinds=KND0001,KND0002…，分批避免逾時）。不驗 JWT 讓 pg_cron 打得到，
 * 所以同一種職務 6 小時內抓過就不再抓：外人重複打也只會空轉，不會去打內政部或寫資料庫。
 */
const UA = "Mozilla/5.0 (compatible; policy-tw-moi-sync/1.0; +https://xn--2lw665d.tw)";
const MIN_INTERVAL_HOURS = 6;
const TIME_BUDGET_MS = 120_000;

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const url = new URL(req.url);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const wanted = (url.searchParams.get("kinds") ?? MOI_KINDS.join(",")).split(",").map((k) => k.trim()).filter((k) => (MOI_KINDS as readonly string[]).includes(k));
  const started = Date.now();
  const report: Record<string, { rows: number; pages: number; skipped?: string; error?: string }> = {};

  for (const kind of wanted) {
    const { data: last } = await supabase.from("moi_officials").select("fetched_at").eq("kind", kind).order("fetched_at", { ascending: false }).limit(1).maybeSingle();
    if (last && Date.now() - Date.parse((last as { fetched_at: string }).fetched_at) < MIN_INTERVAL_HOURS * 3600_000) {
      report[kind] = { rows: 0, pages: 0, skipped: `${MIN_INTERVAL_HOURS} 小時內抓過` };
      continue;
    }
    let rows = 0, pages = 0;
    // 整輪用同一個時間戳：抓完後拿掉「這輪沒出現的人」要靠它，不能每頁各用各的
    const runAt = new Date().toISOString();
    try {
      for (let page = 1; page <= 40 && Date.now() - started < TIME_BUDGET_MS; page++) {
        const res = await fetch(listUrl(kind, page), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list = parseMoiList(await res.text(), kind);
        pages++;
        if (list.length === 0) break;
        for (let i = 0; i < list.length; i += 500) {
          const { error } = await supabase.from("moi_officials").upsert(list.slice(i, i + 500).map((r) => ({ ...r, fetched_at: runAt })), { onConflict: "id" });
          if (error) throw new Error(`upsert: ${error.message}`);
        }
        rows += list.length;
        if (list.length < MOI_PAGE_SIZE) {
          // 這種職務整份抓完了：這次沒出現的人已經不在職，拿掉
          const { error } = await supabase.from("moi_officials").delete().eq("kind", kind).lt("fetched_at", runAt);
          if (error) throw new Error(`cleanup: ${error.message}`);
          break;
        }
      }
      report[kind] = { rows, pages };
    } catch (e) {
      report[kind] = { rows, pages, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return new Response(JSON.stringify({ success: true, report, elapsed_ms: Date.now() - started }), { headers: { "Content-Type": "application/json" } });
});
