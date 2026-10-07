import type { Policy } from '../types'

/**
 * 這條政見是不是競選承諾：origin＝pledge，或 status＝Campaign Pledge，兩者擇一成立即算（維護者 2026-10-07 的過渡期規則）。
 * 首頁的「競選承諾／任內政見」筆數與 /data、矩陣的範圍（lib/md/pledge.ts）都只問這一個函式，不各自比 status 字串；
 * 等 status 與 origin 拆乾淨（狀態欄位拆分排到就任後，2027 年 1–2 月；docs/PLAN-term-progress.md）再只剩 origin。
 * 任內政見＝不是競選承諾的政見。
 */
export function isPledge(p: Pick<Policy, 'status' | 'origin'>): boolean {
  return p.origin === 'pledge' || String(p.status) === 'Campaign Pledge'
}

/** 一批政見裡競選承諾與任內政見各幾筆（加起來就是全部；只給筆數，不算比例） */
export function pledgeCounts(policies: ReadonlyArray<Pick<Policy, 'status' | 'origin'>>): { pledge: number; term: number } {
  const pledge = policies.filter(isPledge).length
  return { pledge, term: policies.length - pledge }
}
