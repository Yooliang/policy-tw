/**
 * 全部政見頁按縣市載入（migration 20261119120000，lib/policy-region-counts.ts）：
 *   1. 方塊格的加總（全台、全部分類在前端加；沒有分類的列只算進全部分類）
 *   2. migration 內容守門：視圖建了、權限與 security_invoker、縣市與 listed 的式子與前端同一份規則
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { categoryTotal, regionTotal, type RegionCountRow } from './policy-region-counts.ts'

const rows: RegionCountRow[] = [
  { region: '新北市', category: '交通建設', listed: 10 },
  { region: '新北市', category: '社會福利', listed: 5 },
  { region: '新北市', category: null, listed: 2 },
  { region: '台北市', category: '交通建設', listed: 7 },
  { region: '全國', category: '能源', listed: 3 },
]

Deno.test('縣市合計：全台＝所有列；單一縣市只算該縣市', () => {
  assertEquals(regionTotal(rows, 'All'), 27)
  assertEquals(regionTotal(rows, '新北市'), 17)
  assertEquals(regionTotal(rows, '桃園市'), 0)
})

Deno.test('帶分類時只算那個分類；沒有分類的列只在「全部分類」裡', () => {
  assertEquals(regionTotal(rows, 'All', '交通建設'), 17)
  assertEquals(regionTotal(rows, '新北市', '交通建設'), 10)
  assertEquals(categoryTotal(rows, '新北市', 'All'), 17)
  assertEquals(categoryTotal(rows, 'All', '社會福利'), 5)
})

const sql = Deno.readTextFileSync(new URL('../supabase/migrations/20261119120000_policies_by_region.sql', import.meta.url))

Deno.test('migration：兩支視圖都建、security_invoker、anon／authenticated 可讀', () => {
  for (const v of ['policies_by_region', 'policy_region_category_counts']) {
    assert(sql.includes(`CREATE OR REPLACE VIEW ${v} AS`), `${v} 沒建`)
    assert(sql.includes(`ALTER VIEW ${v} SET (security_invoker = on)`), `${v} 沒設 security_invoker`)
    assert(sql.includes(`GRANT SELECT ON ${v} TO anon, authenticated`), `${v} 沒給讀取權限`)
  }
})

Deno.test('migration：縣市的算法與 politicians_with_elections 同一個式子，只取未移除的政見', () => {
  assert(sql.split('COALESCE(r.region, po.region)').length - 1 >= 3, '兩支視圖都要用同一個縣市式子（選取與分組）')
  assertEquals(sql.split('LEFT JOIN regions r ON r.id = po.region_id').length - 1, 2)
  assert(sql.split('removed_at IS NULL').length - 1 >= 2)
})

Deno.test('migration：listed 與 lib/policy-stage.ts 同一份規則（來源是不是承諾、那一屆已投票且當選）', () => {
  assert(sql.includes("CASE WHEN COALESCE(pl.origin, '') <> '' THEN pl.origin = 'pledge' ELSE pl.status = 'Campaign Pledge' END"))
  assert(sql.includes('e.election_date < activity_today()'), '投票日當天算還沒投票：要用「早於今天」')
  assert(sql.includes("q.candidacy_status = 'elected'"))
  assert(sql.includes('q.election_id = pl.election_id'), '當選要看政見所屬的那一屆')
})

Deno.test('migration：不重建索引（politicians(region)、policies(politician_id) 已有）', () => {
  assert(!/CREATE\s+(UNIQUE\s+)?INDEX/i.test(sql))
})
