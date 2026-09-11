/**
 * 來源優先等級（建議，不是限制）。
 *
 * 2026-09-12 小良哥裁示：不設白名單。伺服器只驗 source_urls 至少一個、每個都是可打開的 http(s) 網址，
 * 不比對 host。這份清單只用來標記「優先來源」等級（/next 派工排序、審核頁顯示），不擋提交。
 * 壞來源的過濾機制是同儕驗證：來源不可信或打不開 → 投 disagree，兩票即 disputed。
 * public/skill.md 第 3 節手寫同步，改這裡要一起改。
 */

export type SourceKind = "official" | "media" | "social" | "other";

export interface PrioritySource {
  host: string;
  label: string;
  kind: Exclude<SourceKind, "other">;
}

export const SOURCE_PRIORITY: readonly PrioritySource[] = [
  // 官方（最優先）
  { host: "cec.gov.tw", label: "中央選舉委員會（含 db.cec.gov.tw 選舉資料庫）", kind: "official" },
  { host: "ly.gov.tw", label: "立法院（法律系統、公報、議事錄）", kind: "official" },
  { host: "gov.tw", label: "各級政府與議會官網（*.gov.tw）", kind: "official" },
  { host: "gov.taipei", label: "台北市政府與所屬機關", kind: "official" },
  { host: "judicial.gov.tw", label: "司法院", kind: "official" },
  // 媒體
  { host: "cna.com.tw", label: "中央通訊社", kind: "media" },
  { host: "pts.org.tw", label: "公共電視", kind: "media" },
  { host: "twreporter.org", label: "報導者", kind: "media" },
  { host: "rti.org.tw", label: "中央廣播電臺", kind: "media" },
  { host: "udn.com", label: "聯合新聞網", kind: "media" },
  { host: "ltn.com.tw", label: "自由時報", kind: "media" },
  { host: "chinatimes.com", label: "中時新聞網", kind: "media" },
  { host: "storm.mg", label: "風傳媒", kind: "media" },
  { host: "cw.com.tw", label: "天下雜誌", kind: "media" },
  { host: "upmedia.mg", label: "上報", kind: "media" },
  { host: "newtalk.tw", label: "新頭殼", kind: "media" },
  { host: "ftvnews.com.tw", label: "民視新聞", kind: "media" },
  { host: "tvbs.com.tw", label: "TVBS 新聞", kind: "media" },
  { host: "ettoday.net", label: "ETtoday 新聞雲", kind: "media" },
  { host: "setn.com", label: "三立新聞網", kind: "media" },
  // 候選人官方社群
  { host: "facebook.com", label: "Facebook（候選人／競選辦公室官方帳號）", kind: "social" },
  { host: "instagram.com", label: "Instagram（候選人官方帳號）", kind: "social" },
  { host: "threads.net", label: "Threads（候選人官方帳號）", kind: "social" },
  { host: "youtube.com", label: "YouTube（候選人官方頻道）", kind: "social" },
  { host: "x.com", label: "X／Twitter（候選人官方帳號）", kind: "social" },
] as const;

const KIND_RANK: Record<SourceKind, number> = { official: 3, media: 2, social: 1, other: 0 };

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** 是否為可打開的 http(s) 網址（唯一會擋提交的檢查） */
export function isHttpUrl(url: unknown): url is string {
  return typeof url === "string" && hostOf(url) !== null;
}

export function matchPrioritySource(url: string): PrioritySource | null {
  const host = hostOf(url);
  if (!host) return null;
  return SOURCE_PRIORITY.find((s) => host === s.host || host.endsWith(`.${s.host}`)) ?? null;
}

export function sourceKind(url: string): SourceKind {
  return matchPrioritySource(url)?.kind ?? "other";
}

/** 一組來源的最高等級（派工排序、審核頁顯示用） */
export function bestSourceKind(urls: readonly string[]): SourceKind {
  return urls.map(sourceKind).reduce<SourceKind>((best, k) => (KIND_RANK[k] > KIND_RANK[best] ? k : best), "other");
}

export function sourceRank(kind: SourceKind): number {
  return KIND_RANK[kind];
}

export interface SourceCheck {
  ok: boolean;
  details: Array<{ url: string; kind: SourceKind | "invalid" }>;
  reason?: string;
}

/** 提交時的來源檢查：至少一個、全部是 http(s)；不比對 host。 */
export function checkSourceSet(urls: readonly string[]): SourceCheck {
  const details = urls.map((url) => ({ url, kind: isHttpUrl(url) ? sourceKind(url) : ("invalid" as const) }));
  if (details.length === 0) return { ok: false, details, reason: "source_urls 至少要一個可打開的來源網址" };
  if (details.some((d) => d.kind === "invalid")) return { ok: false, details, reason: "source_urls 含無法解析或非 http(s) 的網址" };
  return { ok: true, details };
}
