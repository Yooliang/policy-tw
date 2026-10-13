import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { jpClient } from "../_shared/jp/client.ts";
import { verifyCaller } from "../_shared/console-fetch-auth.ts";
import { type LeadEvidence, type LeadResult, type NewsStore, runNews, type SourceRow, type StoredItem } from "../_shared/jp/news-run.ts";
import type { LgEntry, NewsLead } from "../_shared/jp/news-screen.ts";
import type { FeedItem } from "../_shared/news-feed.ts";

/**
 * jp-news-fetch — 日本站の新聞線。pg_cron policy-jp-news-fetch-hourly（毎時 23 分）が叩く（migration 20261011250000）。
 * 日本の公開 RSS（policy_jp.news_sources）を取って news_items に入れ、団体名＋首長／議会＋辞職・死去・議会解散・リコールの記事を
 * 「選挙が要りそうな団体×職」の線索（news_election_leads）にする。線索は派工臂 news_discovery が election_discovery 任務にする
 * （target.discovery='news'）。報道は手がかりで出典ではなく、選挙の記録は代理が選管の告示を出典に交件して初めて作られる。
 *
 * 正見 news-fetch（取り込み）と system-one?action=news_screen（初篩）の日本版。Jev はこの版では呼ばない（便宜篩だけ、次の刀）。
 * 呼び出し憑證は jp-system-one と同じ：x-cron-secret（Vault の jp_news_cron_secret を RPC policy_jp.jp_news_cron_secret_ok で照合）か
 * service role の bearer。なし・誤りは 401、照合が失敗したら 503（fail closed）。新しい secret を手で設定する必要はない。
 * 取り込みの解析（RSS／Atom、日付）は正見の _shared/news-feed.ts、篩いは _shared/jp/news-screen.ts、本体は _shared/jp/news-run.ts。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UA = "Mozilla/5.0 (compatible; policy-jp-news/1.0; +https://jp.hustings.net)";
const FETCH_TIMEOUT_MS = 30_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// deno-lint-ignore no-explicit-any
function storeOf(db: any): NewsStore {
  const must = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    return (r.data ?? ([] as unknown)) as T;
  };
  return {
    async settings() {
      const r = await db.from("news_settings").select("enabled, max_age_days").eq("id", 1).maybeSingle();
      if (r.error) throw new Error(`news_settings: ${r.error.message}`);
      return r.data ?? { enabled: false, max_age_days: 3 };
    },
    async listSources() {
      return must<SourceRow[]>(await db.from("news_sources").select("id, label, feed_url, format, enabled, last_fetched_at")
        .eq("enabled", true).order("id", { ascending: true }).limit(200), "news_sources");
    },
    async claimSource(id, cutoffIso, nowIso) {
      const r = await db.from("news_sources").update({ last_fetched_at: nowIso }).eq("id", id)
        .or(`last_fetched_at.is.null,last_fetched_at.lte."${cutoffIso}"`).select("id");
      if (r.error) throw new Error(`claim: ${r.error.message}`);
      return (r.data ?? []).length > 0;
    },
    async setSourceError(id, error) {
      const r = await db.from("news_sources").update({ last_error: error }).eq("id", id);
      if (r.error) console.error(`news_sources ${id} last_error:`, r.error.message);
    },
    async insertItems(sourceId, items: readonly FeedItem[], fetchedAtIso) {
      const r = await db.from("news_items")
        .upsert(items.map((it) => ({ ...it, source_id: sourceId, fetched_at: fetchedAtIso })), { onConflict: "url", ignoreDuplicates: true })
        .select("id, source_id, url, title, summary, published_at");
      return must<StoredItem[]>(r, "news_items");
    },
    async listLgs() {
      // 団体表は約 2,000 行：PostgREST の 1,000 行上限を避けて 2 ページに分ける
      const out: LgEntry[] = [];
      const prefs = new Map<string, string>();
      for (let from = 0; ; from += 1000) {
        const r = await db.from("local_governments").select("lg_code, name, kind, pref_code").is("valid_to", null)
          .order("lg_code", { ascending: true }).range(from, from + 999);
        const rows = must<Array<{ lg_code: string; name: string; kind: string; pref_code: string }>>(r, "local_governments");
        for (const g of rows) {
          if (g.kind === "prefecture") prefs.set(g.lg_code, g.name);
          out.push({ lg_code: g.lg_code, name: g.name, kind: g.kind, pref_name: g.pref_code });
        }
        if (rows.length < 1000) break;
      }
      return out.map((g) => ({ ...g, pref_name: prefs.get(g.pref_name) ?? g.pref_name }));
    },
    async listUnscreened(limit) {
      return must<StoredItem[]>(await db.from("news_items").select("id, source_id, url, title, summary, published_at")
        .is("screened_at", null).order("id", { ascending: true }).limit(limit), "news_items unscreened");
    },
    async markScreened(id, screen, screenedAtIso) {
      const r = await db.from("news_items").update({ screened_at: screenedAtIso, screen }).eq("id", id);
      if (r.error) throw new Error(`news_items screened: ${r.error.message}`);
    },
    async recordLead(lead: NewsLead, evidence: LeadEvidence[], seenOn: string): Promise<LeadResult> {
      const r = await db.rpc("news_lead_record", {
        p_lg_code: lead.lg_code, p_office_kind: lead.office_kind, p_signal: lead.signal, p_evidence: evidence, p_seen_on: seenOn,
      });
      if (r.error) throw new Error(`news_lead_record: ${r.error.message}`);
      return r.data as LeadResult;
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST のみ" }, 405);
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const check = await verifyCaller(req.headers, {
    serviceRoleKey,
    checkCronSecret: serviceRoleKey && supabaseUrl
      ? async (secret) => {
        const { data, error } = await jpClient(supabaseUrl, serviceRoleKey).rpc("jp_news_cron_secret_ok", { p_secret: secret });
        if (error) throw new Error(error.message);
        return data === true;
      }
      : undefined,
  });
  if (!check.ok) return json({ success: false, error: check.error }, check.status);
  if (!serviceRoleKey || !supabaseUrl) return json({ success: false, error: "SUPABASE_URL／SUPABASE_SERVICE_ROLE_KEY がない" }, 500);
  const started = Date.now();
  try {
    const report = await runNews(storeOf(jpClient(supabaseUrl, serviceRoleKey)), {
      now: () => new Date(),
      async fetchText(url) {
        const res = await fetch(url, {
          headers: { "User-Agent": UA, "Accept": "application/rss+xml, application/atom+xml, application/rdf+xml, application/xml, text/xml, */*" },
          redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { text: await res.text(), status: res.status, contentType: res.headers.get("content-type") };
      },
    });
    return json({ success: true, elapsed_ms: Date.now() - started, ...report }, report.failures.length >= 5 ? 500 : 200);
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
