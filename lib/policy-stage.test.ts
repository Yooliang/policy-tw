/**
 * 政見階段的單一判斷（lib/policy-stage.ts，#672 承諾→政見 ①）。
 *   1. 四種階段：承諾（選前）、政見（當選／任內施政）、落選或退選的承諾、已投票但結果待補
 *   2. 投票日當天算還沒投票（R7）；「今天」用台北日期，台北／UTC 的 8 小時差要對
 *   3. 當選只認 candidacy_status＝elected（R6），不看現任公職
 *   4. 底層兩個函式跟 supabase/functions/_shared/elected-term.ts 在同一批資料、多個「今天」上逐案一致
 */
import { assertEquals } from 'jsr:@std/assert@1'
import * as shared from '../supabase/functions/_shared/elected-term.ts'
import { isElectedTerm, isElectionVoted, policyStage, taipeiToday, type StageElectionRecord } from './policy-stage.ts'
import type { Policy } from '../types.ts'

type P = Pick<Policy, 'status' | 'origin' | 'electionId'>
const pledge = (electionId: number | null, extra: Partial<P> = {}): P =>
  ({ status: 'Campaign Pledge' as Policy['status'], origin: 'pledge', electionId: electionId as number, ...extra })
const rec = (electionId: number, candidacyStatus?: string): StageElectionRecord => ({ electionId, candidacyStatus })
const dates = new Map<number, string>([[2022, '2022-11-26'], [2026, '2026-11-28']])
const dateOf = (id: number) => dates.get(id)

Deno.test('四種階段：承諾、政見、落選／退選的承諾、結果待補', () => {
  const T = '2026-12-01'
  assertEquals(policyStage(pledge(2022), [rec(2022, 'elected')], T, dateOf), 'policy', '已投票且當選＝政見')
  assertEquals(policyStage(pledge(2026), [rec(2026, 'elected')], '2026-11-01', dateOf), 'pledge', '選前即使標了當選也還是承諾')
  assertEquals(policyStage(pledge(2022), [rec(2022, 'not_elected')], T, dateOf), 'lost_pledge', '落選停在承諾')
  assertEquals(policyStage(pledge(2022), [rec(2022, 'withdrawn')], T, dateOf), 'lost_pledge', '退選停在承諾')
  assertEquals(policyStage(pledge(2022), [rec(2022, 'filed')], T, dateOf), 'pending_result', '已投票但還停在登記階段＝結果待補')
  assertEquals(policyStage(pledge(2022), [rec(2022)], T, dateOf), 'pending_result', '狀態空白＝結果待補')
  assertEquals(policyStage(pledge(2022), [], T, dateOf), 'pending_result', '沒有那一屆的參選紀錄＝結果待補')
  assertEquals(policyStage(pledge(2022), undefined, T, dateOf), 'pending_result')
  assertEquals(policyStage(pledge(2026), [rec(2026, 'filed')], '2026-11-01', dateOf), 'pledge', '選前＝承諾')
  assertEquals(policyStage(pledge(null), [rec(2022, 'elected')], T, dateOf), 'pledge', '沒標屆別＝承諾')
  assertEquals(policyStage(pledge(1999), [rec(1999, 'elected')], T, dateOf), 'pledge', '查不到投票日＝承諾')
})

Deno.test('任內提出的施政（origin 不是 pledge）一律是政見，不看結果', () => {
  const T = '2026-12-01'
  for (const origin of ['policy_address', 'assembly', 'budget'] as const) {
    assertEquals(policyStage(pledge(2022, { origin, status: 'In Progress' as Policy['status'] }), [rec(2022, 'not_elected')], T, dateOf), 'policy', origin)
  }
  assertEquals(policyStage(pledge(2022, { origin: 'policy_address' }), [], T, dateOf), 'policy', 'origin 標了施政就算 status 還是 Campaign Pledge')
  // origin 沒標：看 status
  assertEquals(policyStage({ status: 'In Progress' as Policy['status'], origin: null, electionId: 2022 as number }, [], T, dateOf), 'policy')
  assertEquals(policyStage({ status: 'Campaign Pledge' as Policy['status'], origin: null, electionId: 2022 as number }, [rec(2022, 'elected')], T, dateOf), 'policy')
  assertEquals(policyStage({ status: 'Campaign Pledge' as Policy['status'], origin: null, electionId: 2026 as number }, [rec(2026, 'elected')], '2026-11-01', dateOf), 'pledge')
  // origin=pledge 但 status 已離開 Campaign Pledge：仍是承諾來源，照結果判
  assertEquals(policyStage(pledge(2026, { status: 'In Progress' as Policy['status'] }), [rec(2026, 'elected')], '2026-11-01', dateOf), 'pledge')
})

