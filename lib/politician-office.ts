/**
 * 職稱（現任公職）與參選狀況是兩件事（2026-10-04 維護者：「職稱可能有多種，把他跟參選狀況分開來」）。
 *
 * 之前人物頁上方那顆標籤、網頁標題、SEO 摘要寫的都是 `Politician.position`——
 * 它是「最近一筆非 not_running 的參選紀錄」組出來的字，不看當選落選，
 * 所以 2024 落選的立委候選人也掛著「台南市立委」，跟現任立委長得一模一樣。
 *
 * 這裡分成兩個純函式：
 *   officeTitles()   職稱：只認現任（視圖 politician_offices，migration 20261004000005），沒有就是空陣列
 *   candidacyBadge() 參選狀況：這一屆那一筆參選紀錄，例如「2026 台南市長・已登記」
 * 兩個都可能是空的，空的就不要顯示——不要拿另一個去充當。
 */
import { participationLabel } from './participation-label'
import type { CandidateStatus, PoliticianElectionData, PoliticianOffice } from '../types'

/**
 * 職位位階，數字小的排前面。順序照 types.ts 的 ElectionType，不是自己排的
 * （跟 components/GlobalSearch.vue 的 TYPE_RANK 同一套）。
 */
const TYPE_RANK: Record<string, number> = {
  總統副總統: 0,
  立法委員: 1,
  縣市長: 2,
  縣市議員: 3,
  鄉鎮市長: 4,
  直轄市山地原住民區長: 5,
  鄉鎮市民代表: 6,
  直轄市山地原住民區民代表: 7,
  村里長: 8,
}
const rankOf = (t?: string): number => (t && TYPE_RANK[t] !== undefined ? TYPE_RANK[t] : 9)

/**
 * 現任職稱，可能多個，位階高的在前。
 *
 * politician_offices 給的是「當選了、而且任期還沒結束」的席次。同一個人跨屆都當選時會有兩列
 * （例如 2022 選上台北市議員、2024 選上立委），但我國不得同時擔任兩個民選公職——後面那個就任時
 * 前一個已經辭掉了，所以只取最近一屆那幾列。線上這種人有 16 位（2026-10-04 實查，全是議員轉立委）。
 * 真的同一屆選上兩個席次的話（資料上可能，制度上不會）會一起顯示，所以回傳的是陣列。
 */
export function officeTitles(offices: PoliticianOffice[] | undefined): string[] {
  if (!offices || offices.length === 0) return []
  const latest = Math.max(...offices.map((o) => o.electionId))
  return offices
    .filter((o) => o.electionId === latest)
    .sort((a, b) => rankOf(a.electionType) - rankOf(b.electionType))
    .map((o) => participationLabel(o))
    .filter((label, i, all) => label !== '' && all.indexOf(label) === i)
}

/**
 * 參選狀況的狀態文字。投完票之後結果就是事實，優先於登記階段的狀態。
 * 選前那幾種照 politician_elections.candidate_status（協議的詞）。
 */
export function candidacyStatusText(
  status: CandidateStatus | undefined,
  result: 'elected' | 'not_elected' | undefined,
): string | undefined {
  if (result === 'elected') return '當選'
  if (result === 'not_elected') return '落選'
  switch (status) {
    case 'elected': return '當選'
    case 'defeated': return '落選'
    case 'qualified': return '已審定'
    case 'registered': return '已登記'
    case 'confirmed': return '確認參選'
    case 'likely': return '可能參選'
    case 'rumored': return '傳聞參選'
    case 'not_running': return '未參選'
    default: return undefined
  }
}

/**
 * 這一屆的參選狀況，例如「2026 台南市長・已登記」「2026 台南市長・未參選」。
 * 該屆沒有參選紀錄、或紀錄裡看不出狀態就回 undefined——不顯示比瞎猜好。
 */
export function candidacyBadge(
  elections: PoliticianElectionData[] | undefined,
  electionId: number | null | undefined,
): { label: string; what: string; status: string; running: boolean } | undefined {
  if (!elections || electionId == null) return undefined
  const record = elections.find((e) => e.electionId === electionId)
  if (!record) return undefined
  const status = candidacyStatusText(record.candidateStatus, record.electionResult)
  if (!status) return undefined
  const what = participationLabel(record) || record.position || ''
  if (!what) return undefined
  // running＝這一屆真的有在選（未參選、落選的不算）；標題寫「…候選人」時要看這個，別把沒選的人寫成候選人
  const running = record.candidateStatus !== 'not_running' && record.electionResult !== 'not_elected'
  return { label: `${electionId} ${what}・${status}`, what: `${electionId} ${what}`, status, running }
}
