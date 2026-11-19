/**
 * lib/keyset-segments.ts：id 切段並行撈取。
 *   1. 並行版與循序版撈到同一個集合、同一個順序（用假資料表、小頁面逼出多頁）
 *   2. 切段互不重疊、不留縫（任何 uuid 恰好落在一段）
 *   3. 空表、剛好整頁、一列都沒有的段
 */
import { assertEquals } from 'jsr:@std/assert@1'
import { fetchKeysetAll, uuidSegments, type IdSegment, type KeysetQuery } from './keyset-segments.ts'

/** 可重現的亂數（mulberry32） */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function uuids(n: number, seed: number): string[] {
  const r = rng(seed)
  const hex = (len: number) => Array.from({ length: len }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('')
  return Array.from({ length: n }, () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`)
}

/** 假的資料表：依 id 排序，支援 gt／gte／lt 與 limit，跟 PostgREST 的行為一致 */
function fakeTable(ids: string[], pageSize: number, calls: KeysetQuery[] = []) {
  const sorted = [...ids].sort().map((id) => ({ id }))
  return (q: KeysetQuery) => {
    calls.push(q)
    const rows = sorted
      .filter((r) => (q.after !== null ? r.id > q.after : q.gte === null || r.id >= q.gte))
      .filter((r) => q.lt === null || r.id < q.lt)
      .slice(0, pageSize)
    return Promise.resolve(rows)
  }
}

Deno.test('並行版與循序版撈到同一個集合、同一個順序', async () => {
  const ids = uuids(3000, 1)
  for (const pageSize of [1000, 100, 7]) {
    const sequential = await fetchKeysetAll(fakeTable(ids, pageSize), 1, pageSize)
    assertEquals(sequential.map((r) => r.id), [...ids].sort())
    for (const parallel of [2, 4, 8, 16]) {
      const par = await fetchKeysetAll(fakeTable(ids, pageSize), parallel, pageSize)
      assertEquals(par.map((r) => r.id), sequential.map((r) => r.id), `parallel=${parallel} pageSize=${pageSize}`)
    }
  }
})

Deno.test('並行版真的切成 16 段、各段各發查詢', async () => {
  const calls: KeysetQuery[] = []
  await fetchKeysetAll(fakeTable(uuids(500, 2), 1000, calls), 16)
  assertEquals(calls.length, 16)
  assertEquals(new Set(calls.map((c) => `${c.gte}|${c.lt}`)).size, 16)
})

Deno.test('切段互不重疊、不留縫：每個 id 恰好落在一段', () => {
  for (const n of [1, 2, 4, 8, 16]) {
    const segs = uuidSegments(n)
    assertEquals(segs.length, n)
    assertEquals(segs[0].gte, null)
    assertEquals(segs[n - 1].lt, null)
    for (let i = 1; i < n; i++) assertEquals(segs[i].gte, segs[i - 1].lt) // 前一段的上界就是下一段的下界
    const inSeg = (id: string, s: IdSegment) => (s.gte === null || id >= s.gte) && (s.lt === null || id < s.lt)
    for (const id of ['00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff', '7fffffff-ffff-ffff-ffff-ffffffffffff', '80000000-0000-0000-0000-000000000000', ...uuids(200, 3)]) {
      assertEquals(segs.filter((s) => inSeg(id, s)).length, 1, `${n} 段、${id}`)
    }
  }
})

Deno.test('不合法的段數當循序（1 段）', () => {
  assertEquals(uuidSegments(5).length, 1)
  assertEquals(uuidSegments(0).length, 1)
})

Deno.test('空表回空陣列；剛好整頁會再問一次才知道沒了', async () => {
  assertEquals(await fetchKeysetAll(fakeTable([], 1000), 16), [])
  const calls: KeysetQuery[] = []
  const rows = await fetchKeysetAll(fakeTable(uuids(10, 4), 10, calls), 1, 10)
  assertEquals(rows.length, 10)
  assertEquals(calls.length, 2)
})
