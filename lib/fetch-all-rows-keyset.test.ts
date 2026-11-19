// 守門：fetchAllRows 依 id 排序時要用 keyset（接著上一頁最後一個 id 往後讀），不要退回 OFFSET 分頁。
// 2026-11-15 正式庫實測 politicians_with_elections 最後一頁 OFFSET 6.3 秒、keyset 0.34 秒，匿名角色 statement_timeout 3 秒，退回 OFFSET 預渲染建置會逾時。
import { assert } from 'jsr:@std/assert@1'

const src = await Deno.readTextFile(new URL('../composables/useSupabase.ts', import.meta.url))
const body = src.slice(src.indexOf('export async function fetchAllRows'), src.indexOf('// snake_case → camelCase'))

Deno.test('fetchAllRows：依 id 排序走 keyset（.gt id ＋ .limit），不是 .range', () => {
  assert(body.length > 0, '找不到 fetchAllRows')
  assert(/const keyset = orderBy === 'id'/.test(body), '依 id 排序要走 keyset 分支')
  assert(/\.gt\('id'/.test(body), 'keyset 分支要用 .gt(\'id\', 上一頁最後一個 id)')
  const keysetPart = body.slice(body.indexOf('if (keyset)'), body.indexOf('while (!finished)'))
  assert(!keysetPart.includes('.range('), 'keyset 分支不能用 .range（OFFSET）')
})
