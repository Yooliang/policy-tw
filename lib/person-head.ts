import { ballotLabel, nameWithBallot } from './ballot-number'
import { participationLabel, type ParticipationLike } from './participation-label'

/**
 * 人物頁的 <title>／description 組字（2026-11-16 流量體檢：九成流量是 Google 搜候選人名字，
 * 但標題以前只寫「現職」，鄭朝方這種現任竹北市長、2026 選新竹縣長的人，標題沒有「2026」「縣長」「政見」）。
 * 純函式，頁面（pages/PoliticianProfile.vue）、預渲染與測試共用；村里長的「2026 琉球鄉本福村長」沿用 participationLabel，全站同一套。
 */

export interface HeadElectionRecord extends ParticipationLike {
  electionId: number
  electionDate?: string | null
}

/** 縣市議員、立委有選區時補在括號裡：「2026 台南市議員（第3選舉區）」；「第03選舉區」去掉前導零 */
function districtSuffix(rec: ParticipationLike): string {
  if (rec.electionType !== '縣市議員' && rec.electionType !== '立法委員') return ''
  const sub = (rec.subRegion || '').trim().replace(/第0+(\d)/, '第$1')
  return sub ? `（${sub}）` : ''
}

/** 這一屆參選的標題用字：「2026 新竹縣長」「2026 新北市議員（第3選舉區）」「2026 琉球鄉本福村長」；組不出來回空字串 */
export function candidacyHeadWhat(rec: HeadElectionRecord | undefined): string {
  if (!rec) return ''
  const what = participationLabel(rec)
  if (!what) return ''
  const year = rec.electionDate?.slice(0, 4) ?? (rec.electionId >= 1900 ? String(rec.electionId) : '')
  return `${year ? `${year} ` : ''}${what}${districtSuffix(rec)}`
}

export interface PersonHeadInput {
  name: string
  ballot?: number
  /** 現行標題用的身份（現任職稱，或沒有職稱時的「2026 …候選人」） */
  identity: string
  /** candidacyHeadWhat 的結果；空字串＝這一屆沒有在選（或已投完票），維持現行格式 */
  headWhat: string
}

/** 標題（不含站名，usePageHead 會補）：有參選用「姓名（N 號）｜2026 新竹縣長候選人政見」，否則維持「姓名（N 號）｜現職」 */
export function personHeadTitle(i: PersonHeadInput): string {
  const who = nameWithBallot(i.name, i.ballot)
  if (i.headWhat) return `${who}｜${i.headWhat}候選人政見`
  return [who, i.identity].filter(Boolean).join('｜')
}

export interface PersonDescriptionInput extends PersonHeadInput {
  party?: string | null
  region?: string | null
  slogan?: string | null
  bio?: string | null
  /** 承諾＋政見的筆數（跟人物頁兩個分頁加起來一致） */
  policyCount: number
  /** 政見標題，取前兩條 */
  policyTitles: readonly string[]
  /** 現行摘要結尾那句（personTrackingText 的結果），舊格式沿用 */
  trackingText: string
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 摘要（≤150 字由 usePageHead 的 summarize 再保險截）：有參選時帶選區職位、黨籍、號次與前兩條政見；沒政見就寫簡介 */
export function personHeadDescription(i: PersonDescriptionInput): string {
  if (i.headWhat) {
    const tags = [i.party, ballotLabel(i.ballot)].filter(Boolean).join('，')
    const lead = `${i.name}，${i.headWhat}候選人${tags ? `（${tags}）` : ''}。`
    const titles = i.policyTitles.map(oneLine).filter(Boolean).slice(0, 2)
    const body = i.policyCount > 0
      ? `正見整理其 ${i.policyCount} 項政見與查核紀錄${titles.length ? `，包括${titles.join('、')}` : ''}。`
      : oneLine(i.slogan || i.bio || '') || '正見提供其基本資料與參選紀錄。'
    return clip(`${lead}${body}`, 150)
  }
  const tags = [ballotLabel(i.ballot), i.party, i.identity || i.region].filter(Boolean).join('，')
  return i.slogan || i.bio
    ? `${i.name}（${tags}）：${i.slogan || i.bio}`
    : `${i.name}，${tags}。${i.trackingText}`
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
