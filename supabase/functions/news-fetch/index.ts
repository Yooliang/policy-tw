import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { dueSources, FETCH_COOLDOWN_MINUTES, type FeedFormat, parseFeed } from "../_shared/news-feed.ts";

/**
 * news-fetch — 把新聞來源（news_sources）逐則收進 news_items（2026-09-29 維護者核准）。
 *
 * 為什麼逐則收：原本的 news_sweep 是每 6 小時一件任務叫代理「讀整份中央社 RSS」，兩週 59 件、
 * 一半的輪次什麼都沒交也沒留紀錄——看過哪些、漏了哪些都答不出來。每則存一列之後，
 * 「收了幾則、篩了幾則、派了幾件」每一步都數得到。
 *
 * 排程每小時呼叫一次：RSS 只保留最新 20～50 則，隔 6 小時、12 小時才看一次會漏。
 * 比照 cec-sync／moi-sync：不驗 JWT（讓 pg_cron 打得到），函式內用 service role 寫；
 * 同一個來源 30 分鐘內抓過就跳過（見 _shared/news-feed.ts 的 FETCH_COOLDOWN_MINUTES），外人重複打只會空轉。
 *
 * 單一來源失敗（逾時、憑證、格式變了）不影響其他來源：寫進那個來源的 last_error，其餘照收。
 * 回應：{ success, sources: [{id, label, parsed, inserted, error?}], skipped, elapsed_ms }
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36";
/** 高雄市政府那支實測要 19～25 秒才回（2026-09-29），給 30 秒 */
const FETCH_TIMEOUT_MS = 30_000;
/** 同時抓幾個來源：20 幾個來源一個一個抓會超過 Edge Function 的時間上限，全部一起抓又像在掃站 */
const PARALLEL = 5;
/** 整輪的時間預算（Edge Function 上限約 150 秒）；沒抓到的來源冷卻期沒被佔住，下一輪會補 */
const TIME_BUDGET_MS = 110_000;
/** 單一來源的回應最多讀多少字：台中市一份 1.5MB，再大多半是格式出錯 */
const MAX_BODY_CHARS = 3_000_000;

interface SourceRow {
  id: number;
  label: string;
  feed_url: string;
  format: FeedFormat;
  path_filter: string | null;
  enabled: boolean;
  last_fetched_at: string | null;
}

interface SourceReport { id: number; label: string; parsed: number; inserted: number; error?: string }

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const started = Date.now();

  const { data: rows, error: sErr } = await supabase.from("news_sources")
    .select("id, label, feed_url, format, path_filter, enabled, last_fetched_at")
    .eq("enabled", true).order("id", { ascending: true }).limit(200);
  if (sErr) return json({ success: false, error: `news_sources: ${sErr.message}` }, 500);
  const all = (rows ?? []) as SourceRow[];
  const due = dueSources(all, new Date());

  const reports: SourceReport[] = [];
  const one = async (s: SourceRow): Promise<void> => {
    // 先佔位再抓：兩個呼叫同時進來時，只有一個搶得到（條件式更新），另一個看到冷卻中就放手
    const now = new Date();
    const cutoff = new Date(now.getTime() - FETCH_COOLDOWN_MINUTES * 60_000).toISOString();
    const { data: claimed, error: cErr } = await supabase.from("news_sources")
      .update({ last_fetched_at: now.toISOString() })
      .eq("id", s.id).or(`last_fetched_at.is.null,last_fetched_at.lte."${cutoff}"`)
      .select("id");
    if (cErr) { reports.push({ id: s.id, label: s.label, parsed: 0, inserted: 0, error: `claim: ${cErr.message}` }); return; }
    if (!claimed || claimed.length === 0) return;

    let error: string | null = null;
    let parsed = 0, inserted = 0;
    try {
      const res = await fetch(s.feed_url, {
        headers: { "User-Agent": UA, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = (await res.text()).slice(0, MAX_BODY_CHARS);
      const items = parseFeed(text, s.format, { pathFilter: s.path_filter, now });
      parsed = items.length;
      // 一則都剖不出來而且回應裡連一個 <item>／<entry>／<url> 都沒有，多半是改版或被導去別頁；記下來讓人看得到
      if (items.length === 0 && !/<(item|entry|url)[\s>]/i.test(text)) throw new Error(`回應裡找不到任何一則（${text.length} 字，開頭：${text.slice(0, 80).replace(/\s+/g, " ")}）`);
      if (items.length > 0) {
        const { data: ins, error: iErr } = await supabase.from("news_items")
          .upsert(items.map((it) => ({ ...it, source_id: s.id, fetched_at: now.toISOString() })), { onConflict: "url", ignoreDuplicates: true })
          .select("id");
        if (iErr) throw new Error(`news_items: ${iErr.message}`);
        inserted = (ins ?? []).length;
      }
    } catch (e) {
      error = e instanceof Error ? (e.name === "TimeoutError" ? `逾時（${FETCH_TIMEOUT_MS / 1000} 秒）` : e.message) : String(e);
    }
    const { error: uErr } = await supabase.from("news_sources").update({ last_error: error ? error.slice(0, 500) : null }).eq("id", s.id);
    if (uErr) console.error(`news_sources ${s.id} last_error:`, uErr.message);
    reports.push({ id: s.id, label: s.label, parsed, inserted, ...(error ? { error } : {}) });
  };

  let cursor = 0;
  while (cursor < due.length && Date.now() - started < TIME_BUDGET_MS) {
    const chunk = due.slice(cursor, cursor + PARALLEL);
    cursor += chunk.length;
    await Promise.allSettled(chunk.map(one));
  }

  // 收完當場初篩（維護者 2026-09-29：收錄跟 Jev 初篩做在一起，不另排每天兩次）。
  // 初篩是另一支函式（system-one?action=news_screen，有自己的時間上限與 Jev 成本上限），這裡只觸發、不等它：
  // 收錄本身最多用掉 110 秒，再等初篩會超過 Edge Function 的時間上限。只在這一輪真的抓了來源時才觸發——
  // 外人狂打 news-fetch 時多半全在冷卻中，不會連帶一直叫初篩。初篩只撿還沒判過的，漏叫一次下一小時會補。
  let screen: string = "這一輪沒有抓任何來源，不觸發初篩";
  if (reports.length > 0) {
    const screenUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/system-one?action=news_screen`;
    const task = fetch(screenUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(150_000) })
      .then(async (r) => { if (!r.ok) console.error(`news_screen ${r.status}: ${(await r.text()).slice(0, 300)}`); })
      .catch((e) => console.error("news_screen:", e instanceof Error ? e.message : String(e)));
    // Supabase 的 Edge Runtime 有 EdgeRuntime.waitUntil（回應送出後繼續跑）；本機 deno 沒有，就在背景放著
    const rt = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
    if (rt) rt.waitUntil(task);
    screen = "已觸發 system-one?action=news_screen";
  }

  return json({
    screen,
    success: true,
    sources: reports,
    inserted: reports.reduce((n, r) => n + r.inserted, 0),
    skipped: all.length - due.length,
    not_reached: due.length - cursor,
    elapsed_ms: Date.now() - started,
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
