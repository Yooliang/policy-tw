/**
 * 出處第二階段 A 的讀取端（#347；協議 1.62.0）：
 *   - 查核履歷、貢獻看板：交件的 source_urls 掛上出處表裡的等級、認定根據、存檔網址（`sources`）。
 *   - 派給代理的任務現況：政見與進度的 `source_url` 改讀出處表的主要出處，出處表沒有才退回舊欄位。
 *
 * 出處表還沒上線（migration 比函式晚套上的那幾分鐘）、或查詢出錯，一律退回舊的讀法，不擋頁面也不擋派工。
 * 舊欄位 policies.source_url、tracking_logs.source_url 是退路，第二階段 B 才刪。
 */

import { autoSourceKind, type SourceLevel } from "./source-write.ts";
import { isHttpUrl } from "./source-priority.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;

/** 出處表裡一個網址的摘要（RPC source_briefs 的一列） */
export interface SourceBrief {
  url: string;
  source_kind: string;
  self_evidence: string | null;
  doc_kind: string | null;
  archive_url: string | null;
  title: string | null;
  publisher: string | null;
}

/** 回給畫面的出處：等級（沒有出處列時用網域自動判斷）、認定根據、存檔網址 */
export interface SourceView {
  url: string;
  kind: SourceLevel;
  self_evidence: string | null;
  archive_url: string | null;
}

const KINDS: readonly string[] = ["official", "self", "media", "other"];

/** 一批網址在出處表的摘要（一次最多 500 個）；RPC 不存在或出錯回空表，呼叫端照自動判斷顯示 */
export async function fetchSourceBriefs(supabase: SupabaseLike, urls: readonly string[]): Promise<Map<string, SourceBrief>> {
  const list = [...new Set(urls.filter((u): u is string => typeof u === "string").map((u) => u.trim()).filter(Boolean))].slice(0, 500);
  const out = new Map<string, SourceBrief>();
  if (list.length === 0) return out;
  try {
    const { data, error } = await supabase.rpc("source_briefs", { p_urls: list });
    if (error || !Array.isArray(data)) return out;
    for (const r of data as SourceBrief[]) if (r && typeof r.url === "string") out.set(r.url, r);
  } catch { /* 退回自動判斷 */ }
  return out;
}

/** 純函式：把 source_urls 配上出處表的等級；出處表沒有這個網址就用網域自動判斷（不給 self） */
export function viewSources(urls: readonly string[] | null | undefined, briefs: ReadonlyMap<string, SourceBrief>): SourceView[] {
  const out: SourceView[] = [];
  const seen = new Set<string>();
  for (const raw of urls ?? []) {
    const url = typeof raw === "string" ? raw.trim() : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const b = briefs.get(url);
    if (b && KINDS.includes(b.source_kind)) {
      out.push({ url, kind: b.source_kind as SourceLevel, self_evidence: b.self_evidence ?? null, archive_url: b.archive_url ?? null });
    } else {
      out.push({ url, kind: isHttpUrl(url) ? autoSourceKind(url) : "other", self_evidence: null, archive_url: null });
    }
  }
  return out;
}

/** 純函式：一筆資料的出處清單（RPC source_brief_list 的結果）→ 主要出處網址；沒有就 null */
export function primaryUrlOf(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  const hit = (list as Obj[]).find((s) => s && s.role === "primary" && typeof s.url === "string" && s.url);
  return hit ? String(hit.url) : null;
}

/** 純函式：出處清單（source_brief_list）裡這個網址的等級與存檔；清單沒有它（或沒有清單）就用網域自動判斷 */
export function viewFromList(list: unknown, url: string): SourceView {
  const hit = Array.isArray(list) ? (list as Obj[]).find((s) => s && s.url === url) : undefined;
  if (hit && typeof hit.kind === "string" && KINDS.includes(hit.kind)) {
    return { url, kind: hit.kind as SourceLevel, self_evidence: typeof hit.self_evidence === "string" ? hit.self_evidence : null, archive_url: typeof hit.archive_url === "string" ? hit.archive_url : null };
  }
  return { url, kind: isHttpUrl(url) ? autoSourceKind(url) : "other", self_evidence: null, archive_url: null };
}

/** 一批政見或進度紀錄的主要出處網址（target_id → url）；出錯回空表 */
export async function fetchPrimarySourceUrls(
  supabase: SupabaseLike, table: "policies" | "tracking_logs", ids: readonly (string | number)[],
): Promise<Map<string, string>> {
  const list = [...new Set(ids.map((i) => String(i)).filter(Boolean))].slice(0, 200);
  const out = new Map<string, string>();
  if (list.length === 0) return out;
  try {
    // query-bounds: ok — ids 最多 200 筆、每筆最多一個主要出處
    const { data, error } = await supabase.from("source_refs").select("target_id, sources(url)")
      .eq("target_table", table).eq("role", "primary").in("target_id", list).limit(1000);
    if (error || !Array.isArray(data)) return out;
    for (const r of data as Array<{ target_id: string; sources: { url?: string } | Array<{ url?: string }> | null }>) {
      const s = Array.isArray(r.sources) ? r.sources[0] : r.sources;
      if (s && typeof s.url === "string" && s.url) out.set(String(r.target_id), s.url);
    }
  } catch { /* 退回舊欄位 */ }
  return out;
}

/** 純函式：把列上的 source_url 換成出處表的主要出處；出處表沒有就保留舊欄位的值（退路） */
export function overlaySourceUrl(rows: readonly Obj[], primary: ReadonlyMap<string, string>): void {
  for (const r of rows) {
    if (!r || r.id === undefined || r.id === null) continue;
    const url = primary.get(String(r.id));
    if (url) r.source_url = url;
  }
}

/**
 * 派給代理的任務現況（task-context 的 data）：政見與進度紀錄的 source_url 改讀出處表。
 * data.policy（單筆）、data.policies／data.lineage_policies（清單）、data.tracking_logs（要帶 id）。
 */
export async function overlayPrimarySources(supabase: SupabaseLike, data: Obj): Promise<void> {
  const policyRows: Obj[] = [];
  if (data.policy && typeof data.policy === "object") policyRows.push(data.policy as Obj);
  for (const key of ["policies", "lineage_policies"]) {
    if (Array.isArray(data[key])) policyRows.push(...(data[key] as Obj[]));
  }
  const logRows: Obj[] = Array.isArray(data.tracking_logs) ? (data.tracking_logs as Obj[]) : [];
  const [policies, logs] = await Promise.all([
    fetchPrimarySourceUrls(supabase, "policies", policyRows.map((r) => r.id as string).filter(Boolean)),
    fetchPrimarySourceUrls(supabase, "tracking_logs", logRows.map((r) => r.id as string | number).filter((v) => v !== undefined && v !== null)),
  ]);
  overlaySourceUrl(policyRows, policies);
  overlaySourceUrl(logRows, logs);
}
