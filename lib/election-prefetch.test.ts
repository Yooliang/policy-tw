import { assertEquals } from 'jsr:@std/assert@1'
import { electionPageLoadArgs } from './election-prefetch.ts'

const none = () => undefined
const byList = (seg: unknown) => (seg === '2022-12-18_rerun_10020' ? 10020 : undefined)

Deno.test('全台頁：縣市吃全站目前的縣市、鄉鎮是 All', () => {
  assertEquals(electionPageLoadArgs({ electionId: '2026' }, none, 'All'), { electionId: 2026, region: 'All', subRegion: 'All' })
  assertEquals(electionPageLoadArgs({ electionId: '2026' }, none, '新竹縣'), { electionId: 2026, region: '新竹縣', subRegion: 'All' })
})

Deno.test('縣市頁：網址上的縣市優先於全站縣市', () => {
  assertEquals(electionPageLoadArgs({ electionId: '2026', region: '新竹縣' }, none, '台南市'), { electionId: 2026, region: '新竹縣', subRegion: 'All' })
})

Deno.test('鄉鎮頁：縣市合法時鄉鎮才算；縣市不合法時鄉鎮也不算', () => {
  assertEquals(electionPageLoadArgs({ electionId: '2026', region: '新竹縣', subRegion: ' 竹北市 ' }, none, 'All'), { electionId: 2026, region: '新竹縣', subRegion: '竹北市' })
  assertEquals(electionPageLoadArgs({ electionId: '2026', region: '亂寫', subRegion: '竹北市' }, none, 'All'), { electionId: 2026, region: 'All', subRegion: 'All' })
  assertEquals(electionPageLoadArgs({ electionId: '2026', region: '新竹縣', subRegion: 'All' }, none, 'All')?.subRegion, 'All')
})

Deno.test('選舉 id：清單裡找得到用清單的；key 網址清單沒載入就不預先發；陣列參數取第一個', () => {
  assertEquals(electionPageLoadArgs({ electionId: '2022-12-18_rerun_10020' }, byList, 'All')?.electionId, 10020)
  assertEquals(electionPageLoadArgs({ electionId: '2022-12-18_rerun_10020' }, none, 'All'), null)
  assertEquals(electionPageLoadArgs({ electionId: ['2024'] }, none, 'All')?.electionId, 2024)
})
