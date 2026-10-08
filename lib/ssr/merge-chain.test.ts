/// <reference lib="deno.ns" />
/**
 * 已合併人物的舊網址（#466，2026-10-08 陳瑩 54472fee 被併進 8aa6ee40 後，線上人物頁回 404）。守三件事：
 *   1. 被合併的 id 要走到保留者（redirect），不是 404
 *   2. 合併鏈（A→B→C）一路走到底；成環、斷鏈、太長都不轉（broken），不能無限迴圈
 *   3. 沒被合併的人、查無此人，一律不是 redirect（呼叫端照原本的規則處理）
 */
import { assertEquals } from 'jsr:@std/assert@1'
import { followMerged, isPoliticianId, MAX_MERGE_HOPS, type MergeLookup } from './merge-chain.ts'

const table = (rows: Record<string, string | null>): MergeLookup => async (id) =>
  id in rows ? { id, mergedInto: rows[id] } : null

Deno.test('被合併的人 → 轉向保留者', async () => {
  const lookup = table({ loser: 'keeper', keeper: null })
  assertEquals(await followMerged('loser', lookup), { kind: 'redirect', to: 'keeper' })
})

Deno.test('合併鏈一路走到底', async () => {
  const lookup = table({ a: 'b', b: 'c', c: null })
  assertEquals(await followMerged('a', lookup), { kind: 'redirect', to: 'c' })
})

Deno.test('沒被合併、查無此人 → live（不轉向）', async () => {
  const lookup = table({ solo: null })
  assertEquals(await followMerged('solo', lookup), { kind: 'live' })
  assertEquals(await followMerged('nobody', lookup), { kind: 'live' })
})

Deno.test('保留者查不到、成環、超過跳數 → broken', async () => {
  assertEquals(await followMerged('a', table({ a: 'ghost' })), { kind: 'broken' })
  assertEquals(await followMerged('a', table({ a: 'b', b: 'a' })), { kind: 'broken' })
  assertEquals(await followMerged('a', table({ a: 'a' })), { kind: 'broken' })
  const long: Record<string, string | null> = {}
  for (let i = 0; i <= MAX_MERGE_HOPS + 2; i++) long[`n${i}`] = `n${i + 1}`
  long[`n${MAX_MERGE_HOPS + 3}`] = null
  assertEquals(await followMerged('n0', table(long)), { kind: 'broken' })
})

Deno.test('大小寫不同的 id 也算同一個（成環判斷）', async () => {
  assertEquals(await followMerged('AA', table({ AA: 'aa', aa: 'AA' })), { kind: 'broken' })
})

Deno.test('不是 uuid 的人物 id 不問資料庫（一律 404，不是 SSR 錯誤）', async () => {
  assertEquals(isPoliticianId('54472fee-1dc4-475c-a104-64529aa0797a'), true)
  assertEquals(isPoliticianId('54472FEE-1DC4-475C-A104-64529AA0797A'), true)
  for (const bad of ['12345', 'undefined', 'not-a-uuid', '', '54472fee-1dc4-475c-a104-64529aa0797', '54472fee-1dc4-475c-a104-64529aa0797a1', ' 54472fee-1dc4-475c-a104-64529aa0797a', "x'; drop table politicians;--"]) {
    assertEquals(isPoliticianId(bad), false, bad)
  }
  // 守在載入器入口、在任何查詢之前（接線）：入口第一行就 return null
  const loaders = await Deno.readTextFile(new URL('./loaders.ts', import.meta.url))
  assertEquals(/export async function loadPoliticianPage\(id: string\)[^{]*\{\s*(\/\/[^\n]*\n\s*)?if \(!isPoliticianId\(id\)\) return null/.test(loaders), true)
})

Deno.test('已合併的第一跳用手上的列，不再多查一次', async () => {
  const loaders = await Deno.readTextFile(new URL('./loaders.ts', import.meta.url))
  assertEquals(/followMerged\(id, first\)/.test(loaders), true)
  assertEquals(/followMerged\(id, mergeLookup\)/.test(loaders), false)
})

Deno.test('接線：人物頁載入器查不到時走 followMerged，entry-server 把轉向變成 301', async () => {
  const loaders = await Deno.readTextFile(new URL('./loaders.ts', import.meta.url))
  assertEquals(/followMerged\(id, first\)/.test(loaders), true)
  assertEquals(/redirectTo: `\/politician\/\$\{moved\.to\}`/.test(loaders), true)
  const entry = await Deno.readTextFile(new URL('../../entry-server.ts', import.meta.url))
  assertEquals(/status: 301, location: snapshot\.redirectTo/.test(entry), true)
})
