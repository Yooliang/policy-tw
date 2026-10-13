/**
 * jp-news-fetch の本体（網路と資料庫は引数で受ける：テストは偽物を渡す）。
 * 流れ：来源（news_sources）を取る → 記事を news_items に入れる → まだ篩っていない記事を便宜篩（news-screen.ts）→ 線索を news_lead_record で作る／併合。
 * 正見 news-fetch（取り込み）＋ system-one?action=news_screen（初篩）を 1 回の呼び出しにまとめたもの：
 * 日本の篩いは Jev を呼ばず安いので別の関数に分けない。取り込みの解析は正見の _shared/news-feed.ts をそのまま使う
 * （RSS 1.0／2.0／Atom、日付の読み方）。注意：タイムゾーンのない日付は正見の流儀で +08:00 と読まれる（日本の来源は NHK／Yahoo とも +09:00 付きで出す。ずれても 1 時間）。
 */
import { dueSources, FETCH_COOLDOWN_MINUTES, type FeedFormat, type FeedItem, parseFeed } from "../news-feed.ts";
import { buildLgIndex, jstDate, type LgEntry, type NewsLead, screenItem } from "./news-screen.ts";

export interface SourceRow { id: number; label: string; feed_url: string; format: FeedFormat; enabled: boolean; last_fetched_at: string | null }
export interface StoredItem { id: number; source_id: number; url: string; title: string; summary: string | null; published_at: string | null }
export interface NewsSettingsRow { enabled: boolean; max_age_days: number }
export interface LeadResult { action: "created" | "merged" | "capped" | "skipped"; lead_id?: number; reason?: string }
export interface LeadEvidence { news_item_id: number; url: string; title: string; source: string; published_at: string | null; signal: string }

export interface NewsStore {
  settings(): Promise<NewsSettingsRow>;
  listSources(): Promise<SourceRow[]>;
  /** 条件付き更新で先に佔位：他の呼び出しが先に取っていれば false */
  claimSource(id: number, cutoffIso: string, nowIso: string): Promise<boolean>;
  setSourceError(id: number, error: string | null): Promise<void>;
  /** URL が既にあるものは入れない。実際に入った行だけ返す */
  insertItems(sourceId: number, items: readonly FeedItem[], fetchedAtIso: string): Promise<StoredItem[]>;
  listLgs(): Promise<LgEntry[]>;
  listUnscreened(limit: number): Promise<StoredItem[]>;
  markScreened(id: number, screen: Record<string, unknown>, screenedAtIso: string): Promise<void>;
  recordLead(lead: NewsLead, evidence: LeadEvidence[], seenOn: string): Promise<LeadResult>;
}

export interface FetchedPage { text: string; status: number; contentType: string | null }
export interface NewsDeps {
  /** 文字列だけ返してもよい（テスト）。本番は HTTP 状態と Content-Type も返し、0 件のときの診断に使う */
  fetchText(url: string): Promise<string | FetchedPage>;
  now(): Date;
}

/** 解析して 0 件だったときに last_error に残す診断（原因を突き止めるため）：HTTP 状態・Content-Type・<item>／<entry> の数・期限で落ちた数・最新の日付・先頭 200 字 */
export function zeroItemsDiagnosis(page: FetchedPage, format: FeedFormat, now: Date, maxAgeDays: number): string {
  const tag = format === "atom" ? "entry" : format === "rss" ? "item" : "url";
  const blocks = (page.text.match(new RegExp(`<${tag}[\\s>]`, "gi")) ?? []).length;
  const all = parseFeed(page.text, format, { now, maxAgeDays: 36_500 });
  const dated = all.map((i) => i.published_at).filter((d): d is string => !!d).sort();
  const old = all.length - parseFeed(page.text, format, { now, maxAgeDays }).length;
  const head = page.text.slice(0, 200).replace(/\s+/g, " ");
  return `記事 0 件：HTTP ${page.status}、Content-Type ${page.contentType ?? "なし"}、<${tag}> ${blocks} 個、読めた ${all.length} 件` +
    `（うち ${maxAgeDays} 日より古い ${old} 件、最新 ${dated.at(-1) ?? "日付なし"}）、${page.text.length} 字、先頭「${head}」`;
}

