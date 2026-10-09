/**
 * 多個獨立來源降低目標分數（維護者 2026-10-09；工作單 Yooliang/policy-ops#39；裁決 policy-ops docs/decisions/2026-10-09-多個獨立來源降低目標分數.md）。
 *
 * 系統票（Jev 核對提交者附的來源）原本只出一個判定：前 3 個網址的正文併成一段，核得過＝目標 −1。
 * 現在最多看 4 個網址，挑出「獨立」的來源，在同一次 Jev 呼叫裡每個獨立來源各問一組欄位題；
 * 系統票本身（supported／not_supported／棄權）照舊由併起來那段決定，核得過的獨立來源數只決定 supported 時降幾分：
 *   1 個 −1（現行）、2 個以上 −2（上限），目標最低 1——系統票不算分數，所以永遠至少要一張別台機器的同意票。
 *
 * 「獨立」：
 *   - 不同網站：同一媒體的子網域算同一個（news.ltn.com.tw＝ec.ltn.com.tw），用 sole-source-guard.ts 的 siteOf，
 *     各縣市議會（tncc.gov.tw／kcc.gov.tw）是不同網站。
 *   - 不是同一篇轉載（中央社稿原文出現在 Yahoo、LINE TODAY）：主角名字附近的段落 3-gram 包含度 ≥ REPRINT_CONTAINMENT（見 sameArticle）。
 *   先出現的留下、後面跟它同站或同文的不算。
 */
import { siteOf } from "./sole-source-guard.ts";
import { aggregateFieldVerdicts, focusText, MIN_PROBABILITY, type FieldResult } from "./system-one.ts";

/** 最多看幾個來源網址 */
export const MAX_CHECKED_SOURCES = 4;
/** 獨立來源最多讓目標再降幾分（加上第一個的 −1，總共最多 −2） */
export const MAX_SOURCE_DISCOUNT = 2;

