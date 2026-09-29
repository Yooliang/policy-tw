/**
 * 新聞來源解析（news-fetch 用）：RSS、Atom、Google 新聞 sitemap 三種，純函式、不碰網路。
 *
 * 為什麼自己用正規表達式剖、不引 XML 函式庫：來源是 20 幾家媒體與縣市政府，
 * 格式「大致」合規但各有各的歪法（2026-09-29 逐一實測）：
 *   - 南投縣的 <pubdate> 是小寫、日期是民國「115-09-28」、<link> 裡包著換行加 CDATA；
 *   - 彰化縣的 pubDate 是「週一, 28 九月 2026 00:00:00 +0800」（中文星期與月份）；
 *   - 新竹市只給「2026-09-28」、新竹縣的 description 是被跳脫過一次的 HTML（&lt;p&gt;）；
 *   - Yahoo 的 <link> 排在 <guid> 後面、公視是 Atom 的 <link href="…"/>；
 *   - 行政院有 <description /> 自己關起來的空標籤。
 * 嚴格的 XML 剖析器碰到其中任何一家不合規就整份丟例外；我們要的只有網址、標題、摘要、日期四個欄位，
 * 逐欄寬鬆地抓比較不會因為一家的小毛病整份讀不到。
 */

export type FeedFormat = "rss" | "atom" | "sitemap_news";
export const FEED_FORMATS: readonly FeedFormat[] = ["rss", "atom", "sitemap_news"];

export interface FeedItem {
  url: string;
  title: string;
  summary: string | null;
  /** ISO 字串；來源沒給或讀不懂就是 null */
  published_at: string | null;
}

export interface ParseOptions {
  /** 網址要包含這段才收（sitemap／全類別來源用，例如 TVBS 的 '/politics/'）；null／空字串＝全收 */
  pathFilter?: string | null;
  /** 只收這麼多天內發布的；沒日期的照收（讀不懂日期不代表是舊聞） */
  maxAgeDays?: number;
  now?: Date;
  /** 一份來源一輪最多收幾則（台中市一份就 500 則） */
  maxItems?: number;
}

export const DEFAULT_MAX_AGE_DAYS = 3;
export const DEFAULT_MAX_ITEMS = 300;
const TITLE_MAX = 300;
const SUMMARY_MAX = 500;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", middot: "·", hellip: "…", bull: "•",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", laquo: "«", raquo: "»",
};

/** HTML／XML 實體解碼（具名的常見幾個＋數字碼） */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** 拆掉 CDATA 外殼（一段文字裡可能有好幾段） */
function unwrapCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

/**
 * 欄位內容轉純文字：CDATA → 實體解碼 → 去標籤 → 再解碼一次。
 * 解碼兩次是為了新竹縣那種「HTML 被跳脫過一次」的 description：第一次解出 <p>、去標籤後
 * 剩下 &nbsp; 這種第二層實體。
 */
export function toPlainText(raw: string): string {
  let s = decodeEntities(unwrapCdata(raw));
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s.replace(/\s+/g, " ").trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 取一個標籤的內文（第一個符合的）。名字不分大小寫（南投縣是 <pubdate>）。
 * <description /> 這種自己關起來的回空字串；找不到回 null。
 */
export function tagText(block: string, name: string): string | null {
  const open = new RegExp(`<${escapeRe(name)}(\\s[^>]*?)?(/?)>`, "i");
  const m = open.exec(block);
  if (!m) return null;
  if (m[2] === "/") return "";
  const start = m.index + m[0].length;
  const close = new RegExp(`</${escapeRe(name)}\\s*>`, "i");
  const rest = block.slice(start);
  const c = close.exec(rest);
  if (!c) return null;
  return rest.slice(0, c.index);
}

/** 依序試幾個標籤名，回第一個有內容的 */
function firstTag(block: string, names: string[]): string | null {
  for (const n of names) {
    const t = tagText(block, n);
    if (t !== null && t.trim() !== "") return t;
  }
  return null;
}

/** 切出每一則（<item>、<entry>、<url>） */
function blocksOf(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[2]);
  return out;
}

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };

