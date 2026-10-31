import { assert, assertEquals } from 'jsr:@std/assert@1'

/**
 * 載入順序守門（2026-10-31）：這四條是「改了就會悄悄變慢」的，行為上看不出來，只能守原始碼的形狀。
 * 每一條都做過還原驗證（把改動拿掉測試會紅）。
 */
const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url))
const head = (html: string) => html.slice(html.indexOf('<head>'), html.indexOf('</head>'))

Deno.test('1. 第三方腳本不在 <head> 直接載入，而是等 window load 之後再延遲插入', async () => {
  const h = head(await read('../index.html'))
  for (const host of ['googletagmanager.com/gtag/js', 'googlesyndication.com/pagead', 'cdn.adotone.com']) {
    assert(h.includes(host), `${host} 應該還在（延遲插入的清單裡）`)
    const staticTag = new RegExp(`<script[^>]*\ssrc=["'][^"']*${host.replace(/[./]/g, '\$&')}`)
    assert(!staticTag.test(h), `${host} 不能是 <head> 裡的靜態 <script src>——會跟首屏搶頻寬`)
  }
  assert(h.includes("addEventListener('load'"), '要等 window load')
  assert(/setTimeout\(function \(\) \{[\s\S]*?\}, 1500\)/.test(h), 'load 之後要再等約 1.5 秒')
  assert(h.includes('requestIdleCallback'), '要等瀏覽器閒下來')
})

Deno.test('1b. gtag() 與 dataLayer 要先建好（延後載入前的事件才不會丟）、AdSense 版位 push 照舊排隊', async () => {
  const h = head(await read('../index.html'))
  assert(h.indexOf('function gtag()') >= 0 && h.indexOf('function gtag()') < h.indexOf('loadThirdParty'))
  assert(h.includes("gtag('config', 'G-ED8EZ1503S')"))
  assert(h.includes('var ConverlyCustomData'), 'adotone 要的全域變數要在它載入前就有')
  const slot = await read('../components/AdSlot.vue')
  assert(slot.includes('w.adsbygoogle = w.adsbygoogle || []'), '版位要對陣列 push（載入器晚到時排隊）')
})

Deno.test('2. 候選人請求在路由解析時先發、載入函式以同一組參數去重', async () => {
  const router = await read('../router/index.ts')
  assert(router.includes('prefetchElectionPage('), 'router 要預先發起選舉頁資料')
  assert(/router\.beforeEach\(\(to\) => \{[\s\S]*?prefetchElectionPage/.test(router))
  const sb = await read('../composables/useSupabase.ts')
  assert(sb.includes('inflightLoads.get(cacheKey)'), 'loadPoliticiansByElection 要接手飛行中的同一個 promise')
})

Deno.test('3. get_election_types 與候選人查詢並行，不能先 await 前者', async () => {
  const sb = await read('../composables/useSupabase.ts')
  const body = sb.slice(sb.indexOf('async function runLoadPoliticians'))
  const typesAt = body.indexOf("rpc('get_election_types'")
  const pagesAt = body.indexOf('fetchAllPages<RawPolitician>')
  const awaitTypesAt = body.indexOf('await typesRequest')
  assert(typesAt > 0 && pagesAt > 0 && awaitTypesAt > 0)
  assert(pagesAt < awaitTypesAt, '候選人查詢要在 await 職位表之前就發出去')
  assertEquals(/await\s+supabase\s*\.rpc\('get_election_types'/.test(body), false)
})

Deno.test('4. 次要資料（政見清單、選舉區對應、基本統計）不在掛載當下抓，要排在第一批卡片之後', async () => {
  const page = await read('../pages/ElectionPage.vue')
  const mounted = page.slice(page.indexOf('onMounted(() => {'), page.indexOf('onActivated('))
  assert(mounted.includes('runAfterRender('))
  const before = mounted.slice(0, mounted.indexOf('runAfterRender('))
  for (const fn of ['ensurePolicies()', 'ensureDistricts()', 'ensureOfficialRegionalStats()']) {
    assertEquals(before.includes(fn), false, `${fn} 不能在 runAfterRender 之前呼叫`)
  }
  assert(mounted.includes('firstCards'), '要等候選人那批卡片')
  assert(page.includes('defer-load'), '基本統計面板在這一頁不能自己抓')
})
