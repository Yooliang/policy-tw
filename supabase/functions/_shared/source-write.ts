/**
 * 出處第二階段 A 的寫入端（#347；維護者 2026-10-06 點頭；協議 1.62.0）：
 *   1. 交件可以帶 `source_details`（選填）：每個網址的等級與「本人來源」的認定根據。
 *   2. 落庫直接寫出處表（sources／source_refs），不只靠舊欄位的觸發器同步。
 *
 * 等級（source_kind）只有一個由交件決定：self（本人來源）。官方／媒體／其他永遠依網域判斷（跟 SQL 的
 * source_auto_kind 一致），交件說了別的也不報錯、照網域算。
 *
 * 本人來源（維護者 2026-10-05：臉書讀不到、不能當出處，「本人來源」只收打得開的本人官網、政黨刊載頁）：
 *   - 要附認定根據 self_evidence：linked_by_official（議會、選委會或政黨官網連結到這個網址）或 mutual_link（跟本人官網互相連結）
 *   - 網址不能是官方網域（本來就是官方來源）、不能是新聞媒體、不能是任何社群平台（臉書、IG、Threads 讀不到；
 *     YouTube、X、LINE、TikTok、Telegram 不是「本人官網」）
 *   - 資料庫另有一道 CHECK（sources_self_eligible，migration 20261006210000）：就算這裡漏了，社群也寫不成 self。
 *   - 平台認證（platform_verified）資料庫仍收、協議不收：平台認證只會出現在社群上。
 * 規則在 SQL 與 TS 各一份（source_self_eligible／SELF_INELIGIBLE_HOSTS），source-write.test.ts 盯兩邊一致。
 *
 * 不改計分：等級只是標籤與顯示，門檻表、計票、「媒體不能當唯一出處」守門都不看它。
 */

import { isHttpUrl, matchPrioritySource } from "./source-priority.ts";
import { UNREADABLE_SOCIAL_HOSTS } from "./lineage.ts";

export const SOURCE_KINDS = ["official", "self", "media", "other"] as const;
export type SourceLevel = (typeof SOURCE_KINDS)[number];

/** 協議收的認定根據（資料庫還收 platform_verified，協議不收） */
export const SELF_EVIDENCES = ["linked_by_official", "mutual_link"] as const;
export type SelfEvidence = (typeof SELF_EVIDENCES)[number];

export const SOURCE_TITLE_MAX = 200;
export const SOURCE_PUBLISHER_MAX = 100;

/**
 * 不能是「本人來源」的社群平台。跟 SQL 的 source_self_eligible() 同一份：
 * 讀不到的（臉書、IG、Threads——lineage.ts 的 UNREADABLE_SOCIAL_HOSTS）＋讀得到但不是本人官網的（YouTube、X、LINE、TikTok、Telegram）。
 */
export const SELF_INELIGIBLE_HOSTS = [
  ...UNREADABLE_SOCIAL_HOSTS,
  "youtube.com", "youtu.be", "x.com", "twitter.com", "tiktok.com", "line.me", "lin.ee", "t.me",
] as const;

function hostOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** 依網域自動判斷的等級（SQL source_auto_kind 的鏡像）：官方→official、媒體與社群→media、其餘→other；永遠不給 self */
export function autoSourceKind(url: string): Exclude<SourceLevel, "self"> {
  const kind = matchPrioritySource(url)?.kind;
  if (kind === "official") return "official";
  if (kind === "media" || kind === "social") return "media";
  return "other";
}

/** 這個網址不能當「本人來源」的原因；可以就回 null。跟 SQL source_self_eligible() 同一條 */
export function selfIneligibleReason(url: string): string | null {
  const host = hostOf(url);
  if (!host || !isHttpUrl(url)) return "不是 http(s) 網址";
  if ((SELF_INELIGIBLE_HOSTS as readonly string[]).some((h) => host === h || host.endsWith(`.${h}`))) {
    return "社群平台不能當本人來源（臉書、IG、Threads 讀不到，驗證者與系統都打不開；YouTube、X、LINE 等也不是本人官網）。本人來源只收打得開的本人官網、政黨刊載的本人頁面";
  }
  const auto = autoSourceKind(url);
  if (auto === "official") return "這是官方網站（中選會、立法院、*.gov.tw 等），本來就算官方來源，不用標本人來源";
  if (auto === "media") return "新聞媒體不是本人來源";
  return null;
}

export interface SourceDetail {
  url: string;
  kind?: SourceLevel;
  self_evidence?: SelfEvidence;
  title?: string;
  publisher?: string;
}

