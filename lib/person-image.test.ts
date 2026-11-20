/**
 * #975：人物頁本人沒有照片時，別人的照片不能被圖片搜尋當成本頁主圖。
 * 這個專案的測試跑在 Deno、不載 .vue，所以分兩層：純函式照行為測，.vue 範本照原始碼守門。
 */
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { cssUrl, robotsContent, shouldNoImageIndex } from './person-image.ts'

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url))

Deno.test('本人無照片才 noimageindex；資料還沒到不加；有照片不加', () => {
  assertEquals(shouldNoImageIndex({ avatarUrl: null }), true)
  assertEquals(shouldNoImageIndex({ avatarUrl: '' }), true)
  assertEquals(shouldNoImageIndex({}), true)
  assertEquals(shouldNoImageIndex({ avatarUrl: 'https://example.com/a.jpg' }), false)
  assertEquals(shouldNoImageIndex(null), false)
  assertEquals(shouldNoImageIndex(undefined), false)
})

Deno.test('robots 標籤：noindex 與 noimageindex 並存、互不影響', () => {
  assertEquals(robotsContent({}), undefined)
  assertEquals(robotsContent({ noindex: true }), 'noindex')
  assertEquals(robotsContent({ noimageindex: true }), 'noimageindex')
  assertEquals(robotsContent({ noindex: true, noimageindex: true }), 'noindex, noimageindex')
})

Deno.test('cssUrl：引號、括號、換行不能跳出 style 屬性', () => {
  assertEquals(cssUrl('https://a.example/x.jpg'), 'url("https://a.example/x.jpg")')
  const evil = cssUrl('https://a.example/x");background:red;("')
  const inner = evil.slice(5, -2)
  assertEquals(/["()\\\n]/.test(inner), false,`未編碼的引號或括號：${evil}`)
})

Deno.test('usePageHead：noimageindex 選項存在且走 robotsContent', () => {
  const src = read('../composables/usePageHead.ts')
  assertStringIncludes(src, 'noimageindex?: MaybeRefOrGetter<boolean | undefined>')
  assertStringIncludes(src, 'robotsContent({ noindex: !!toValue(options.noindex), noimageindex: !!toValue(options.noimageindex) })')
})

Deno.test('守門 ②：人物頁用本人有無照片決定 noimageindex', () => {
  const page = read('../pages/PoliticianProfile.vue')
  assertStringIncludes(page, 'noimageindex: () => shouldNoImageIndex(politician.value)')
})

Deno.test('守門 ①③：人物頁上別人的人像不是 <img>，本人頭像仍是 <img>（Avatar）', () => {
  const page = read('../pages/PoliticianProfile.vue')
  const tpl = page.slice(page.indexOf('<template>'))
  assertEquals(/<img\b/.test(tpl), false, '人物頁範本不能直接寫 <img>')
  // 每一個 PoliticianGrid（別人）都要帶 portrait-as-background
  const grids = tpl.match(/<PoliticianGrid\b[^>]*>/g) ?? []
  assert(grids.length >= 1, '找不到 PoliticianGrid')
  for (const g of grids) assertStringIncludes(g, 'portrait-as-background')
  // 本人頭像：Avatar 吃 politician.avatarUrl，Avatar 內部是 <img>
  assertStringIncludes(tpl, '<Avatar :src="politician.avatarUrl" :name="politician.name"')
  assertStringIncludes(read('../components/Avatar.vue'), '<img')
  // 範本裡其他 Avatar 一律是本人（不能把別人的 Avatar 放進人物頁）
  const avatars = tpl.match(/<Avatar\b[^>]*>/g) ?? []
  for (const a of avatars) assertStringIncludes(a, 'politician.avatarUrl')
})

Deno.test('守門：PoliticianGrid 背景圖分支是 span role=img，<img> 只在 v-else 分支', () => {
  const grid = read('../pages/election/PoliticianGrid.vue')
  const tpl = grid.slice(grid.indexOf('<template>'))
  const imgs = tpl.match(/<img\b[^>]*>|<img\b[\s\S]*?\/>/g) ?? []
  assertEquals(imgs.length, 1, 'PoliticianGrid 應只剩一個 <img>（一般卡片用）')
  assertStringIncludes(imgs[0] ?? '', 'v-else')
  const spanAt = tpl.indexOf('v-if="portraitAsBackground"')
  assert(spanAt >= 0 && spanAt < tpl.indexOf('<img'), '背景圖分支要在 <img> 前面')
  const span = tpl.slice(tpl.lastIndexOf('<span', spanAt), tpl.indexOf('</span>', spanAt))
  assertStringIncludes(span, 'role="img"')
  assertStringIncludes(span, ':aria-label="politician.name"')
  assertStringIncludes(span, 'backgroundImage: cssUrl(')
  assertEquals(/<img\b/.test(span), false)
})

Deno.test('守門：不動其他頁——選舉頁、鄉鎮頁的卡片不帶 portrait-as-background', () => {
  for (const f of ['../pages/ElectionPage.vue', '../pages/election/ChipFilteredGroups.vue']) {
    assertEquals(read(f).includes('portrait-as-background'), false, f)
  }
})

Deno.test('JSON-LD Person.image 只在本人有公開照片時才輸出', () => {
  const page = read('../pages/PoliticianProfile.vue')
  assertStringIncludes(page, '...(publicImageUrl(politician.value.avatarUrl) ? { image: publicImageUrl(politician.value.avatarUrl) } : {}),')
})
