import { isCounty } from './election-regions.ts'

/**
 * 路由解析時預先發起選舉頁主要資料用的參數（2026-10-31，載入順序優化）。
 *
 * 以前候選人清單要等 ElectionPage 掛載、onMounted 才發請求；路由元件早就在手，網址上也都有，
 * 沒有理由等。這裡把「網址 → loadPoliticiansByElection 的三個參數」做成純函式，
 * 規則必須跟 pages/ElectionPage.vue 一模一樣（electionId／routeRegion／routeSubRegion／selectedRegion 的初始值）：
 * 參數不同，預先發的請求元件就接手不到，等於白發一次。
 */
export interface ElectionPageLoadArgs {
  electionId: number
  region: string
  subRegion: string
}

const first = (v: unknown): string | undefined => (Array.isArray(v) ? v[0] : (v as string | undefined))

/**
 * @param params 路由參數（electionId／region／subRegion）
 * @param findElectionId 用網址那一段在已載入的選舉清單裡找 id（找不到回 undefined）
 * @param globalRegion 全站目前選的縣市（網址沒有縣市時，頁面用它當初始縣市）
 * @returns 不是能預先發的情形（選舉 id 解不出來）回 null
 */
export function electionPageLoadArgs(
  params: Record<string, unknown>,
  findElectionId: (segment: unknown) => number | undefined,
  globalRegion: string,
): ElectionPageLoadArgs | null {
  const seg = first(params.electionId)
  let electionId = findElectionId(params.electionId)
  if (electionId === undefined) electionId = typeof seg === 'string' && /^\d+$/.test(seg) ? Number(seg) : NaN
  if (!electionId || Number.isNaN(electionId)) return null

  const rawRegion = first(params.region)
  const routeRegion = isCounty(rawRegion) ? rawRegion : undefined
  const rawSub = routeRegion ? first(params.subRegion)?.trim() : undefined
  const routeSub = rawSub && rawSub !== 'All' ? rawSub : undefined
  return { electionId, region: routeRegion ?? globalRegion, subRegion: routeSub ?? 'All' }
}