export interface SourceDetailProblem { path: string; message: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const charLen = (s: string): number => [...s].length;

/**
 * 交件的 source_details 驗證與正規化。
 * 每項 { url, kind?, self_evidence?, title?, publisher? }；url 要是這筆 source_urls 的其中一個（驗證者只會打開 source_urls）。
 * kind=self 一定要有 self_evidence、有 self_evidence 一定要 kind=self，而且網址要能當本人來源。
 * 其他 kind 值只要是四種之一就收，但伺服器照網域重判（sourceLevelNotice 會講）。
 */
export function parseSourceDetails(raw: unknown, sourceUrls: readonly string[]): { details: SourceDetail[]; problems: SourceDetailProblem[] } {
  const problems: SourceDetailProblem[] = [];
  if (raw === undefined || raw === null) return { details: [], problems };
  if (!Array.isArray(raw)) {
    return { details: [], problems: [{ path: "source_details", message: "source_details 要是陣列：[{url, kind, self_evidence, title, publisher}]" }] };
  }
  if (raw.length > sourceUrls.length) {
    problems.push({ path: "source_details", message: `source_details 不能比 source_urls 多（${raw.length}／${sourceUrls.length}）` });
  }
  const listed = new Set(sourceUrls.map((u) => u.trim()));
  const seen = new Set<string>();
  const details: SourceDetail[] = [];
  raw.forEach((item, i) => {
    const at = `source_details[${i}]`;
    if (!isObj(item)) { problems.push({ path: at, message: "每一項要是物件：{url, kind, self_evidence, title, publisher}" }); return; }
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (!url || !isHttpUrl(url)) { problems.push({ path: `${at}.url`, message: "url 要是 http(s) 網址" }); return; }
    if (!listed.has(url)) { problems.push({ path: `${at}.url`, message: "url 要是這筆 source_urls 的其中一個（驗證者只會打開 source_urls）" }); return; }
    if (seen.has(url)) { problems.push({ path: `${at}.url`, message: "同一個網址只能出現一次" }); return; }
    seen.add(url);

    const detail: SourceDetail = { url };
    if (item.kind !== undefined && item.kind !== null) {
      if (typeof item.kind !== "string" || !(SOURCE_KINDS as readonly string[]).includes(item.kind)) {
        problems.push({ path: `${at}.kind`, message: `kind 要是 ${SOURCE_KINDS.join("／")} 之一；伺服器依網域判斷等級，你只能主張 self（本人來源）` });
      } else detail.kind = item.kind as SourceLevel;
    }
    if (item.self_evidence !== undefined && item.self_evidence !== null) {
      if (item.self_evidence === "platform_verified") {
        problems.push({ path: `${at}.self_evidence`, message: "平台認證不收：平台認證只會出現在社群上，而社群（臉書、IG、Threads…）不能當本人來源。本人來源只收打得開的本人官網、政黨刊載的本人頁面" });
      } else if (typeof item.self_evidence !== "string" || !(SELF_EVIDENCES as readonly string[]).includes(item.self_evidence)) {
        problems.push({ path: `${at}.self_evidence`, message: "self_evidence 要是 linked_by_official（議會、選委會或政黨官網連結到這個網址）或 mutual_link（跟本人官網互相連結）" });
      } else detail.self_evidence = item.self_evidence as SelfEvidence;
    }
    if (detail.kind === "self") {
      if (!detail.self_evidence) problems.push({ path: `${at}.self_evidence`, message: "kind=self（本人來源）要附認定根據 self_evidence：linked_by_official 或 mutual_link；沒有根據的本人帳號一律算媒體（防冒名）" });
      const why = selfIneligibleReason(url);
      if (why) problems.push({ path: `${at}.kind`, message: `${url} 不能標成本人來源：${why}` });
    } else if (detail.self_evidence) {
      problems.push({ path: `${at}.self_evidence`, message: "self_evidence 只在 kind=self 時填" });
    }
    for (const [key, max] of [["title", SOURCE_TITLE_MAX], ["publisher", SOURCE_PUBLISHER_MAX]] as const) {
      const v = item[key];
      if (v === undefined || v === null || v === "") continue;
      if (typeof v !== "string" || charLen(v.trim()) < 1 || charLen(v.trim()) > max) problems.push({ path: `${at}.${key}`, message: `${key} 要是 1～${max} 字` });
      else detail[key] = v.trim();
    }
    details.push(detail);
  });
  return { details, problems };
}

/** source_details 驗過才存進 payload（落庫時讀）；代理自己在 payload 裡放的不收，免得繞過上面的驗證 */
export function payloadSourceDetailsProblems(payload: unknown): SourceDetailProblem[] {
  if (!isObj(payload) || payload.source_details === undefined) return [];
  return [{ path: "payload.source_details", message: "source_details 要放在跟 source_urls 同一層（每筆 contribution 的最上層），不是 payload 裡面" }];
}

/** 交件說的等級跟伺服器依網域判斷的不一樣（self 以外）：回一句話告訴代理，不報錯 */
export function sourceLevelNotice(details: readonly SourceDetail[]): string {
  const diff = details.filter((d) => d.kind && d.kind !== "self" && d.kind !== autoSourceKind(d.url));
  if (diff.length === 0) return "";
  return `出處等級由伺服器依網域判斷（官方、媒體、其他），你只能主張 self（本人來源）：${diff.map((d) => `${d.url} 記為 ${autoSourceKind(d.url)}`).join("；")}`;
}

/** 一筆交件的 payload 裡存的 source_details（落庫時讀）；格式不對的略過 */
export function detailsOfPayload(payload: unknown, sourceUrls: readonly string[]): SourceDetail[] {
  if (!isObj(payload) || !Array.isArray(payload.source_details)) return [];
  return parseSourceDetails(payload.source_details, sourceUrls).details;
}

/** 送給資料庫 source_write() 的清單：照 source_urls 的順序，每個網址帶上它的 source_details（有的話）；沒有 http(s) 網址的略過 */
export function sourcesForWrite(sourceUrls: readonly string[], details: readonly SourceDetail[]): SourceDetail[] {
  const byUrl = new Map(details.map((d) => [d.url, d]));
  const seen = new Set<string>();
  const out: SourceDetail[] = [];
  for (const raw of sourceUrls) {
    const url = typeof raw === "string" ? raw.trim() : "";
    if (!url || seen.has(url) || !isHttpUrl(url)) continue;
    seen.add(url);
    out.push({ ...(byUrl.get(url) ?? { url }), url });
  }
  return out;
}

/** 這個型別落庫後，出處要掛到哪一筆資料上；其他型別（或拿不到 id）回 null＝只補等級 */
export function sourceTargetFor(
  contributionType: string,
  outcome: { policy_id?: string; tracking_log_id?: string; politician_election_id?: string | number },
): { table: "policies" | "tracking_logs" | "politician_elections"; id: string } | null {
  if (contributionType === "policy" && outcome.policy_id) return { table: "policies", id: String(outcome.policy_id) };
  if (contributionType === "policy_progress" && outcome.tracking_log_id) return { table: "tracking_logs", id: String(outcome.tracking_log_id) };
  if (contributionType === "candidacy" && outcome.politician_election_id !== undefined && outcome.politician_election_id !== null) {
    return { table: "politician_elections", id: String(outcome.politician_election_id) };
  }
  return null;
}

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

/**
 * 落庫成功後直接寫出處表（政見、進度、參選紀錄掛引用；任何型別都補等級）。
 * 失敗只記 log、不回頭影響落庫：舊欄位的觸發器已經把主要出處同步過了，缺的只是佐證與等級，漏掉的看 source_refs_drift。
 * 回傳寫了幾個網址（測試與記錄用）。
 */
export async function writeSourcesAfterApply(
  supabase: SupabaseLike,
  row: { contribution_type: string; payload: unknown; source_urls: readonly string[] },
  outcome: { policy_id?: string; tracking_log_id?: string; politician_election_id?: string | number },
): Promise<number> {
  const urls = Array.isArray(row.source_urls) ? row.source_urls : [];
  const list = sourcesForWrite(urls, detailsOfPayload(row.payload, urls));
  if (list.length === 0) return 0;
  const target = sourceTargetFor(row.contribution_type, outcome);
  // 沒有目標、也沒有任何等級要補：不用打資料庫
  if (!target && !list.some((s) => s.kind === "self")) return 0;
  try {
    const { error } = await supabase.rpc("source_write", {
      p_target_table: target?.table ?? null,
      p_target_id: target?.id ?? null,
      p_sources: list,
      p_origin: "contribution",
    });
    if (error) {
      console.error(`source_write（${row.contribution_type}）失敗：${error.message}`);
      return 0;
    }
    return list.length;
  } catch (e) {
    console.error(`source_write（${row.contribution_type}）例外：${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}
