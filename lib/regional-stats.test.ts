/**
 * 地方基本統計（#508）的前端揀選邏輯。守住：地名比對用 sameRegionName（臺／台、空白都當同一個地方，
 * 不是嚴格 ===），缺的指標不在陣列裡（前端顯示「未調查」），同一指標取最新年度。
 */
import { assertEquals } from 'jsr:@std/assert@1'
import { pickRegionalStat, regionalStatsFor, type RegionalStat } from './regional-stats.ts'

function stat(partial: Partial<RegionalStat>): RegionalStat {
  return {
    id: 's-1', adminCode: '65000', level: 'county', region: '台中市', subRegion: null,
    statKey: 'population', year: 2024, value: 2800000, unit: '人', asOf: null, sourceUrl: 'https://example.gov.tw',
    ...partial,
  }
}

Deno.test('pickRegionalStat：地名比對用 sameRegionName，臺／台寫法都算同一個地方', () => {
  const rows = [stat({ region: '臺中市' })]
  assertEquals(pickRegionalStat(rows, '台中市', null, 'population')?.value, 2800000)
  assertEquals(pickRegionalStat(rows, '臺中市', null, 'population')?.value, 2800000)
})

Deno.test('pickRegionalStat：鄉鎮層級要 subRegion 也對上；縣市層級（subRegion=null）不會配到鄉鎮的列', () => {
  const rows = [
    stat({ level: 'town', region: '台中市', subRegion: '大里區', statKey: 'area_km2', value: 28, unit: '平方公里' }),
    stat({ level: 'county', region: '台中市', subRegion: null, statKey: 'area_km2', value: 2215, unit: '平方公里' }),
  ]
  assertEquals(pickRegionalStat(rows, '台中市', '大里區', 'area_km2')?.value, 28)
  assertEquals(pickRegionalStat(rows, '台中市', null, 'area_km2')?.value, 2215)
  assertEquals(pickRegionalStat(rows, '台中市', '臺中市大里區', 'area_km2'), null, '鄉鎮名稱沒對上就不該亂配到縣市層級的列')
})

Deno.test('pickRegionalStat：同一指標有多個年度，取最新那一年', () => {
  const rows = [
    stat({ year: 2022, value: 2700000 }),
    stat({ year: 2024, value: 2800000 }),
    stat({ year: 2023, value: 2750000 }),
  ]
  assertEquals(pickRegionalStat(rows, '台中市', null, 'population')?.year, 2024)
})

Deno.test('pickRegionalStat：查無資料回 null（前端顯示「未調查」，不是 0）', () => {
  assertEquals(pickRegionalStat([], '台中市', null, 'population'), null)
})

Deno.test('regionalStatsFor：缺的指標不在陣列裡；有的指標都列出來', () => {
  const rows = [
    stat({ statKey: 'population', value: 2800000, unit: '人' }),
    stat({ statKey: 'aging_rate', value: 21.5, unit: '%' }),
  ]
  const found = regionalStatsFor(rows, '台中市', null)
  assertEquals(found.map((f) => f.statKey).sort(), ['aging_rate', 'population'])
})
