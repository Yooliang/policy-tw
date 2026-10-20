/**
 * 參選地圖人數資料的邊緣快取路徑（cloudflare/map-stats.js 的 /api/map-stats，#680）。
 * 前端先打正見.tw 的這個路徑（Worker 在邊緣快取約 5 分鐘），失敗再退回直接呼叫 Supabase RPC。
 * 一律用絕對網址（SITE_URL）：policy-tw.web.app 沒有 Worker，本機開發也要指到正見.tw；Worker 回應帶 CORS。
 */
export const MAP_STATS_PATH = '/api/map-stats'

export type MapStatsLevel = 'county' | 'town' | 'village' | 'meta'

export function mapStatsUrl(base: string, election: number, level: MapStatsLevel, parent?: string | null): string {
  const u = new URL(MAP_STATS_PATH, base)
  u.searchParams.set('election', String(election))
  u.searchParams.set('level', level)
  if (parent) u.searchParams.set('parent', parent)
  return u.toString()
}
