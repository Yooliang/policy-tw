import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { archiveOne, type ArchivePatch, type ClaimedSource, runArchiveRound } from "../_shared/source-archive.ts";

/**
 * source-archive — 選舉公報、選委會公告類的出處送 Wayback Machine 存檔（issue #347 第一階段，2026-10-05）。
 *
 * 待存檔的清單是 sources 裡 doc_kind 有值、archive_url 還空著的列；交件當下就由觸發器登記進來，
 * 不必等投票（公報投票後下架，等驗證通過才存可能來不及）。為什麼做成排程而不是交件時同步存、
 * 或派任務給代理，見 _shared/source-archive.ts 檔頭與 docs/DECISIONS.md 2026-10-05。
 *
 * 比照 news-fetch／cec-sync：不驗 JWT（讓 pg_cron 打得到），函式內用 service role 寫。
 * 外人重複打只會提早做排程本來就要做的事：每筆一領就有 30 分鐘租約、失敗依次數退避，
 * 不會對 Wayback 連續送同一個網址。
 *
 * 回應：{ success, archived, failed, stopped_by, items: [{id, url, ok, archive_url?, method?, error?}], elapsed_ms }
 */

/** 一輪最多存幾筆：Wayback 匿名存檔每分鐘只收幾次，貪多只會撞 429 */
const MAX_ITEMS = 4;
/** 整輪的時間預算（Edge Function 上限約 150 秒）：單筆最多「查既有存檔 20 秒＋現在存 60 秒」，45 秒後不再領新的，最壞約 125 秒 */
const TIME_BUDGET_MS = 45_000;
const SAVE_TIMEOUT_MS = 60_000;

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const started = Date.now();

  try {
    const { reports, stoppedBy } = await runArchiveRound({
      claim: async () => {
        const { data, error } = await supabase.rpc("source_archive_claim", { p_limit: 1 });
        if (error) throw new Error(`source_archive_claim: ${error.message}`);
        const rows = (data ?? []) as ClaimedSource[];
        return rows[0] ?? null;
      },
      update: async (id: number, patch: ArchivePatch) => {
        const { error } = await supabase.from("sources").update(patch).eq("id", id);
        if (error) throw new Error(`sources ${id}: ${error.message}`);
      },
      archive: (url, fetchedAt) => archiveOne(url, fetchedAt, { saveTimeoutMs: SAVE_TIMEOUT_MS }),
      now: () => new Date(),
      maxItems: MAX_ITEMS,
      timeBudgetMs: TIME_BUDGET_MS,
    });
    return json({
      success: true,
      archived: reports.filter((r) => r.ok).length,
      failed: reports.filter((r) => !r.ok).length,
      stopped_by: stoppedBy,
      items: reports,
      elapsed_ms: Date.now() - started,
    });
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : String(e), elapsed_ms: Date.now() - started }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
