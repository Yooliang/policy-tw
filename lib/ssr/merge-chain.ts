/**
 * 已軟合併的人物：舊網址轉向保留的那一位（2026-10-08，#466）。
 *
 * 人物被合併後，politicians.merged_into 指向保留者，舊 id 的列還在。邊緣 SSR 的人物頁載入器會把已合併的列濾掉，
 * 以前因此直接回 404；「網址保持」的常設裁決要求舊網址 301 到保留的那位（客戶端 PoliticianProfile.vue 本來就會轉）。
 * 這裡只放「沿著 merged_into 走到底」的純邏輯，查詢由呼叫端注入（loaders.ts 用 anon 查 politicians_with_elections，測試用假表）。
 */

/** 查一位人物的合併指向；查無此人回 null */
export type MergeLookup = (id: string) => Promise<{ id: string; mergedInto: string | null } | null>

export type MergeOutcome =
  /** 這位人物沒被合併，或查無此人（呼叫端照原本的規則處理，例如查無此列才 404） */
  | { kind: 'live' }
  /** 沿著 merged_into 走到沒被合併的那一位 */
  | { kind: 'redirect'; to: string }
  /** 鏈上有人不存在、成環、或超過跳數：不轉，當成找不到 */
  | { kind: 'broken' }

/** 合併鏈最多跟幾跳：正常是一跳，A→B 之後 B 又被併進 C 才會兩跳；超過就當資料有問題 */
export const MAX_MERGE_HOPS = 5

export async function followMerged(startId: string, lookup: MergeLookup, maxHops = MAX_MERGE_HOPS): Promise<MergeOutcome> {
  const start = await lookup(startId)
  if (!start || !start.mergedInto) return { kind: 'live' }
  const seen = new Set<string>([String(start.id).toLowerCase()])
  let next = String(start.mergedInto)
  for (let hop = 0; hop < maxHops; hop++) {
    const key = next.toLowerCase()
    if (seen.has(key)) return { kind: 'broken' }
    seen.add(key)
    const row = await lookup(next)
    if (!row) return { kind: 'broken' }
    if (!row.mergedInto) return { kind: 'redirect', to: String(row.id) }
    next = String(row.mergedInto)
  }
  return { kind: 'broken' }
}
