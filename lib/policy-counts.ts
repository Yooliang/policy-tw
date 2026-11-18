/**
 * 每人每屆的承諾數／政見數（#982 延伸）。
 *
 * 選舉頁候選人卡片的「N 項承諾」與縣市頁 SEO 描述的「已收錄政見 N 項」以前要掃整份政見清單才算得出來
 * （2026 屆 7,675 筆，預渲染 HTML 7.75 MB）。現在讀資料庫視圖 politician_election_policy_counts
 * （一人一屆一列：politician_id, election_id, pledge_count, policy_count），預渲染只嵌這份對照。
 * 純函式、不 import supabase client：建置端、瀏覽器與 deno 測試共用。
 */

/** 一列：[人物 id, 承諾數（status＝競選承諾）, 政見數（該人該屆全部未移除政見）]；用陣列省 HTML 體積 */
export type PolicyCountRow = [politicianId: string, pledge: number, policy: number]

/**
 * 某一屆的對照。complete＝這一屆所有人都在裡面（缺的人就是 0）；
 * 不是 complete（縣市頁、鄉鎮頁只嵌那一頁的人）時，缺的人要等瀏覽器補撈整屆才知道。
 */
export interface PolicyCountsSlice { electionId: number; rows: PolicyCountRow[]; complete: boolean }

export interface PolicyCounts { pledge: number; policy: number }
export type PolicyCountMap = Record<string, PolicyCounts>
export interface ElectionPolicyCounts { complete: boolean; map: PolicyCountMap }
/** 全域狀態：屆別（elections.id）→ 該屆對照 */
export type PolicyCountsByElection = Record<number, ElectionPolicyCounts>

/** 視圖原始列（欄位名同 migration 20261118120000） */
export interface RawPolicyCountRow { politician_id: string; election_id: number; pledge_count: number; policy_count: number }

/** 視圖列 → 每屆一份 rows（建置端撈一次全部屆別後切開） */
export function groupRowsByElection(raw: ReadonlyArray<RawPolicyCountRow>): PolicyCountsSlice[] {
  const byElection = new Map<number, PolicyCountRow[]>()
  for (const r of raw) {
    const list = byElection.get(r.election_id) ?? []
    list.push([String(r.politician_id), Number(r.pledge_count) || 0, Number(r.policy_count) || 0])
    byElection.set(r.election_id, list)
  }
  return [...byElection.entries()].map(([electionId, rows]) => ({ electionId, rows, complete: true }))
}

/**
 * 從政見清單自己算視圖那一份（建置端：視圖還沒上線的那幾分鐘的退路，以及跟視圖對帳用）。
 * 規則跟視圖一致：只算有屆別的；承諾＝status 為 Campaign Pledge。呼叫端要先濾掉已移除的政見（全域 state 本來就沒有）。
 */
export function rawRowsFromPolicies(
  policies: ReadonlyArray<{ politicianId: string | number; electionId?: number; status: unknown }>,
): RawPolicyCountRow[] {
  const acc = new Map<string, RawPolicyCountRow>()
  for (const p of policies) {
    if (p.electionId === undefined || p.electionId === null) continue
    const key = `${p.electionId}|${p.politicianId}`
    const row = acc.get(key) ?? { politician_id: String(p.politicianId), election_id: p.electionId, pledge_count: 0, policy_count: 0 }
    row.policy_count += 1
    if (String(p.status) === 'Campaign Pledge') row.pledge_count += 1
    acc.set(key, row)
  }
  return [...acc.values()]
}

/**
 * 取某一屆的切片。
 * politicianIds 有給（縣市頁、鄉鎮頁）：只留這些人，而且沒有政見的人補一列 0——
 * 這樣「對照裡沒有這個人」只代表「還沒撈到」，卡片可以等整屆補撈完再顯示，不會先閃一個錯的 0。
 * 這種切片標成 complete:false，瀏覽器端會補撈整屆。
 */
export function sliceForElection(
  all: ReadonlyArray<PolicyCountsSlice> | undefined,
  electionId: number,
  politicianIds?: ReadonlySet<string>,
): PolicyCountsSlice[] {
  const found = (all ?? []).find((s) => s.electionId === electionId)
  if (!found) return []
  if (!politicianIds) return [{ electionId, rows: found.rows, complete: found.complete }]
  const rows = found.rows.filter((r) => politicianIds.has(r[0]))
  const have = new Set(rows.map((r) => r[0]))
  for (const id of politicianIds) if (!have.has(id)) rows.push([id, 0, 0])
  return [{ electionId, rows, complete: false }]
}

export function slicesToState(slices: ReadonlyArray<PolicyCountsSlice> | undefined): PolicyCountsByElection {
  const out: PolicyCountsByElection = {}
  for (const s of slices ?? []) {
    const map: PolicyCountMap = {}
    for (const [id, pledge, policy] of s.rows) map[id] = { pledge, policy }
    out[s.electionId] = { complete: s.complete, map }
  }
  return out
}

/** 這個人這一屆的承諾數；對照不在或沒這個人＝0 */
export function pledgeCountOf(
  state: PolicyCountsByElection,
  electionId: number | undefined,
  politicianId: string | number,
): number {
  if (electionId === undefined) return 0
  return state[electionId]?.map[String(politicianId)]?.pledge ?? 0
}

/** 傳進來的這些人在這一屆的政見總筆數（SEO 描述用） */
export function policyCountOfPeople(
  state: PolicyCountsByElection,
  electionId: number | undefined,
  people: ReadonlyArray<{ id: string | number }>,
): number {
  if (electionId === undefined) return 0
  const map = state[electionId]?.map
  if (!map) return 0
  let n = 0
  const seen = new Set<string>()
  for (const p of people) {
    const k = String(p.id)
    if (seen.has(k)) continue
    seen.add(k)
    n += map[k]?.policy ?? 0
  }
  return n
}

/** 這個人這一屆的數字有沒有可信的值：整屆已齊（缺的＝真的 0），或對照裡有他這一列。還沒有就不該顯示 0 */
export function pledgeCountKnown(
  state: PolicyCountsByElection,
  electionId: number | undefined,
  politicianId: string | number,
): boolean {
  if (electionId === undefined) return false
  const e = state[electionId]
  return !!e && (e.complete || String(politicianId) in e.map)
}

/** 這一屆的對照是否已齊（齊了才不必向資料庫補撈） */
export function isPolicyCountsComplete(state: PolicyCountsByElection, electionId: number): boolean {
  return state[electionId]?.complete === true
}
