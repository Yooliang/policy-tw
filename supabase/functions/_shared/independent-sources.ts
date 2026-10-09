/**
 * 多個獨立來源降低目標分數（維護者 2026-10-09；工作單 Yooliang/policy-ops#39；裁決 policy-ops docs/decisions/2026-10-09-多個獨立來源降低目標分數.md）。
 *
 * 系統票（Jev 核對提交者附的來源）原本只出一個判定：前 3 個網址的正文併成一段，核得過＝目標 −1。
 * 現在最多看 4 個網址，挑出「獨立」的來源，在同一次 Jev 呼叫裡每個獨立來源各問一組欄位題；
 * 系統票本身（supported／not_supported／棄權）照舊由併起來那段決定，核得過的獨立來源數只決定 supported 時降幾分：
 *   1 個 −1（現行）、2 個以上 −2（上限），目標最低 1——系統票不算分數，所以永遠至少要一張別台機器的同意票。
 *   任一獨立來源明確矛盾（過門檻）→ not_supported（+1）：多附來源只能多降分，不能把反證蓋掉。
 *
 * 「獨立」（寧可少算，不可多算）：
 *   - 看來源屬性，不只網域（主線審查 #544 第 1 點）：官方與媒體照網站分；**社群（臉書／IG／Threads／YouTube／X）與其他網站
 *     （候選人官網多半在這一類）合併最多算一個**——本人官網加本人臉書不能算兩個獨立來源（sole-source-guard「本人來源只算一個」）。
 *   - 同一網站：同一媒體的子網域算一個（news.ltn.com.tw＝ec.ltn.com.tw，sole-source-guard.ts 的 siteOf），
 *     同一媒體集團的不同網域也算一個（MEDIA_GROUPS：yahoo.com.tw＝yahoo.com、focustaiwan.tw＝cna.com.tw）。
 *   - 不是同一篇轉載：見 sameArticle。比不出來（沒有主角名字可對段落）的頁不算額外的獨立來源。
 *   先出現的留下、後面跟它同組或同文的不算。
 * 每個獨立來源要算「核得過」，除了 Jev 那一組欄位題都 confirmed 過門檻，**那一頁的正文也要真的有主角名字**（nameHit，決定性檢查，第 2 點）。
 */
import { siteOf, unwrapArchiveUrl } from "./sole-source-guard.ts";
import { sourceKind } from "./source-priority.ts";
import { aggregateFieldVerdicts, focusText, MIN_PROBABILITY, nameHit, type FieldResult, type JevQuestion } from "./system-one.ts";

/** 最多看幾個來源網址 */
export const MAX_CHECKED_SOURCES = 4;
/** 獨立來源最多讓目標再降幾分（加上第一個的 −1，總共最多 −2） */
export const MAX_SOURCE_DISCOUNT = 2;
/** 逐來源題的總數上限（correction 一筆可能改很多欄：欄位數 × 來源數超過就少問幾個來源，問不到 2 個就不問，主線審查第 5 點） */
export const MAX_PER_SOURCE_QUESTIONS = 24;

/** 同一媒體集團、不同網域：算同一個網站 */
export const MEDIA_GROUPS: Readonly<Record<string, string>> = {
  "yahoo.com.tw": "yahoo.com",
  "focustaiwan.tw": "cna.com.tw",
};
/** 社群與其他網站合併成的那一組 */
export const SELF_OR_OTHER_GROUP = "self_or_other";
/**
 * source-priority.ts 媒體清單以外、也照網站分的新聞網站（網站＝siteOf 的結果；同集團用 MEDIA_GROUPS 併一）。
 * 不在這裡也不在媒體清單的網站，一律跟社群、本人官網併成一組——認不出是不是本人的網站，就寧可少算（主線審查 #544 第 1 點）。
 */
export const EXTRA_NEWS_SITES: ReadonlySet<string> = new Set([
  "yahoo.com", "focustaiwan.tw", "line.me", "mirrormedia.mg", "nownews.com", "cts.com.tw", "ttv.com.tw", "ebc.net.tw",
  "thenewslens.com", "businesstoday.com.tw", "cnyes.com", "ctee.com.tw", "ctwant.com", "tvbs.com.tw", "bnext.com.tw",
]);

