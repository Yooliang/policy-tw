/**
 * 查核履歷的前端 fetch 不得帶自訂標頭：apikey／Authorization／Content-Type 都會讓瀏覽器對跨網域 GET 先發 OPTIONS 預檢，
 * history 一次載入就變成兩次呼叫（2026-11-27 實測 GET 與 OPTIONS 各約一半）。函式是公開唯讀（verify_jwt=false），不需要這些標頭。
 * 這個專案的測試跑在 Deno、不載 Vite 的 import.meta.env，所以照原始碼守門。
 */
import { assert, assertFalse } from 'jsr:@std/assert@1'

const src = Deno.readTextFileSync(new URL('./history.ts', import.meta.url))
const fetchLine = src.split('\n').find((l) => l.includes('/functions/v1/history?')) ?? ''

Deno.test('fetchHistory 找得到呼叫那一行', () => {
  assert(fetchLine.includes('fetch('), '找不到 history 的 fetch 呼叫，守門失效')
})

Deno.test('fetchHistory 不帶 headers（避免 CORS 預檢）', () => {
  assertFalse(/headers\s*:/i.test(fetchLine), 'fetch 帶了 headers，會觸發預檢')
  assertFalse(/apikey|authorization|content-type/i.test(fetchLine))
})

Deno.test('history.ts 不再組 apikey／Authorization 標頭', () => {
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assertFalse(/apikey/i.test(code), 'history.ts 程式碼不應出現 apikey')
  assertFalse(/Authorization/.test(code), 'history.ts 程式碼不應出現 Authorization')
})
