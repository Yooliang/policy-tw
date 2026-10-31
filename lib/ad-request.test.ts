import { assertEquals } from 'jsr:@std/assert@1'
import { cancelAd, pushAd, type AdInsLike } from './ad-request.ts'

function ins(over: Partial<{ isConnected: boolean; status: string | null }> = {}): AdInsLike {
  const status = over.status ?? null
  return {
    isConnected: over.isConnected ?? true,
    getAttribute: (name: string) => (name === 'data-adsbygoogle-status' ? status : null),
  }
}

Deno.test('pushAd：新的 <ins> 推一次', () => {
  const q: unknown[] = []
  assertEquals(pushAd(ins(), q), 'pushed')
  assertEquals(q.length, 1)
})

Deno.test('pushAd：同一個 <ins> 不會推第二次（連續換頁、載入器未到時不排重複的）', () => {
  const q: unknown[] = []
  const el = ins()
  assertEquals(pushAd(el, q), 'pushed')
  assertEquals(pushAd(el, q), 'already-pushed')
  assertEquals(pushAd(el, q), 'already-pushed')
  assertEquals(q.length, 1)
})

Deno.test('pushAd：換頁後的新 <ins> 照推（每頁一次）', () => {
  const q: unknown[] = []
  assertEquals(pushAd(ins(), q), 'pushed')
  assertEquals(pushAd(ins(), q), 'pushed')
  assertEquals(q.length, 2)
})

Deno.test('pushAd：載入器已處理過的 <ins> 不推', () => {
  const q: unknown[] = []
  assertEquals(pushAd(ins({ status: 'done' }), q), 'already-filled')
  assertEquals(q.length, 0)
})

Deno.test('pushAd：已不在 DOM 的 <ins>（頁面已換走）與沒有元素都不推', () => {
  const q: unknown[] = []
  assertEquals(pushAd(ins({ isConnected: false }), q), 'detached')
  assertEquals(pushAd(null, q), 'no-element')
  assertEquals(q.length, 0)
})

Deno.test('cancelAd：載入器未到時，被換掉的 <ins> 的請求從佇列抽掉（佇列長度＝DOM 裡的 <ins> 數）', () => {
  const q: unknown[] = []
  const a = ins(), b = ins(), c = ins()
  pushAd(a, q)
  assertEquals(cancelAd(a, q), true) // 換頁：a 被換掉
  pushAd(b, q)
  assertEquals(cancelAd(b, q), true)
  pushAd(c, q) // 現在 DOM 裡只剩 c
  assertEquals(q.length, 1)
})

Deno.test('cancelAd：請求已被消化、沒推過、載入器已到（佇列不是陣列）都什麼都不做', () => {
  const el = ins()
  assertEquals(cancelAd(el, []), false) // 沒推過
  const q: unknown[] = []
  pushAd(el, q)
  q.length = 0 // 載入器消化了
  assertEquals(cancelAd(el, q), false)
  const el2 = ins()
  pushAd(el2, [])
  assertEquals(cancelAd(el2, { push() {} } as unknown as unknown[]), false)
  assertEquals(cancelAd(null, q), false)
})