export interface IndependentPick {
  /** 算獨立的來源（依原順序） */
  independent: Array<{ url: string; site: string; host: string }>;
  /** 不算的與原因 */
  dropped: Array<{ url: string; reason: "same_site" | "reprint" | "no_text" | "unverifiable"; of?: string }>;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

/** 這個來源屬於哪一組：官方、媒體照網站（媒體集團併一），社群與其他網站併成一組 */
export function sourceGroupOf(url: string): string {
  const site = siteOf(url) ?? hostOf(url);
  const grouped = MEDIA_GROUPS[site] ?? site;
  const kind = sourceKind(unwrapArchiveUrl(url));
  if (kind === "official" || kind === "media") return grouped;
  if (kind === "other" && (EXTRA_NEWS_SITES.has(site) || EXTRA_NEWS_SITES.has(grouped))) return grouped;
  return SELF_OR_OTHER_GROUP;
}

/** 轉載判準：A 的段落有多少出現在 B 的全文裡（兩個方向取大的）≥ 這個值＝同一篇 */
export const REPRINT_CONTAINMENT = 0.5;
/** 比對轉載時每頁取主角名字附近多少字（避開網站選單、頁尾；同 combineSources 的取段方式） */
export const REPRINT_EXCERPT = 1500;
/** 比對用的字串長度（n-gram）。8 字：真轉載 0.625／0.964，同題別家報導 0.003／0.204，同站兩篇不同報導 0.335（2026-10-09 實測） */
export const REPRINT_GRAM = 8;

/** 一段文字的 n-gram 雜湊（FNV-1a 32 位元）。正規化同 textSimilarity：去空白與標點 */
export function gramHashes(text: string, n = REPRINT_GRAM): Set<number> {
  const s = text.replace(/\s+/g, "").replace(/[，。、：；！？「」『』（）()\[\]【】《》〈〉"'“”‘’—\-–·．]/g, "");
  const out = new Set<number>();
  for (let i = 0; i + n <= s.length; i++) {
    let h = 0x811c9dc5;
    for (const ch of s.slice(i, i + n)) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
    out.add(h);
  }
  return out;
}

/** a 有多少在 b 裡（0～1；a 空＝0） */
export function coveredBy(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  if (a.size === 0) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / a.size;
}

/** 轉載程度：A 的段落在 B 全文裡的比例、B 的段落在 A 全文裡的比例，取大的 */
export function reprintScore(a: { excerpt: ReadonlySet<number>; full: ReadonlySet<number> }, b: { excerpt: ReadonlySet<number>; full: ReadonlySet<number> }): number {
  return Math.max(coveredBy(a.excerpt, b.full), coveredBy(b.excerpt, a.full));
}

/** 主角名字（≥ 2 字）有沒有可用的；沒有就比不出轉載 */
export function usableNames(names: ReadonlyArray<string | null | undefined>): string[] {
  return names.filter((n): n is string => typeof n === "string" && n.trim().length >= 2);
}

/**
 * 兩頁是不是同一篇（轉載）。2026-10-09 實測：中央社原稿 vs Yahoo 轉載，整頁 Jaccard（textSimilarity）只有 0.279，0.5 抓不到——
 * 轉載頁多了網站選單、相關新聞、廣告。改成「一頁主角名字附近的段落，有多少原樣出現在另一頁的全文裡」（8 字一組）。
 * 沒有主角名字可對段落時回 null（比不出來）。
 */
export function sameArticle(a: string, b: string, names: ReadonlyArray<string | null | undefined>): boolean | null {
  const ns = usableNames(names);
  if (ns.length === 0) return null;
  const sig = (t: string) => ({ excerpt: gramHashes(focusText(t, ns, REPRINT_EXCERPT)), full: gramHashes(t) });
  return reprintScore(sig(a), sig(b)) >= REPRINT_CONTAINMENT;
}

/** 從抓到的頁裡挑獨立來源（只看有正文的；pages 照提交者給的順序；names＝主角名字，取比對段落用） */
export function pickIndependentSources(pages: ReadonlyArray<{ url: string; text: string }>, names: ReadonlyArray<string | null | undefined> = []): IndependentPick {
  const independent: Array<{ url: string; site: string; host: string; text: string }> = [];
  const dropped: IndependentPick["dropped"] = [];
  for (const p of pages) {
    if (!p.text || !p.text.trim()) { dropped.push({ url: p.url, reason: "no_text" }); continue; }
    const site = sourceGroupOf(p.url);
    const sameSite = independent.find((x) => x.site === site);
    if (sameSite) { dropped.push({ url: p.url, reason: "same_site", of: sameSite.url }); continue; }
    if (independent.length > 0) {
      // 比不出轉載（沒有主角名字）就不算額外的獨立來源：第一個照算，之後的都不算（主線審查第 3 點）
      const verdicts = independent.map((x) => ({ x, same: sameArticle(x.text, p.text, names) }));
      if (verdicts.some((v) => v.same === null)) { dropped.push({ url: p.url, reason: "unverifiable" }); continue; }
      const reprint = verdicts.find((v) => v.same === true);
      if (reprint) { dropped.push({ url: p.url, reason: "reprint", of: reprint.x.url }); continue; }
    }
    independent.push({ url: p.url, site, host: hostOf(p.url), text: p.text });
  }
  return { independent: independent.map(({ url, site, host }) => ({ url, site, host })), dropped };
}

/** 每個獨立來源一組欄位題：題名 src<i>:field:<欄位>，只看【來源 host】那一段 */
export function perSourceQuestionKey(i: number, field: string): string {
  return `src${i}:field:${field}`;
}

/** 要逐來源問幾個來源：欄位數 × 來源數不超過 MAX_PER_SOURCE_QUESTIONS；不到 2 個就不問（0） */
export function perSourceCount(fieldCount: number, sourceCount: number): number {
  if (fieldCount <= 0 || sourceCount < 2) return 0;
  const n = Math.min(sourceCount, MAX_CHECKED_SOURCES, Math.floor(MAX_PER_SOURCE_QUESTIONS / fieldCount));
  return n >= 2 ? n : 0;
}

/** 逐來源的題目：把併起來那段的欄位題複製一份，加上「只看這一段」 */
export function perSourceQuestions(questions: Record<string, JevQuestion>, sources: ReadonlyArray<{ host: string }>): Record<string, JevQuestion> {
  const out: Record<string, JevQuestion> = {};
  sources.forEach((s, i) => {
    for (const [k, q] of Object.entries(questions)) {
      if (!k.startsWith("field:")) continue;
      out[perSourceQuestionKey(i, k.slice("field:".length))] = { ...q, instructions: `${q.instructions} 這一題只看【來源 ${s.host}】那一段，其他來源的文字不算。` };
    }
  });
  return out;
}

export interface PerSourceResult {
  url: string;
  host: string;
  choice: "supported" | "not_supported" | "cannot_tell";
  probability: number;
  /** 那一頁的正文有沒有主角名字（決定性檢查；沒有就不算核得過） */
  name_hit: boolean;
  fields: Record<string, FieldResult>;
}

type Answers = Record<string, { choice: string; probabilities: Record<string, number> }>;

/**
 * 系統票的最終判定（純函式；system-one precheck 用它，測試也直接打它）：
 *   - 併起來那段的判定（aggregateFieldVerdicts）是底；
 *   - 有逐來源題時，任一來源 not_supported 過門檻 → not_supported（機率取最大）；
 *   - supported 時記核得過的獨立來源數：該來源欄位題 supported 過門檻、**而且那一頁正文有主角名字**；至少 1。
 */
export function systemVoteFromAnswers(input: {
  contributionType: string;
  claim: Record<string, unknown>;
  answers: Answers;
  /** 有逐來源題的那幾個來源（順序＝題號）；沒有逐來源題就空陣列 */
  asked: ReadonlyArray<{ url: string; host: string; text: string }>;
  names: ReadonlyArray<string | null | undefined>;
  minProbability?: number;
}): { choice: "supported" | "not_supported" | "cannot_tell"; probability: number; fields: Record<string, FieldResult>; per_source: PerSourceResult[]; supported_sources: number | null } {
  const min = input.minProbability ?? MIN_PROBABILITY;
  const agg = aggregateFieldVerdicts(input.contributionType, input.claim, input.answers as never, min);
  const per_source: PerSourceResult[] = input.asked.map((s, i) => {
    const mine: Answers = {};
    for (const k of Object.keys(input.claim)) {
      const a = input.answers[perSourceQuestionKey(i, k)];
      if (a) mine[`field:${k}`] = a;
    }
    const r = aggregateFieldVerdicts(input.contributionType, input.claim, mine as never, min);
    return { url: s.url, host: s.host, choice: r.choice as PerSourceResult["choice"], probability: r.probability, name_hit: nameHit(s.text, [...input.names]), fields: r.fields };
  });
  const contra = per_source.filter((r) => r.choice === "not_supported" && r.probability >= min);
  const choice = contra.length > 0 ? "not_supported" : agg.choice as "supported" | "not_supported" | "cannot_tell";
  const probability = contra.length > 0
    ? Math.max(agg.choice === "not_supported" ? agg.probability : 0, ...contra.map((r) => r.probability))
    : agg.probability;
  const ok = per_source.filter((r) => r.choice === "supported" && r.probability >= min && r.name_hit).length;
  return { choice, probability, fields: agg.fields, per_source, supported_sources: choice === "supported" ? Math.max(1, ok) : null };
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
      rule: `最多核 ${MAX_CHECKED_SOURCES} 個網址；同一媒體（含子網域、同集團）、同一篇轉載只算一個，社群與其他網站（含本人官網）合起來也只算一個；` +
        `supported 時每個核得過的獨立來源讓目標降 1，最多降 ${MAX_SOURCE_DISCOUNT}，目標最低 1（仍要至少一張別台機器的同意票）`,
    },
  };
}

/** 系統票 supported 時記下的「核得過的獨立來源數」：至少 1（系統票本身就是一個）、最多 MAX_SOURCE_DISCOUNT */
export function sourceDiscount(supportedSources: number | null | undefined): number {
  const n = typeof supportedSources === "number" && Number.isFinite(supportedSources) ? Math.floor(supportedSources) : 1;
  return Math.min(MAX_SOURCE_DISCOUNT, Math.max(1, n));
}
