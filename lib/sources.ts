/**
 * 出處（#347 第二階段 A）：政見頁、進度紀錄、查核履歷的出處讀出處表，等級用小標籤、有存檔網址就多一個「存檔」小連結。
 * 舊欄位 policies.source_url／tracking_logs.source_url 是退路：視圖還沒有 sources 欄（migration 比前端晚上線、舊快照）時，
 * 用舊欄位補一筆「沒有等級」的出處，畫面照舊有連結、只是不標等級。第二階段 B 才拿掉退路。
 * 純函式、不碰瀏覽器 API（預渲染與邊緣 SSR 都會跑）。
 */
import type { Policy, RawSourceRef, SourceLevel, SourceRef } from '../types'

const LEVELS: readonly SourceLevel[] = ['official', 'self', 'media', 'other']

export const SOURCE_LEVEL_LABEL: Record<SourceLevel, string> = {
  official: '官方',
  self: '本人',
  media: '媒體',
  other: '其他',
}

/** 小標籤的底色（Tailwind 靜態 class，不要動態組） */
export const SOURCE_LEVEL_CLASS: Record<SourceLevel, string> = {
  official: 'bg-emerald-50 text-emerald-700',
  self: 'bg-violet-50 text-violet-700',
  media: 'bg-sky-50 text-sky-700',
  other: 'bg-slate-100 text-slate-600',
}

const SELF_EVIDENCE_LABEL: Record<string, string> = {
  linked_by_official: '議會、選委會或政黨官網有連結到這個網址',
  mutual_link: '與本人官網互相連結',
  platform_verified: '平台認證',
}

/** 本人來源的認定根據（小標籤的提示文字）；不是本人來源或沒有根據就是 null */
export function selfEvidenceLabel(kind: SourceLevel | null | undefined, evidence: string | null | undefined): string | null {
  return kind === 'self' && evidence ? (SELF_EVIDENCE_LABEL[evidence] ?? null) : null
}

const isHttp = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\/[^/\s]+/i.test(u.trim())
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * 視圖的 sources（資料庫 source_brief_list）→ 前端的出處清單，主要出處在前。
 * 格式不對的項目略過；整個欄位沒有（舊視圖）或是空的、而舊欄位 source_url 有值，就用舊欄位補一筆（沒有等級）。
 */
export function mapSourceRefs(raw: readonly RawSourceRef[] | null | undefined, legacyUrl?: string | null): SourceRef[] {
  const out: SourceRef[] = []
  const seen = new Set<string>()
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!r || !isHttp(r.url)) continue
    const url = r.url.trim()
    if (seen.has(url)) continue
    seen.add(url)
    // 沒有值的欄位不放（快照裡每筆政見都帶一份，空欄位會讓 HTML 白白變大）
    const title = str(r.title)
    const publisher = str(r.publisher)
    const publishedDate = str(r.published_date)
    const selfEvidence = str(r.self_evidence)
    out.push({
      url,
      ...(title ? { title } : {}),
      ...(publisher ? { publisher } : {}),
      ...(publishedDate ? { publishedDate } : {}),
      ...(LEVELS.includes(r.kind as SourceLevel) ? { kind: r.kind as SourceLevel } : {}),
      ...(selfEvidence ? { selfEvidence } : {}),
      ...(isHttp(r.archive_url) ? { archiveUrl: r.archive_url.trim() } : {}),
      role: r.role === 'supporting' ? 'supporting' : 'primary',
    })
  }
  // 主要出處排最前（資料庫已經排好；這裡再保險一次，穩定排序）
  out.sort((a, b) => Number(b.role === 'primary') - Number(a.role === 'primary'))
  if (out.length === 0 && isHttp(legacyUrl)) out.push({ url: legacyUrl.trim(), role: 'primary' })
  return out
}

/**
 * 頁面快照裡政見的出處清單（policy.sources 與進度紀錄的 sources）只有政見頁自己那一筆用得到。
 * 首頁、追蹤頁、分析頁會把整份政見（一千多筆）嵌進 HTML，每筆多一份出處清單就是幾百 KB，所以其餘一律拿掉；
 * 主要出處網址 sourceUrl 保留（結構化標記的 citation 要用）。
 */
export function trimPolicySources<T extends { policies: Policy[] }>(snapshot: T, keepPolicyId?: string): T {
  const hasSources = (p: Policy) => !!p.sources || p.logs.some((l) => l.sources)
  if (snapshot.policies.every((p) => !hasSources(p))) return snapshot
  return {
    ...snapshot,
    policies: snapshot.policies.map((p) => {
      if (keepPolicyId !== undefined && String(p.id) === keepPolicyId) return p
      if (!hasSources(p)) return p
      const { sources: _sources, ...rest } = p
      void _sources
      return { ...rest, logs: p.logs.map((l) => { const { sources: _logSources, ...logRest } = l; void _logSources; return logRest }) }
    }),
  }
}

/** 主要出處網址：出處表的主要出處優先，沒有才退回舊欄位 */
export function primarySourceUrl(sources: readonly SourceRef[] | undefined, legacyUrl?: string | null): string | undefined {
  const hit = (sources ?? []).find((s) => s.role === 'primary')
  if (hit) return hit.url
  return isHttp(legacyUrl) ? legacyUrl.trim() : undefined
}

/** 出處的顯示名稱：標題 → 發布者 → 網站網域 */
export function sourceDisplayName(s: SourceRef): string {
  if (s.title) return s.title
  if (s.publisher) return s.publisher
  try { return new URL(s.url).hostname.replace(/^www\./, '') } catch { return s.url }
}