Deno.test('投票日當天算還沒投票（承諾），隔天才是政見', () => {
  const r = [rec(2026, 'elected')]
  assertEquals(policyStage(pledge(2026), r, '2026-11-27', dateOf), 'pledge')
  assertEquals(policyStage(pledge(2026), r, '2026-11-28', dateOf), 'pledge', '投票日當天')
  assertEquals(policyStage(pledge(2026), r, '2026-11-29', dateOf), 'policy')
  assertEquals(isElectionVoted('2026-11-28', '2026-11-28'), false)
  assertEquals(isElectionVoted('2026-11-28T00:00:00Z', '2026-11-29'), true, '帶時間只看日期部分')
  assertEquals(isElectionVoted(null, '2026-11-29'), false)
  assertEquals(isElectionVoted('', '2026-11-29'), false)
})

Deno.test('今天是台北日期：UTC 還是前一天的 8 小時內，台北已經是隔天', () => {
  // 台北 2026-11-29 07:59 ＝ UTC 2026-11-28 23:59（投票日隔天）
  const taipeiMorning = Date.parse('2026-11-28T23:59:00Z')
  assertEquals(taipeiToday(taipeiMorning), '2026-11-29')
  assertEquals(taipeiToday(new Date(taipeiMorning)), '2026-11-29')
  assertEquals(new Date(taipeiMorning).toISOString().slice(0, 10), '2026-11-28', '同一刻 UTC 日期還是投票日')
  assertEquals(policyStage(pledge(2026), [rec(2026, 'elected')], taipeiToday(taipeiMorning), dateOf), 'policy', '台北已過投票日＝政見')
  // 台北 2026-11-28 23:59 ＝ UTC 2026-11-28 15:59：兩邊都還是投票日
  assertEquals(taipeiToday(Date.parse('2026-11-28T15:59:00Z')), '2026-11-28')
  // 台北 2026-11-28 00:00 ＝ UTC 2026-11-27 16:00：台北已經是投票日、UTC 還是前一天
  assertEquals(taipeiToday(Date.parse('2026-11-27T16:00:00Z')), '2026-11-28')
})

Deno.test('投票日優先用查詢函式，沒給就用參選紀錄自帶的投票日', () => {
  const r: StageElectionRecord[] = [{ electionId: 2022, candidacyStatus: 'elected', electionDate: '2022-11-26' }]
  assertEquals(policyStage(pledge(2022), r, '2026-12-01'), 'policy')
  assertEquals(policyStage(pledge(2022), r, '2022-11-26'), 'pledge')
})

Deno.test('同一屆多筆參選紀錄：只要有一筆當選就是政見；別屆的紀錄不算', () => {
  assertEquals(policyStage(pledge(2022), [rec(2022, 'not_elected'), rec(2022, 'elected')], '2026-12-01', dateOf), 'policy')
  assertEquals(policyStage(pledge(2022), [rec(2026, 'elected')], '2026-12-01', dateOf), 'pending_result', '別屆當選不是這一屆當選')
})

Deno.test('底層函式跟 _shared/elected-term.ts 逐案一致（同一批資料、多個今天）', () => {
  const dateCases = [null, '2022-11-26', '2026-11-28', '2026-11-28T00:00:00Z', '']
  const statusCases: Array<Array<string | null>> = [[], ['elected'], ['not_elected'], [null], ['filed', 'elected'], ['withdrawn']]
  const todays = ['2022-11-25', '2022-11-26', '2022-11-27', '2026-11-27', '2026-11-28', '2026-11-29', '2030-01-01']
  let n = 0
  for (const d of dateCases) for (const s of statusCases) for (const today of todays) {
    assertEquals(isElectedTerm({ election_date: d, candidacy_statuses: s }, today), shared.isElectedTerm({ election_date: d, candidacy_statuses: s }, today), `${d} ${s} ${today}`)
    assertEquals(isElectionVoted(d, today), shared.isElectionVoted(d, today), `${d} ${today}`)
    n++
  }
  assertEquals(n, 5 * 6 * 7)
  for (const t of [0, Date.parse('2026-11-28T15:59:59Z'), Date.parse('2026-11-28T16:00:00Z'), Date.parse('2030-06-30T23:59:59Z')]) {
    assertEquals(taipeiToday(t), shared.taipeiToday(new Date(t)))
  }
})
