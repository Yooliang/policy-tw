/**
 * 日本站の新聞線：ニュースの一覧ページ（網頁）から記事のリンクを拾う。純関数、網路に触れない。
 * 維護者 2026-10-13：新聞の来源は RSS を一律受け付けない、網頁だけ。なので正見の _shared/news-feed.ts（RSS／Atom／sitemap）は使わず、
 * 一覧ページの <a href> のうち link_pattern（正規表現）に合う URL だけを記事として拾う。
 * 一覧ページには日付が無いことが多いので published_at は null（線索の日付は取り込んだ日、jstDate の流儀）。
 */
import type { FeedItem } from "../news-feed.ts";

export const HTML_MAX_ITEMS = 300;
/** これより短いリンク文字列は見出しではない（「次へ」「一覧」など。記事か否かは主に link_pattern で絞る） */
export const HTML_MIN_TITLE = 5;
const TITLE_MAX = 300;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * 一覧ページの HTML → 記事。
 * - href は一覧ページの URL を基準に絶対 URL へ。https 以外・# だけ・javascript: は捨てる
 * - linkPattern（正規表現の文字列）に絶対 URL が合うものだけ。不正な正規表現は例外（呼び出し側が last_error に記録）
 * - 見出し＝<a> の中の文字（タグを外し空白を詰める）、無ければ title 属性。HTML_MIN_TITLE 字未満は捨てる
 * - 同じ URL は最初の 1 つ、最大 maxItems 件
 */
export function parseHtmlList(html: string, pageUrl: string, linkPattern: string, opts: { maxItems?: number } = {}): FeedItem[] {
  const re = new RegExp(linkPattern);
  const max = opts.maxItems ?? HTML_MAX_ITEMS;
  const out: FeedItem[] = [];
  const seen = new Set<string>();
  const body = html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (out.length >= max) break;
    const attrs = m[1];
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (!href) continue;
    const raw = decode((href[1] ?? href[2] ?? href[3] ?? "").trim());
    if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw)) continue;
    let url: string;
    try {
      const u = new URL(raw, pageUrl);
      if (u.protocol !== "https:") continue;
      u.hash = "";
      url = u.toString();
    } catch {
      continue;
    }
    if (!re.test(url) || seen.has(url)) continue;
    let title = decode(m[2].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    if (title.length < HTML_MIN_TITLE) {
      const t = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
      title = t ? decode(t[1] ?? t[2] ?? "").replace(/\s+/g, " ").trim() : title;
    }
    if (title.length < HTML_MIN_TITLE) continue;
    seen.add(url);
    out.push({ url, title: title.slice(0, TITLE_MAX), summary: null, published_at: null });
  }
  return out;
}
