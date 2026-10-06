/**
 * 出處第二階段 A 的讀取端（#347；協議 1.62.0）：
 *   - 查核履歷、貢獻看板：交件的 source_urls 掛上出處表裡的等級、認定根據、存檔網址（`sources`）。
 *   - 派給代理的任務現況：政見與進度的 `source_url` 讀出處表的主要出處（第二階段 B-1 起沒有舊欄位的退路——
 *     資料表的 policies.source_url／tracking_logs.source_url 不再被讀；給代理的鍵名 source_url 照舊，值來自出處表）。
 *
 * 出處表查詢出錯：不擋派工，那一欄不給（不是給 null——null 會被讀成「這筆沒有出處」，誤導代理去補一個其實已經有的出處），並記 log。
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

/** 一批政見或進度紀錄的主要出處網址（target_id → url）；查詢出錯回 null（呼叫端不要把「查不到」當成「沒有出處」） */
export async function fetchPrimarySourceUrls(
  supabase: SupabaseLike, table: "policies" | "tracking_logs", ids: readonly (string | number)[],
): Promise<Map<string, string> | null> {
  const list = [...new Set(ids.map((i) => String(i)).filter(Boolean))].slice(0, 200);
  const out = new Map<string, string>();
  if (list.length === 0) return out;
  try {
    // query-bounds: ok — ids 最多 200 筆、每筆最多一個主要出處
    const { data, error } = await supabase.from("source_refs").select("target_id, sources(url)")
      .eq("target_table", table).eq("role", "primary").in("target_id", list).limit(1000);
    if (error || !Array.isArray(data)) {
      console.error(`fetchPrimarySourceUrls(${table}):`, error?.message ?? "沒有回資料");
      return null;
    }
    for (const r of data as Array<{ target_id: string; sources: { url?: string } | Array<{ url?: string }> | null }>) {
      const s = Array.isArray(r.sources) ? r.sources[0] : r.sources;
      if (s && typeof s.url === "string" && s.url) out.set(String(r.target_id), s.url);
    }
  } catch (e) {
    console.error(`fetchPrimarySourceUrls(${table}):`, e instanceof Error ? e.message : String(e));
    return null;
  }
  return out;
}

/**
 * 純函式：幫每一列補上 source_url＝出處表的主要出處；這筆沒有主要出處就是 null（＝我們沒有出處）。
 * primary 是 null（查詢出錯）時不動——欄位不給，比給 null 誠實。
 */
export function overlaySourceUrl(rows: readonly Obj[], primary: ReadonlyMap<string, string> | null): void {
  if (!primary) return;
  for (const r of rows) {
    if (!r || r.id === undefined || r.id === null) continue;
    r.source_url = primary.get(String(r.id)) ?? null;
  }
}

/**
 * 派給代理的任務現況（task-context 的 data）：政見與進度紀錄的 source_url 來自出處表（資料表的欄位不再被讀）。
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