export interface NewsReport {
  sources: Array<{ id: number; label: string; parsed: number; inserted: number; error?: string }>;
  screened: number;
  tally: Record<string, number>;
  leads: Array<{ lg_code: string; office_kind: string; signal: string; action: string }>;
  failures: string[];
  disabled?: boolean;
}

/** 1 回に篩う記事の上限（来源 5 つ × 最大 300 則でも 1 回では溢れない程度。残りは次の回） */
export const SCREEN_LIMIT = 600;
const PARALLEL = 3;
const TIME_BUDGET_MS = 100_000;
const MAX_BODY_CHARS = 3_000_000;

export async function runNews(store: NewsStore, deps: NewsDeps, opts: { budgetMs?: number } = {}): Promise<NewsReport> {
  const report: NewsReport = { sources: [], screened: 0, tally: {}, leads: [], failures: [] };
  const settings = await store.settings();
  if (!settings.enabled) return { ...report, disabled: true };
  const started = deps.now().getTime();
  const budget = opts.budgetMs ?? TIME_BUDGET_MS;

  const all = await store.listSources();
  const due = dueSources(all, deps.now());
  const labels = new Map(all.map((s) => [s.id, s.label]));

  const one = async (s: SourceRow): Promise<void> => {
    const now = deps.now();
    const cutoff = new Date(now.getTime() - FETCH_COOLDOWN_MINUTES * 60_000).toISOString();
    if (!(await store.claimSource(s.id, cutoff, now.toISOString()))) return;
    let error: string | null = null, parsed = 0, inserted = 0;
    try {
      const got = await deps.fetchText(s.feed_url);
      const page: FetchedPage = typeof got === "string" ? { text: got, status: 200, contentType: null } : got;
      const text = page.text.slice(0, MAX_BODY_CHARS);
      const items = parseFeed(text, s.format, { now, maxAgeDays: settings.max_age_days });
      parsed = items.length;
      // 0 件は黙って通さない（10-13 初回の cron で NHK 3 本とも 0 件・エラーなしだった）：原因が分かる診断を last_error に残す
      if (items.length === 0) throw new Error(zeroItemsDiagnosis({ ...page, text }, s.format, now, settings.max_age_days));
      inserted = (await store.insertItems(s.id, items, now.toISOString())).length;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    await store.setSourceError(s.id, error ? error.slice(0, 500) : null);
    report.sources.push({ id: s.id, label: s.label, parsed, inserted, ...(error ? { error } : {}) });
  };
  for (let i = 0; i < due.length && deps.now().getTime() - started < budget; i += PARALLEL) {
    await Promise.allSettled(due.slice(i, i + PARALLEL).map(one));
  }

  // ---- 便宜篩 ----
  const pending = await store.listUnscreened(SCREEN_LIMIT);
  if (pending.length === 0) return report;
  const idx = buildLgIndex(await store.listLgs());
  for (const it of pending) {
    if (deps.now().getTime() - started > budget + 40_000) break;
    const out = screenItem(it, idx);
    let result: string = out.result;
    const done: Array<{ lead: NewsLead; action: string }> = [];
    try {
      for (const lead of out.leads) {
        const ev: LeadEvidence = {
          news_item_id: it.id, url: it.url, title: it.title.slice(0, 200), source: labels.get(it.source_id) ?? "", published_at: it.published_at, signal: lead.signal,
        };
        const r = await store.recordLead(lead, [ev], jstDate(it.published_at, deps.now()));
        done.push({ lead, action: r.action });
        report.leads.push({ lg_code: lead.lg_code, office_kind: lead.office_kind, signal: lead.signal, action: r.action });
      }
      if (done.length > 0 && done.every((d) => d.action === "capped")) result = "capped";
      await store.markScreened(it.id, { result, leads: done.map((d) => ({ lg_code: d.lead.lg_code, office_kind: d.lead.office_kind, signal: d.lead.signal, action: d.action })) }, deps.now().toISOString());
      report.screened++;
      report.tally[result] = (report.tally[result] ?? 0) + 1;
    } catch (e) {
      // 篩いきれなかった記事は screened_at を付けない：次の回にもう一度
      report.failures.push(`${it.id}: ${e instanceof Error ? e.message : String(e)}`);
      if (report.failures.length >= 5) break;
    }
  }
  return report;
}
