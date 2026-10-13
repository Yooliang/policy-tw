/**
 * jp-news-fetch の本体（網路と資料庫は引数で受ける：テストは偽物を渡す）。
 * 流れ：来源（news_sources）を取る → 記事を news_items に入れる → まだ篩っていない記事を便宜篩（news-screen.ts）→ 線索を news_lead_record で作る／併合。
 * 正見 news-fetch（取り込み）＋ system-one?action=news_screen（初篩）を 1 回の呼び出しにまとめたもの：
 * 日本の篩いは Jev を呼ばず安いので別の関数に分けない。
 * 取り込み：維護者 2026-10-13「RSS は一律受け付けない、網頁だけ」。来源は format='html'（ニュースの一覧ページ）だけを取り、
 * 記事は news-html.ts が link_pattern に合う <a href> から拾う。rss／atom の行は migration 20261011260000 で全部止めてあり、
 * 万一 enabled でも取らずに last_error を残す（正見の parseFeed は使わない）。冷却と期限切れの判定（dueSources）だけ正見のものを使う。
 */
import { dueSources, FETCH_COOLDOWN_MINUTES, type FeedItem } from "../news-feed.ts";
import { parseHtmlList } from "./news-html.ts";
import { buildLgIndex, jstDate, type LgEntry, type NewsLead, screenItem } from "./news-screen.ts";

export type JpNewsFormat = "html" | "rss" | "atom";
export interface SourceRow { id: number; label: string; feed_url: string; format: JpNewsFormat; link_pattern: string | null; enabled: boolean; last_fetched_at: string | null }
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

export interface NewsDeps {
  fetchText(url: string): Promise<string>;
  now(): Date;
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
      if (s.format !== "html") throw new Error(`RSS／Atom の来源は受け付けない（format=${s.format}）`);
      if (!s.link_pattern) throw new Error("link_pattern が無い");
      const text = (await deps.fetchText(s.feed_url)).slice(0, MAX_BODY_CHARS);
      const items = parseHtmlList(text, s.feed_url, s.link_pattern);
      parsed = items.length;
      if (items.length === 0) throw new Error(`一覧ページに記事のリンクが 1 つもない（${text.length} 字）`);
      if (items.length > 0) inserted = (await store.insertItems(s.id, items, now.toISOString())).length;
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
