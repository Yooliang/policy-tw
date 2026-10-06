import { assertEquals } from 'jsr:@std/assert@1'
import { pushAd, type AdInsLike } from './ad-request.ts'

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
