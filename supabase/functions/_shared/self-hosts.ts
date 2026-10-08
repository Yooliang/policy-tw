/**
 * 正見自己的網域清單（issue #486，協議 1.84.0，2026-10-09）。
 *
 * 出處不得引用正見自己：代理若拿正見網站（人物頁、/data、/skill.md、API）當出處，會變成循環引用——
 * 看起來有來源，其實是自己引自己，沒有獨立查證。交件（contribute）與驗證（verify 的 evidence_url）
 * 一律擋下（422 `self_citation`，不算被拒）；系統票（system-one）核來源時也不把這類網址當支持證據。
 *
 * 清單只放網域（含子網域），不分路徑：整個網站都算，不必逐條列 /data、/skill 等。
 * 比對一律用解析後的主機名稱（URL 會把中文網域轉成 punycode、轉小寫），所以 正見.tw 與 xn--2lw665d.tw 是同一個。
 * 日本站（policy_jp，前台 policy-jp.web.app）也列進來：兩站互引一樣是循環。
 */

import { normalizeCorrection } from "./correction.ts";
import { unwrapArchiveUrl } from "./sole-source-guard.ts";

/** 正見自己的網域（含其子網域）。 */
export const SELF_HOSTS = [
  "xn--2lw665d.tw", // 正見.tw
  "policy-tw.web.app",
  "policy-tw.firebaseapp.com",
  "policy-jp.web.app", // 日本站前台
  "policy-jp.firebaseapp.com",
  "wiiqoaytpqvegtknlbue.supabase.co", // 正見的 API（Edge Function、REST）
] as const;

export const SELF_CITATION_MESSAGE = "出處不可引用正見本身（含日本站）：用自己整理的資料或正見網站當出處是循環引用。請改附原始出處（官方公告、中選會、議會紀錄、媒體報導、本人官網）";

/** 網址的主機名稱（小寫、去結尾點）；存檔網址取原網址；不是 http(s) 網址回 null */
function hostOfUrl(url: string): string | null {
  try {
    const u = new URL(unwrapArchiveUrl(url.trim()));
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** 這個網址是不是正見自己的（網域本身或子網域；policy-tw-foo.web.app 之類的相似網域不算）。 */
export function isSelfCitationUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const host = hostOfUrl(url);
  if (!host) return false;
  return SELF_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** 第二來源核對（system-one action=evidence）：票附的 evidence_url 是正見自己 → 不抓、不採信（verdict self_citation、judge_backed=false）；否則 null */
export function selfCitationEvidenceVerdict(evidenceUrl: unknown): { verdict: "self_citation"; backed: false } | null {
  return isSelfCitationUrl(evidenceUrl) ? { verdict: "self_citation", backed: false } : null;
}

/** 清單裡屬於正見自己的網址（原樣回傳，保留順序，不去重） */
export function selfCitationUrls(urls: readonly unknown[]): string[] {
  return urls.filter((u): u is string => typeof u === "string" && isSelfCitationUrl(u));
}

/**
 * 整批交件裡的自我引用：看 source_urls、no_change／adjudication 用來當來源的 payload.checked_urls，
 * 以及 correction 改 policies.source_url 的新值（同 search-page-guard 的作法）。
 * 回傳每個有問題的位置：index、實際路徑 path、該處的網址。
 */
export function selfCitationProblems(items: ReadonlyArray<{ source_urls?: unknown; payload?: unknown; contribution_type?: unknown }>): Array<{ index: number; path: string; urls: string[] }> {
  const out: Array<{ index: number; path: string; urls: string[] }> = [];
  items.forEach((item, index) => {
    const add = (path: string, list: readonly unknown[]) => {
      const bad = [...new Set(selfCitationUrls(list))];
      if (bad.length > 0) out.push({ index, path, urls: bad });
    };
    const p = item.payload as Record<string, unknown> | null | undefined;
    // no_change／adjudication 沒給 source_urls 時，驗證端把 checked_urls 抄成 source_urls：已在 checked_urls 回報的網址不再算在 source_urls
    const checked = p && typeof p === "object" && Array.isArray(p.checked_urls) ? p.checked_urls : [];
    const checkedBad = new Set(selfCitationUrls(checked));
    if (Array.isArray(item.source_urls)) add("source_urls", item.source_urls.filter((u) => !(typeof u === "string" && checkedBad.has(u))));
    if (!p || typeof p !== "object") return;
    if (checked.length > 0) add("payload.checked_urls", checked);
    if (item.contribution_type === "correction") {
      normalizeCorrection(p).changes.forEach((c, j) => {
        if (c.field === "source_url") add(Array.isArray(p.changes) ? `payload.changes[${j}].correct_value` : "payload.correct_value", [c.correct_value]);
      });
    }
  });
  return out;
}
