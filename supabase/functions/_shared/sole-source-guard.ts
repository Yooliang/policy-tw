/**
 * 「媒體不能當唯一出處」的交件守門（issue #347 第 3 項；協議 1.45.0，2026-10-05）。
 *
 * 規則：政見（policy）與政見進度（policy_progress）的 source_urls 裡沒有官方來源時，
 * 要有至少兩個**不同網站**的來源。只有一篇新聞報導、或只有一則社群貼文，交件就退回 400
 * （`single_non_official_source`，不算被拒），請代理補第二個來源或改附官方來源。
 *
 * 為什麼在交件端、不在票數門檻：
 *   - 門檻表（SQL contribution_required_agree 與 TS AGREE_THRESHOLDS）2026-09-21 起不分來源等級一律 3，
 *     三張 +1 同意票就上線，擋得住量、擋不住「整筆只建立在一篇報導上」——三個驗證者打開的是同一篇。
 *   - 改成「上線前要有一張系統核過第二來源的票」得同時改 SQL 計票、驗證池、/queue 預覽與 TS 鏡像四處，
 *     而且達標卻缺第二來源的案子會卡在池外（09-23 高風險型別單一 IP 那次的同一種病）。
 *   - 交件那一刻代理手上正在查這件事，補一個來源的成本最低；這是 1.39.0／1.40.0 以來
 *     「交件時就擋、不算被拒、講清楚要補什麼」的同一種做法。門檻表、計票、驗證流程都不動。
 *
 * 等級沿用 source-priority.ts 的網域清單（官方＝中選會、立法院、*.gov.tw…；首頁一律不算官方）。
 * 本人官網、本人社群目前也只能算一個來源：本人來源要有認定根據才成立（#347 的 self 等級），
 * 交件帶認定根據是第二階段的事，在那之前候選人臉書要再配一個不同網站的來源。
 *
 * web.archive.org 的存檔網址照「原網址」判斷：同一篇報導的原文加存檔不算兩個來源。
 */

import { sourceKind, type SourceKind } from "./source-priority.ts";

export const SOLE_SOURCE_GUARDED_TYPES = ["policy", "policy_progress"] as const;
/** 沒有官方來源時，至少要幾個不同網站 */
export const MIN_DISTINCT_SITES_WITHOUT_OFFICIAL = 2;

/** web.archive.org/web/<時間>[修飾]/<原網址> → 原網址；不是存檔網址就原樣回傳 */
export function unwrapArchiveUrl(url: string): string {
  const m = /^https?:\/\/web\.archive\.org\/web\/\d{1,14}[a-z_]{0,4}\/(.+)$/i.exec(url.trim());
  if (!m) return url.trim();
  const inner = m[1];
  return /^https?:\/\//i.test(inner) ? inner : `http://${inner}`;
}

/** 這些第二層網域底下，網站是「再往前一層」：ltn.com.tw、tncc.gov.tw、bbc.co.uk */
const SECOND_LEVEL = new Set(["com", "org", "gov", "net", "edu", "idv", "mil", "co", "ac", "or", "ne", "go"]);

/**
 * 網址屬於哪個網站：news.ltn.com.tw 與 ec.ltn.com.tw 是同一個（ltn.com.tw）；
 * tncc.gov.tw 與 kcc.gov.tw 是兩個（各縣市議會）；m.facebook.com 與 facebook.com 是同一個。
 * 解析不出來回 null。
 */
export function siteOf(url: string): string | null {
  let host: string;
  try {
    const u = new URL(unwrapArchiveUrl(url));
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    host = u.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  if (/^\d+(\.\d+){3}$/.test(host)) return host;
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const take = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return labels.slice(-take).join(".");
}

export interface SoleSourceProblem {
  index: number;
  contribution_type: string;
  sources: Array<{ url: string; kind: SourceKind; site: string | null }>;
  sites: number;
  message: string;
}

/**
 * 這一筆是不是「沒有官方來源、而且只有一個網站」。是就回問題描述，否則 null。
 * 不在守門範圍的型別、沒有任何可解析網址的（格式驗證會先擋）一律放行。
 */
export function soleSourceProblem(index: number, contributionType: string, sourceUrls: readonly string[] | null | undefined): SoleSourceProblem | null {
  if (!(SOLE_SOURCE_GUARDED_TYPES as readonly string[]).includes(contributionType)) return null;
  const urls = (sourceUrls ?? []).filter((u): u is string => typeof u === "string" && u.trim().length > 0);
  const sources = urls.map((url) => ({ url, kind: sourceKind(unwrapArchiveUrl(url)), site: siteOf(url) }));
  if (sources.every((s) => s.site === null)) return null;
  if (sources.some((s) => s.kind === "official")) return null;
  const sites = new Set(sources.map((s) => s.site).filter((s): s is string => s !== null)).size;
  if (sites >= MIN_DISTINCT_SITES_WITHOUT_OFFICIAL) return null;
  const what = contributionType === "policy" ? "政見" : "政見進度";
  return {
    index,
    contribution_type: contributionType,
    sources,
    sites,
    message: `第 ${index + 1} 筆（${what}）只有一個網站的來源，而且不是官方來源。媒體報導、社群貼文不能當唯一出處：` +
      `請再附一個不同網站、同樣寫到這件事的來源（另一家媒體、候選人官網或臉書、政黨候選人頁、READr），` +
      `或改附官方來源（選舉公報、中選會、政府或議會網站）。同一篇的 web.archive.org 存檔不算第二個來源。這不算被拒，補好重送即可。`,
  };
}

/** 任務說明裡的同一句話（task-guidance.ts 的政見類任務都接這句；交件守門與協議 §2 第 1a 條講的是同一條規則） */
export const SOLE_SOURCE_TASK_NOTE =
  "**媒體不能當唯一出處**（協議 1.45.0）：交 policy／policy_progress 時，source_urls 沒有官方來源（選舉公報、中選會、政府或議會網站）的話，要附至少兩個不同網站的來源（例如兩家媒體、候選人臉書加一篇報導）；只有一篇報導或一則貼文會被當場退回（不算被拒）。";

/** 整批檢查：回傳所有有問題的筆（空陣列＝通過） */
export function soleSourceProblems(items: ReadonlyArray<{ contribution_type: string; source_urls?: readonly string[] | null }>): SoleSourceProblem[] {
  const out: SoleSourceProblem[] = [];
  items.forEach((it, i) => {
    const p = soleSourceProblem(i, it.contribution_type, it.source_urls ?? []);
    if (p) out.push(p);
  });
  return out;
}
