import { assert, assertEquals } from 'jsr:@std/assert@1'
import { mapSourceRefs, primarySourceUrl, selfEvidenceLabel, SOURCE_LEVEL_LABEL, sourceDisplayName, trimPolicySources } from './sources.ts'
import type { Policy, RawSourceRef, SourceRef } from '../types.ts'

// #347 第二階段 A：前端讀出處表。新表優先、舊欄位 source_url 是退路。

const BULLETIN = 'https://eebulletin.cec.gov.tw/111/a.pdf'
const ARCHIVE = 'https://web.archive.org/web/20261001000000/https://eebulletin.cec.gov.tw/111/a.pdf'
const NEWS = 'https://news.ltn.com.tw/n1'
const OWN = 'https://www.candidate-wang.tw/policy'

Deno.test('出處：主要在前、帶等級與存檔網址；沒有值的欄位不放（快照不長出空欄）', () => {
  const raw: RawSourceRef[] = [
    { url: NEWS, role: 'supporting', kind: 'media', title: null, publisher: '自由時報', archive_url: null },
    { url: BULLETIN, role: 'primary', kind: 'official', title: '選舉公報', archive_url: ARCHIVE, published_date: '2022-11-01' },
    { url: OWN, role: 'supporting', kind: 'self', self_evidence: 'mutual_link' },
  ]
  const got = mapSourceRefs(raw, 'https://old.example/ignored')
  assertEquals(got.map((s) => s.url), [BULLETIN, NEWS, OWN])
  assertEquals(got[0], { url: BULLETIN, title: '選舉公報', publishedDate: '2022-11-01', kind: 'official', archiveUrl: ARCHIVE, role: 'primary' })
  assertEquals(got[1], { url: NEWS, publisher: '自由時報', kind: 'media', role: 'supporting' })
  assertEquals(got[2], { url: OWN, kind: 'self', selfEvidence: 'mutual_link', role: 'supporting' })
  assert(!('archiveUrl' in got[1]) && !('title' in got[1]), '沒有存檔、沒有標題就不放這兩個鍵')
})

Deno.test('出處：舊欄位是退路——視圖沒有 sources 欄、或是空的，用 source_url 補一筆（沒有等級、不標小標籤）', () => {
  for (const raw of [undefined, null, []]) {
    assertEquals(mapSourceRefs(raw, NEWS), [{ url: NEWS, role: 'primary' }])
  }
  assertEquals(mapSourceRefs(undefined, null), [])
  assertEquals(mapSourceRefs(undefined, ''), [])
  assertEquals(mapSourceRefs(undefined, '不是網址'), [])
  assertEquals(mapSourceRefs([{ url: BULLETIN, role: 'primary', kind: 'official' }], NEWS).map((s) => s.url), [BULLETIN], '出處表有就不再加舊欄位')
})

Deno.test('出處：壞資料略過（不是網址、重複、等級不是四種之一就不標等級）', () => {
  const got = mapSourceRefs([
    { url: '不是網址' }, { url: BULLETIN, kind: 'official', role: 'primary' }, { url: BULLETIN, kind: 'media', role: 'supporting' },
    { url: NEWS, kind: '亂寫' }, { url: OWN, archive_url: '不是網址', kind: 'other', role: 'supporting' },
  ])
  assertEquals(got.map((s) => s.url), [BULLETIN, NEWS, OWN])
  assertEquals(got[0].kind, 'official', '重複的以第一次出現的為準')
  assertEquals(got[1].kind, undefined)
  assert(!('archiveUrl' in got[2]))
})

Deno.test('主要出處網址：出處表的主要出處優先於舊欄位；沒有主要出處才退回舊欄位', () => {
  const sources = mapSourceRefs([{ url: BULLETIN, role: 'primary' }, { url: NEWS, role: 'supporting' }])
  assertEquals(primarySourceUrl(sources, NEWS), BULLETIN)
  assertEquals(primarySourceUrl([{ url: NEWS, role: 'supporting' }], 'https://old.example/1'), 'https://old.example/1', '只有佐證時，主要出處仍是舊欄位的值')
  assertEquals(primarySourceUrl(undefined, ' https://old.example/1 '), 'https://old.example/1')
  assertEquals(primarySourceUrl(undefined, null), undefined)
  assertEquals(primarySourceUrl([], ''), undefined)
})

Deno.test('顯示名稱：標題 → 發布者 → 網站網域；本人來源的認定根據只在 self 才有提示', () => {
  assertEquals(sourceDisplayName({ url: NEWS, title: '標題', publisher: '自由時報', role: 'primary' }), '標題')
  assertEquals(sourceDisplayName({ url: NEWS, publisher: '自由時報', role: 'primary' }), '自由時報')
  assertEquals(sourceDisplayName({ url: 'https://www.cna.com.tw/a', role: 'primary' }), 'cna.com.tw')
  assertEquals(selfEvidenceLabel('self', 'mutual_link'), '與本人官網互相連結')
  assertEquals(selfEvidenceLabel('self', 'linked_by_official'), '議會、選委會或政黨官網有連結到這個網址')
  assertEquals(selfEvidenceLabel('media', 'mutual_link'), null)
  assertEquals(selfEvidenceLabel('self', null), null)
  assertEquals(Object.values(SOURCE_LEVEL_LABEL), ['官方', '本人', '媒體', '其他'])
})

const policy = (id: string, withSources: boolean): Policy => ({
  id, politicianId: 'p', title: id, description: '', category: '', status: 'Campaign Pledge' as Policy['status'], proposedDate: null, lastUpdated: '2026-01-01',
  sourceUrl: NEWS, progress: 0, tags: [], stanceSupport: 0, stanceOppose: 0, stancePriority: 0,
  ...(withSources ? { sources: [{ url: NEWS, role: 'primary' as const, kind: 'media' as const }] satisfies SourceRef[] } : {}),
  logs: [{ id: 1, date: '2026-01-02', event: 'e', sourceUrl: NEWS, ...(withSources ? { sources: [{ url: NEWS, role: 'primary' as const }] } : {}) }],
})

Deno.test('預渲染快照：首頁等清單頁整份政見的出處清單拿掉（sourceUrl 留著）；政見頁自己那一筆保留', () => {
  const snap = { policies: [policy('a', true), policy('b', true)], other: 1 }
  const list = trimPolicySources(snap)
  assert(list.policies.every((p) => !('sources' in p) && p.sourceUrl === NEWS && p.logs.every((l) => !('sources' in l) && l.sourceUrl === NEWS)))
  assertEquals(list.other, 1)
  const page = trimPolicySources(snap, 'b')
  assertEquals(page.policies[0].sources, undefined)
  assertEquals(page.policies[1].sources?.length, 1, '政見頁自己那一筆要留')
  assertEquals(page.policies[1].logs[0].sources?.length, 1)
  // 沒有出處清單的快照原樣回傳（不多拷貝）
  const plain = { policies: [policy('c', false)] }
  assert(trimPolicySources(plain) === plain)
  // 不改動傳進來的物件
  assertEquals(snap.policies[0].sources?.length, 1)
})