export interface IndependentPick {
  /** 算獨立的來源（依原順序） */
  independent: Array<{ url: string; site: string; host: string }>;
  /** 不算的與原因 */
  dropped: Array<{ url: string; reason: "same_site" | "reprint" | "no_text"; of?: string }>;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

/** 轉載判準：較短那段的 3-gram 有多少出現在另一段（包含度）。≥ 這個值＝同一篇 */
export const REPRINT_CONTAINMENT = 0.5;
/** 比對轉載時每頁取主角名字附近多少字（避開網站選單、頁尾；同 combineSources 的取段方式） */
export const REPRINT_EXCERPT = 1500;

/** 一段文字的 3-gram 雜湊（FNV-1a 32 位元）。正規化同 textSimilarity：去空白與標點 */
export function gramHashes(text: string): Set<number> {
  const n = text.replace(/\s+/g, "").replace(/[，。、：；！？「」『』（）()\[\]【】《》〈〉"'“”‘’—\-–·．]/g, "");
  const out = new Set<number>();
  for (let i = 0; i + 3 <= n.length; i++) {
    let h = 0x811c9dc5;
    for (const ch of n.slice(i, i + 3)) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
    out.add(h);
  }
  return out;
}

/** 包含度：較小那一組有多少在另一組裡（0～1） */
export function containment(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let hit = 0;
  for (const g of small) if (large.has(g)) hit++;
  return hit / small.size;
}

/**
 * 兩頁是不是同一篇（轉載）。2026-10-09 實測中央社原稿 vs Yahoo 轉載：整頁 Jaccard（textSimilarity）只有 0.279——
 * 轉載頁多了網站選單、相關新聞，Jaccard 被稀釋，0.5 抓不到；取主角名字附近 1,500 字算包含度是 0.613，
 * 同一題目的別家報導是 0.043。所以轉載用「名字附近的段落＋包含度」，不用整頁 Jaccard。
 */
export function sameArticle(a: string, b: string, names: Array<string | null | undefined>): boolean {
  return containment(gramHashes(focusText(a, names, REPRINT_EXCERPT)), gramHashes(focusText(b, names, REPRINT_EXCERPT))) >= REPRINT_CONTAINMENT;
}

/** 從抓到的頁裡挑獨立來源（只看有正文的；pages 照提交者給的順序；names＝主角名字，取比對段落用） */
export function pickIndependentSources(pages: ReadonlyArray<{ url: string; text: string }>, names: Array<string | null | undefined> = []): IndependentPick {
  const independent: Array<{ url: string; site: string; host: string; text: string }> = [];
  const dropped: IndependentPick["dropped"] = [];
  for (const p of pages) {
    if (!p.text || !p.text.trim()) { dropped.push({ url: p.url, reason: "no_text" }); continue; }
    const site = siteOf(p.url) ?? hostOf(p.url);
    const sameSite = independent.find((x) => x.site === site);
    if (sameSite) { dropped.push({ url: p.url, reason: "same_site", of: sameSite.url }); continue; }
    const reprint = independent.find((x) => sameArticle(x.text, p.text, names));
    if (reprint) { dropped.push({ url: p.url, reason: "reprint", of: reprint.url }); continue; }
    independent.push({ url: p.url, site, host: hostOf(p.url), text: p.text });
  }
  return { independent: independent.map(({ url, site, host }) => ({ url, site, host })), dropped };
}

/** 每個獨立來源一組欄位題：題名 src<i>:field:<欄位>，只看【來源 host】那一段 */
export function perSourceQuestionKey(i: number, field: string): string {
  return `src${i}:field:${field}`;
}

export interface PerSourceResult {
  url: string;
  host: string;
  choice: "supported" | "not_supported" | "cannot_tell";
  probability: number;
  fields: Record<string, FieldResult>;
}

/**
 * 各獨立來源的判定（跟併起來那段同一套規則：aggregateFieldVerdicts），與核得過的獨立來源數。
 * 只有一個獨立來源時不另外問，數量就是 1（系統票 supported 時）。
 */
export function aggregatePerSource(
  contributionType: string,
  claim: Record<string, unknown>,
  answers: Record<string, { choice: string; probabilities: Record<string, number> }>,
  sources: ReadonlyArray<{ url: string; host: string }>,
  minProbability = MIN_PROBABILITY,
): { per_source: PerSourceResult[]; supported_sources: number } {
  const per_source: PerSourceResult[] = sources.map((s, i) => {
    const mine: Record<string, { choice: string; probabilities: Record<string, number> }> = {};
    for (const k of Object.keys(claim)) {
      const a = answers[perSourceQuestionKey(i, k)];
      if (a) mine[`field:${k}`] = a;
    }
    const agg = aggregateFieldVerdicts(contributionType, claim, mine as never, minProbability);
    return { url: s.url, host: s.host, choice: agg.choice as PerSourceResult["choice"], probability: agg.probability, fields: agg.fields };
  });
  const supported_sources = per_source.filter((r) => r.choice === "supported" && r.probability >= minProbability).length;
  return { per_source, supported_sources };
}

/**
 * /next 驗證項 current.system_vote 的來源說明（jev_decisions.state.sources／supported_sources → 給代理看的欄位）。
 * 舊的系統票沒有這些資料＝回空物件（欄位不出現）。
 */
export function systemVoteSources(state: unknown, choice: unknown): Record<string, unknown> {
  const st = (state && typeof state === "object" ? state : {}) as Record<string, unknown>;
  const src = (st.sources && typeof st.sources === "object" ? st.sources : null) as Record<string, unknown> | null;
  if (!src) return {};
  const independent = Array.isArray(src.independent) ? src.independent : [];
  return {
    sources: {
      checked: Array.isArray(src.checked) ? src.checked : [],
      independent,
      dropped: Array.isArray(src.dropped) ? src.dropped : [],
      per_source: Array.isArray(src.per_source) ? src.per_source : [],
      ...(choice === "supported" ? { supported_independent: sourceDiscount(st.supported_sources as number | undefined) } : {}),
      rule: `最多核 ${MAX_CHECKED_SOURCES} 個網址；同一媒體的子網域、同一篇轉載只算一個；supported 時每個核得過的獨立來源讓目標降 1，最多降 ${MAX_SOURCE_DISCOUNT}，目標最低 1（仍要至少一張別台機器的同意票）`,
    },
  };
}

/** 系統票 supported 時記下的「核得過的獨立來源數」：至少 1（系統票本身就是一個）、最多 MAX_SOURCE_DISCOUNT */
export function sourceDiscount(supportedSources: number | null | undefined): number {
  const n = typeof supportedSources === "number" && Number.isFinite(supportedSources) ? Math.floor(supportedSources) : 1;
  return Math.min(MAX_SOURCE_DISCOUNT, Math.max(1, n));
}
