/**
 * 議題串聯的資料來源：資料庫函式 issues_summary／issues_page（migration 20261031130000）。
 * 快取兩層：記憶體（請求去重＋10 分鐘）疊 IndexedDB（lib/idb-cache.ts，跨重新整理，同樣 10 分鐘）。
 * 失敗不留快取；函式還沒上線（PGRST202）當成載入失敗，由畫面顯示重試。
 */
import { supabasePublic as supabase } from '../lib/supabase'
import { withTimeoutAndRetry } from '../lib/retry'
import { idbGet, idbPut, IDB_CACHE_TTL_MS } from '../lib/idb-cache'
import { createTtlCache } from '../lib/ttl-cache'
import {
  ISSUE_PAGE_SIZE, mapPageRows, mapSummaryRows, pageKey, summaryKey,
  type IssueCard, type IssueLevel, type IssueSummary,
} from '../lib/issues-stack'

const summaryCache = createTtlCache<IssueSummary[]>(IDB_CACHE_TTL_MS)
const pageCache = createTtlCache<{ cards: IssueCard[]; total: number }>(IDB_CACHE_TTL_MS)

async function viaIdb<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = typeof window === 'undefined' ? undefined : await idbGet<T>(`issues:${key}`)
  if (hit !== undefined) return hit
  const fresh = await load()
  if (typeof window !== 'undefined') void idbPut(`issues:${key}`, fresh)
  return fresh
}

export function loadIssueSummary(electionId: number, region: string): Promise<IssueSummary[]> {
  const key = summaryKey(electionId, region)
  return summaryCache.get(key, () => viaIdb(key, async () => {
    const { data } = await withTimeoutAndRetry(`issues_summary ${region}`, (signal) =>
      supabase.rpc('issues_summary', { p_election_id: electionId, p_region: region }).abortSignal(signal).throwOnError())
    return mapSummaryRows(data)
  }))
}

export function loadIssuePage(electionId: number, region: string, issue: string, level: IssueLevel | null, offset: number, limit: number = ISSUE_PAGE_SIZE): Promise<{ cards: IssueCard[]; total: number }> {
  const key = `${pageKey(electionId, region, issue, level, offset)}|${limit}`
  return pageCache.get(key, () => viaIdb(key, async () => {
    const { data } = await withTimeoutAndRetry(`issues_page ${region} ${issue} ${offset}`, (signal) =>
      supabase.rpc('issues_page', {
        p_election_id: electionId, p_region: region, p_issue: issue, p_level: level, p_offset: offset, p_limit: limit,
      }).abortSignal(signal).throwOnError())
    return mapPageRows(data)
  }))
}
