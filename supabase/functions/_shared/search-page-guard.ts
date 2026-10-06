/**
 * 交件守門：出處與「查過的網址」不收搜尋結果頁（2026-10-06，小良哥點頭；判斷規則在 search-page.ts）。
 *
 * 套用到所有交件型別的出處欄位：
 *   - `source_urls`（no_change 沒給時是 `payload.checked_urls`）
 *   - `payload.checked_urls`（no_change）
 *   - 單一出處欄：`payload.source_url`（脈絡交接、上下級關聯）、`payload.elements[].source_url`（政見三要素）、
 *     `payload.participants[].source_url`（脈絡角色）、correction 改 `policies.source_url` 的新值
 *
 * 規則：搜尋結果頁**不計入網址數**。扣掉之後還夠最低要求就照收（搜尋結果頁從要存的出處裡拿掉，回應會講）；
 * 不夠就整批 400 `search_page_not_source`，記 `gate_rejections`，不算被拒。
 * 最低要求：source_urls、checked_urls 至少 1 個實際頁面；單一出處欄本身就不能是搜尋結果頁。
 * 「查無」的 5 個／7 個網址門檻由 not-found-guard.ts 照同一個判斷扣掉搜尋結果頁再數。
 *
 * 計分不動：票數門檻、系統票、驗證流程都照舊；這裡只決定「什麼算一個出處」。
 */

import { normalizeCorrection } from "./correction.ts";
import { SEARCH_PAGE_NOT_SOURCE, searchPageVerdict, splitSearchPages } from "./search-page.ts";

export const SEARCH_PAGE_GATE = "search_page_not_source";

export interface SearchPageProblem {
  index: number;
  contribution_type: string;
  /** 哪一欄：source_urls、payload.checked_urls、payload.elements[0].source_url… */
  path: string;
  search_urls: string[];
  /** 扣掉搜尋結果頁後剩幾個實際頁面（單一出處欄是 0） */
  remaining: number;
  required: number;
  message: string;
}

interface Item {
  contribution_type: string;
  payload: unknown;
  source_urls: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function listProblem(index: number, type: string, path: string, urls: readonly unknown[]): SearchPageProblem | null {
  const { pages, search } = splitSearchPages(urls);
  if (search.length === 0 || pages.length >= 1) return null;
  return {
    index,
    contribution_type: type,
    path,
    search_urls: search,
    remaining: pages.length,
    required: 1,
    message: `第 ${index + 1} 筆的 ${path} 全是搜尋結果頁（${search.map((u) => searchPageVerdict(u)!.label).join("、")}）。` +
      `${SEARCH_PAGE_NOT_SOURCE}：從搜尋結果點進去、真的寫到這件事（或你真的核對過）的那一頁網址。搜了哪些關鍵字寫在 finding 或 note。這不算被拒，補好重送即可。`,
  };
}

function singleProblem(index: number, type: string, path: string, url: unknown): SearchPageProblem | null {
  const v = searchPageVerdict(url);
  if (!v) return null;
  return {
    index,
    contribution_type: type,
    path,
    search_urls: [String(url)],
    remaining: 0,
    required: 1,
    message: `第 ${index + 1} 筆的 ${path} 是${v.label}。${SEARCH_PAGE_NOT_SOURCE}：放你實際打開、寫到這件事的那一頁。這不算被拒，補好重送即可。`,
  };
}

/** 純函式：整批檢查，回傳所有有問題的欄位（空陣列＝通過） */
export function searchPageProblems(items: readonly Item[]): SearchPageProblem[] {
  const out: SearchPageProblem[] = [];
  items.forEach((it, i) => {
    const type = it.contribution_type;
    const p = isObj(it.payload) ? it.payload : {};
    const push = (x: SearchPageProblem | null) => { if (x) out.push(x); };
    push(listProblem(i, type, "source_urls", it.source_urls ?? []));
    if (Array.isArray(p.checked_urls) && p.checked_urls !== it.source_urls) push(listProblem(i, type, "payload.checked_urls", p.checked_urls));
    push(singleProblem(i, type, "payload.source_url", p.source_url));
    if (Array.isArray(p.elements)) p.elements.forEach((e, j) => push(singleProblem(i, type, `payload.elements[${j}].source_url`, isObj(e) ? e.source_url : undefined)));
    if (Array.isArray(p.participants)) p.participants.forEach((e, j) => push(singleProblem(i, type, `payload.participants[${j}].source_url`, isObj(e) ? e.source_url : undefined)));
    if (type === "correction") {
      normalizeCorrection(p).changes.forEach((c, j) => {
        if (c.field === "source_url") push(singleProblem(i, type, Array.isArray(p.changes) ? `payload.changes[${j}].correct_value` : "payload.correct_value", c.correct_value));
      });
    }
  });
  return out;
}

/**
 * 通過守門之後：把搜尋結果頁從要存的出處裡拿掉（就地修改），回傳每筆拿掉了哪些（沒拿掉的不列）。
 * source_urls 與 no_change 的 checked_urls 都拿：驗證者照 source_urls 核對，打開搜尋結果頁核不到任何東西。
 */
export function stripSearchPages(items: Item[]): Map<number, string[]> {
  const removed = new Map<number, string[]>();
  items.forEach((it, i) => {
    const gone: string[] = [];
    const { pages, search } = splitSearchPages(it.source_urls ?? []);
    if (search.length > 0) {
      gone.push(...search);
      it.source_urls = pages;
    }
    const p = isObj(it.payload) ? it.payload : null;
    if (p && Array.isArray(p.checked_urls)) {
      const c = splitSearchPages(p.checked_urls);
      if (c.search.length > 0) {
        for (const u of c.search) if (!gone.includes(u)) gone.push(u);
        p.checked_urls = c.pages;
      }
    }
    if (gone.length > 0) removed.set(i, gone);
  });
  return removed;
}

export function strippedNotice(count: number): string {
  return `有 ${count} 個搜尋結果頁沒有算進出處，也沒有存進這筆的來源（${SEARCH_PAGE_NOT_SOURCE}）。下次 source_urls／checked_urls 只放實際打開的頁面，搜了哪些關鍵字寫在 finding 或 note。`;
}
