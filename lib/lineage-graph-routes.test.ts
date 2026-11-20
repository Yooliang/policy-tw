/**
 * 脈絡完整關係圖（/lineage/:lineageId/graph，#675 第四期）的路由、渲染與收錄守門——計畫書 5.3 節那一整張表。
 *   路由 → 邊緣載入器不認得 → Worker SSR_ROUTES 不比對 → Firebase 轉殼檔 → usePageHead 的 canonical → Worker 標頭
 *   → 預渲染清單不含 → 網站地圖與建置檢查 → 主頁有連結
 * 還原驗證（做過的結果寫在 PR 說明）：①SSR_ROUTES 放寬成 ^\/lineage\/ ②collectRoutePaths 加 /graph ③postbuild 拿掉檢查再塞 /graph ④usePageHead 不傳 canonical。
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1'
import { pageUrlOf } from './page-url.ts'
import { lineageEdgePaths } from './ssg/lineage-routes.ts'
import { lineageGraphPath, lineagePath, HANDOVER_BADGE, HANDOVER_LABEL } from './lineage.ts'
import { compileRewrites, rewriteFor } from '../scripts/firebase-rewrites.mjs'
import { graphUrlsIn, isGraphRoute, lineageSitemapMatch } from '../scripts/sitemap-graph-guard.mjs'

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url)).then((s) => s.replace(/\r\n/g, '\n'))
const ID = '8b1c0f5e-1111-4222-8333-444455556666'

Deno.test('路由：/lineage/:lineageId/graph 叫 lineage-graph，排在 lineage 後面，元件用 () => import() 分包', async () => {
  const router = await read('../router/index.ts')
  const main = router.indexOf("path: '/lineage/:lineageId',")
  const graph = router.indexOf("path: '/lineage/:lineageId/graph',")
  assert(main > 0 && graph > main, 'graph 要排在 lineage 後面')
  const block = router.slice(graph, router.indexOf('},', graph))
  assert(block.includes("name: 'lineage-graph'"))
  assert(block.includes("component: () => import('../pages/LineageGraphPage.vue')"), '關係圖頁要分包')
  assertEquals(lineageGraphPath(ID), `/lineage/${ID}/graph`)
})

Deno.test('邊緣載入器：loadPageData 對 lineage-graph 回 undefined（預設分支，不新增 case）→ Worker 退回代理', async () => {
  const src = await read('./ssr/loaders.ts')
  const fn = src.slice(src.indexOf('export async function loadPageData'))
  const cases = [...fn.matchAll(/case '([^']+)':/g)].map((m) => m[1])
  assertEquals(cases, ['politician', 'policy', 'lineage'], '只有三種頁在邊緣渲染，沒有 lineage-graph')
  assert(/default: return undefined/.test(fn), '預設分支回 undefined')
  assertFalse(fn.includes('graph'))
})

function ssrRoutes(workerSource: string): RegExp[] {
  const literal = workerSource.match(/const SSR_ROUTES = (\[[^\n]*\])/)![1]
  return new Function(`return ${literal}`)() as RegExp[]
}

Deno.test('Worker SSR_ROUTES：主頁比對得到、/graph 比對不到（走代理，不邊緣渲染）', async () => {
  const routes = ssrRoutes(await read('../cloudflare/ssr-worker.js'))
  assert(routes.some((re) => re.test(`/lineage/${ID}`)), '主頁要在邊緣渲染')
  assert(routes.some((re) => re.test(`/lineage/${ID}/`)))
  assertFalse(routes.some((re) => re.test(`/lineage/${ID}/graph`)), '/graph 不得被 SSR_ROUTES 比對到')
  assertFalse(routes.some((re) => re.test(`/lineage/${ID}/graph/`)))
  // 放寬成 ^\/lineage\/ 就會紅（還原驗證用的樣子）
  const relaxed = [/^\/lineage\//]
  assert(relaxed.some((re) => re.test(`/lineage/${ID}/graph`)), '前提：放寬後的寫法確實會比對到 /graph，所以上面那條才有守門作用')
})

Deno.test('Firebase：/lineage/<id>/graph 轉到 /app.html（殼檔，200＋noindex），不是 404', async () => {
  const firebase = JSON.parse(await Deno.readTextFile(new URL('../firebase.json', import.meta.url)))
  const rules = compileRewrites(firebase.hosting.rewrites)
  assertEquals(rewriteFor(rules, `/lineage/${ID}/graph`), '/app.html')
  assertEquals(rewriteFor(rules, `/lineage/${ID}`), '/app.html')
})

Deno.test('usePageHead：canonical 選項存在、網址由 pageUrlOf 算（預設是本頁路由，給了站內路徑就指過去；不是站內路徑的退回本頁）', async () => {
  const site = 'https://xn--2lw665d.tw'
  assertEquals(pageUrlOf(site, `/lineage/${ID}/graph`), `${site}/lineage/${ID}/graph`, '不給 canonical 就指自己（這就是第四期要避免的）')
  assertEquals(pageUrlOf(site, `/lineage/${ID}/graph`, lineagePath(ID)), `${site}/lineage/${ID}`)
  assertEquals(pageUrlOf(site, '/a', 'https://evil.example/x'), `${site}/a`)
  assertEquals(pageUrlOf(site, '/a', '//evil.example/x'), `${site}/a`)
  const head = await read('../composables/usePageHead.ts')
  assert(head.includes('canonical?: MaybeRefOrGetter<string | undefined>'))
  assert(head.includes('pageUrlOf(SITE_URL, route.path, toValue(options.canonical))'), 'canonical 與 og:url 都由同一個 pageUrl 來')
  assert(head.includes('{ rel: \'canonical\', href: pageUrl.value }') && head.includes("{ property: 'og:url', content: pageUrl.value }"))
})

Deno.test('關係圖頁的 head：noindex、canonical 指主頁（og:url 同）', async () => {
  const page = await read('../pages/LineageGraphPage.vue')
  const call = page.slice(page.indexOf('usePageHead({'))
  assert(/noindex: true,/.test(call), '關係圖頁要 noindex')
  assert(call.includes('canonical: () => lineagePath(lineageId.value)'), 'canonical 要指主頁')
})

Deno.test('預渲染：collectRoutePaths 不含 /graph（沒有列的動態路由不會預渲染）', async () => {
  const paths = lineageEdgePaths([{ id: ID }, { id: 'x' }])
  assertEquals(paths, [`/lineage/${ID}`, '/lineage/x'])
  assertFalse(paths.some(isGraphRoute))
  const server = await read('./ssg/server-data.ts')
  assertFalse(/\/graph/.test(server.replace(/\/\/.*$/gm, '')), 'server-data 的清單不得出現 /graph')
  assert(server.includes('lineageEdgePaths(full.lineages'))
})

Deno.test('網站地圖：群組比對排除 /graph；任何網址以 /graph 結尾就讓 build 紅', async () => {
  assert(lineageSitemapMatch(`/lineage/${ID}`))
  assertFalse(lineageSitemapMatch(`/lineage/${ID}/graph`), '關係圖不得被分進 sitemap-policies')
  assert(isGraphRoute(`/lineage/${ID}/graph`) && isGraphRoute(`https://xn--2lw665d.tw/lineage/${ID}/graph/`))
  assertFalse(isGraphRoute(`/lineage/${ID}`) || isGraphRoute('/graphs') || isGraphRoute(`/lineage/${ID}/graph/x`))
  assertEquals(graphUrlsIn([`/lineage/${ID}`, `/lineage/${ID}/graph`]), [`/lineage/${ID}/graph`])
  assertEquals(graphUrlsIn([`/lineage/${ID}`, '/policy/p']), [])
  const post = await read('../scripts/postbuild-ssg.mjs')
  assert(post.includes('lineageSitemapMatch(r)'), '群組比對要用排除 /graph 的版本')
  assert(post.includes('graphUrlsIn(entries.map((e) => e.loc))'), '建置檢查：寫出去的網站地圖網址不得以 /graph 結尾')
  assert(/graphUrlsIn\([^)]*\)[\s\S]{0,400}fail\(/.test(post), '檢查到了要 fail（讓 build 紅）')
})

Deno.test('交接詞彙與顏色（計畫書 5.2）：照舊做綠、改做法藍、縮小黃、停掉紅、重新開始紫', () => {
  assertEquals({ ...HANDOVER_LABEL }, { keep: '照舊做', pivot: '改做法', shrink: '縮小', stop: '停掉', resume: '重新開始' })
  const hue = (c: string) => c.match(/text-(\w+)-\d+/)![1]
  assertEquals(Object.fromEntries(Object.entries(HANDOVER_BADGE).map(([k, v]) => [k, hue(v)])), { keep: 'emerald', pivot: 'blue', shrink: 'amber', stop: 'red', resume: 'violet' })
})