/** 沒帶時區的時間一律當台灣時間：這批來源全是台灣的站，伺服器（Edge Function）卻跑在 UTC */
function twIso(y: number, mo: number, d: number, time = "00:00:00"): string | null {
  if (!(y > 1900 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  const t = time.length === 5 ? `${time}:00` : time;
  const ms = Date.parse(`${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${t.padStart(8, "0")}+08:00`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** 讀來源的日期欄位；讀不懂回 null（不猜） */
export function parseFeedDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = toPlainText(raw);
  if (!s) return null;
  // 民國年：115-09-28、115/9/28（南投縣）
  let m = /^(\d{2,3})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return twIso(Number(m[1]) + 1911, Number(m[2]), Number(m[3]));
  // 只有日期：2026-09-28、2026/09/28（新竹市）
  m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return twIso(Number(m[1]), Number(m[2]), Number(m[3]));
  // 沒帶時區的 ISO：2026-09-28T10:00:00
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}:\d{2}(?::\d{2})?)$/.exec(s);
  if (m) return twIso(Number(m[1]), Number(m[2]), Number(m[3]), m[4]);
  // 中文月份：週一, 28 九月 2026 00:00:00 +0800（彰化縣）
  m = /(\d{1,2})\s+([一二三四五六七八九十]{1,2})月\s+(\d{4})\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*([+-]\d{4}|GMT|UTC|Z)?/.exec(s);
  if (m) {
    const mo = CN_NUM[m[2]];
    if (!mo) return null;
    const tz = m[5];
    if (!tz || tz === "+0800") return twIso(Number(m[3]), mo, Number(m[1]), m[4]);
    const off = tz === "GMT" || tz === "UTC" || tz === "Z" ? "+00:00" : `${tz.slice(0, 3)}:${tz.slice(3)}`;
    const t = m[4].length === 5 ? `${m[4]}:00` : m[4];
    const ms = Date.parse(`${m[3]}-${String(mo).padStart(2, "0")}-${m[1].padStart(2, "0")}T${t.padStart(8, "0")}${off}`);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  // 其餘交給 Date.parse（RFC 822 的 pubDate、帶時區的 ISO）
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** 網址欄位：拆 CDATA、解 &amp;、去空白；不是 http(s) 就不要 */
export function cleanUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = decodeEntities(unwrapCdata(raw)).trim();
  return /^https?:\/\/\S+$/i.test(s) ? s : null;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function atomLink(block: string): string | null {
  // <link rel="alternate" href="…"/>；沒有 rel 的也算 alternate。rel="self"／"enclosure" 那種不是文章
  const re = /<link\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const attrs = m[1];
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!href) continue;
    const rel = /rel\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.toLowerCase();
    if (!rel || rel === "alternate") return cleanUrl(href);
  }
  return null;
}

function rssLink(block: string): string | null {
  const link = cleanUrl(firstTag(block, ["link"]));
  if (link) return link;
  // Yahoo 等少數來源 <link> 可能缺，guid 常常就是文章網址
  return cleanUrl(firstTag(block, ["guid"]));
}

/** 一則轉成 FeedItem；缺網址或標題就不要 */
function toItem(format: FeedFormat, block: string): FeedItem | null {
  let url: string | null, titleRaw: string | null, summaryRaw: string | null, dateRaw: string | null;
  if (format === "rss") {
    url = rssLink(block);
    titleRaw = firstTag(block, ["title", "dc:title"]);
    summaryRaw = firstTag(block, ["description", "content:encoded", "dc:description"]);
    dateRaw = firstTag(block, ["pubDate", "dc:date", "published", "updated"]);
  } else if (format === "atom") {
    url = atomLink(block);
    titleRaw = firstTag(block, ["title"]);
    summaryRaw = firstTag(block, ["summary", "content"]);
    dateRaw = firstTag(block, ["published", "updated"]);
  } else {
    url = cleanUrl(firstTag(block, ["loc"]));
    titleRaw = firstTag(block, ["news:title"]);
    summaryRaw = firstTag(block, ["news:keywords"]);
    dateRaw = firstTag(block, ["news:publication_date", "lastmod"]);
  }
  if (!url) return null;
  const title = titleRaw ? clip(toPlainText(titleRaw), TITLE_MAX) : "";
  if (!title) return null;
  const summary = summaryRaw ? clip(toPlainText(summaryRaw), SUMMARY_MAX) : "";
  return { url, title, summary: summary || null, published_at: parseFeedDate(dateRaw) };
}

/**
 * 同一個來源這麼多分鐘內抓過就跳過。news-fetch 不驗 JWT（讓 pg_cron 打得到），外人狂打的話，
 * 這條讓我們對每個來源的請求頻率最多 30 分鐘一次，不會替別人去灌爆縣市政府的網站。
 * 失敗也算「抓過」：一個掛掉的站不該被每分鐘重試。
 */
export const FETCH_COOLDOWN_MINUTES = 30;

export interface SourceLite { id: number; enabled: boolean; last_fetched_at: string | null }

/** 這一輪要抓哪些來源：啟用中、而且冷卻期已過（沒抓過的算已過） */
export function dueSources<T extends SourceLite>(sources: readonly T[], now: Date, cooldownMinutes = FETCH_COOLDOWN_MINUTES): T[] {
  const cutoff = now.getTime() - cooldownMinutes * 60_000;
  return sources.filter((s) => s.enabled && (!s.last_fetched_at || Date.parse(s.last_fetched_at) <= cutoff));
}

/**
 * 整份來源 → 要收的那幾則：過 path_filter、只留 maxAgeDays 天內（沒日期的照收）、同一份裡網址去重、最多 maxItems 則。
 * 不認得的格式回空陣列（呼叫端記 last_error）。
 */
export function parseFeed(xml: string, format: FeedFormat, opts: ParseOptions = {}): FeedItem[] {
  const tag = format === "rss" ? "item" : format === "atom" ? "entry" : "url";
  if (!FEED_FORMATS.includes(format)) return [];
  const now = (opts.now ?? new Date()).getTime();
  const maxAgeMs = (opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 86400_000;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const filter = opts.pathFilter?.trim() || null;
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const block of blocksOf(xml, tag)) {
    const it = toItem(format, block);
    if (!it) continue;
    if (filter && !it.url.includes(filter)) continue;
    if (it.published_at && now - Date.parse(it.published_at) > maxAgeMs) continue;
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    out.push(it);
    if (out.length >= maxItems) break;
  }
  return out;
}
