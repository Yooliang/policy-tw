/**
 * 學經歷帶出處（#346 第一階段，2026-10-06）。
 *
 * 學經歷搬進 politician_careers（一項一列），出處走 sources／source_refs。第一階段寫入端照舊寫
 * politicians.education[]／experience[]，資料庫的觸發器把陣列同步成表；politician 交件落庫（status 變 applied）時，
 * 觸發器把那筆交件的 source_urls 掛到「文字相同」的項目上（migration 20261006073460 的 politician_careers_attach_sources）。
 * 落庫這邊只負責在回覆裡講清楚出處有沒有掛得上——代理照原文重交學經歷補出處時，陣列不會變（只補空欄位），
 * 回覆只寫「無空欄位可補」會讓它以為白做了。
 */
import { isUnreadableSocial } from "./lineage.ts";

type Obj = Record<string, unknown>;

/** 交件裡的學經歷項目數（education／experience 不是陣列就當沒有） */
export function careerItemCount(payload: Obj): number {
  return ["education", "experience"].reduce((n, k) => n + (Array.isArray(payload[k]) ? (payload[k] as unknown[]).filter((s) => typeof s === "string" && s.trim() !== "").length : 0), 0);
}

/** 能當學經歷出處的網址：http(s)，而且不是臉書、IG、Threads（跟 SQL 的 career_source_readable 同一條，測試盯） */
export function readableCareerSources(urls: readonly unknown[] | null | undefined): string[] {
  return (urls ?? []).filter((u): u is string => typeof u === "string" && /^https?:\/\/[^/\s]+/i.test(u.trim()) && !isUnreadableSocial(u));
}

/** 落庫回覆的附註：學經歷的出處掛不掛得上。沒有交學經歷就是空字串 */
export function careerSourceNote(payload: Obj, sourceUrls: readonly unknown[] | null | undefined): string {
  if (careerItemCount(payload) === 0) return "";
  if (readableCareerSources(sourceUrls).length === 0) {
    return "；學經歷沒有掛上出處：source_urls 只有臉書、IG、Threads 或不是網址（讀不到，不算出處），網站上照舊標「待補出處」";
  }
  return "；學經歷裡跟現有項目文字相同的，會掛上這次的 source_urls 當出處（臉書、IG、Threads 不算）";
}
