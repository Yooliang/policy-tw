// 載入行為的 Playwright 抽驗（issue #17 #18 #22 #23）：
// 沒圖表的頁不載 ApexCharts、首頁圖表仍會出、Supabase 掛掉時顯示「重試」而不是「找不到」、
// 真的不存在的 id 有 noindex、預渲染頁不再重撈基礎資料。
// 用法：先 pnpm build（SSG_POLITICIANS=with-content 也可），再 node scripts/e2e-loading.mjs [port]。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.argv[2] || 4196)

const policyDir = path.join(ROOT, 'dist/policy')
const policyId = fs.readdirSync(policyDir).find((f) => /^[0-9a-f-]{36}$/.test(f))
if (!policyId) { console.error('dist/policy 沒有政見頁，先 pnpm build'); process.exit(1) }

const server = spawn(process.execPath, [path.join(ROOT, 'scripts/serve-dist.mjs'), String(PORT)], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1500))

const failures = []
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures.push(msg) }
const base = `http://localhost:${PORT}`

const browser = await chromium.launch()
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })

  // 1. 隱私頁：不該載 ApexCharts，也不該重撈基礎資料（快照夠新）
  {
    const page = await context.newPage()
    const urls = []
    page.on('request', (r) => urls.push(r.url()))
    await page.goto(`${base}/privacy`, { waitUntil: 'networkidle' })
    check(!urls.some((u) => /apexcharts/i.test(u)), '隱私頁沒有載 vue3-apexcharts chunk')
    check(!urls.some((u) => /\/rest\/v1\/(elections|election_types|categories|locations)\b/.test(u)), '隱私頁沒有重撈 elections／categories／locations')
    check(await page.locator('nav').count() > 0, '隱私頁有渲染出導覽列')
    await page.close()
  }

  // 2. 首頁：圖表元件自己載 ApexCharts，圖要畫得出來
  {
    const page = await context.newPage()
    const urls = []
    page.on('request', (r) => urls.push(r.url()))
    await page.goto(`${base}/`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.apexcharts-canvas', { timeout: 15000 }).catch(() => {})
    check(urls.some((u) => /apexcharts/i.test(u)), '首頁有載 vue3-apexcharts chunk')
    check(await page.locator('.apexcharts-canvas').count() > 0, '首頁圖表有畫出來')
    await page.close()
  }

  // 3. 不存在的政見 id：Supabase 正常時顯示「找不到」＋ noindex
  {
    const page = await context.newPage()
    await page.goto(`${base}/policy/does-not-exist`, { waitUntil: 'networkidle' })
    await page.getByText('找不到該政見').waitFor({ timeout: 15000 })
    const robots = await page.locator('meta[name="robots"]').getAttribute('content')
    check(robots === 'noindex', `不存在的政見頁有 <meta robots=noindex>（實際：${robots}）`)
    await page.close()
  }

  // 4. Supabase 拿不到：顯示重試，不冒充「找不到」；恢復後按重試才變成「找不到」
  {
    const page = await context.newPage()
    let blocked = true
    await page.route('**/rest/v1/**', (route) => blocked ? route.abort('failed') : route.continue())
    await page.goto(`${base}/policy/does-not-exist`, { waitUntil: 'networkidle' })
    const retryButton = page.getByRole('button', { name: '重試' })
    await retryButton.waitFor({ timeout: 20000 }).catch(() => {})
    check(await retryButton.count() > 0, 'Supabase 失敗時顯示「重試」按鈕')
    check(await page.getByText('找不到該政見').count() === 0, 'Supabase 失敗時不顯示「找不到該政見」')
    blocked = false
    await retryButton.click()
    await page.getByText('找不到該政見').waitFor({ timeout: 15000 })
    check(true, '恢復後按重試變成真正的「找不到」')
    await page.close()
  }

  // 5. 預渲染的政見頁：Supabase 掛掉也要能顯示內容（快照本來就有）
  {
    const page = await context.newPage()
    await page.route('**/rest/v1/**', (route) => route.abort('failed'))
    await page.goto(`${base}/policy/${policyId}`, { waitUntil: 'networkidle' })
    const title = await page.locator('h1').first().textContent()
    check((title || '').trim().length > 0, `預渲染政見頁在 Supabase 掛掉時仍顯示標題（${(title || '').trim().slice(0, 20)}）`)
    check(await page.getByText('找不到該政見').count() === 0, '預渲染政見頁不會顯示「找不到」')
    await page.close()
  }
} finally {
  await browser.close()
  server.kill()
}

if (failures.length) { console.error(`\n${failures.length} 項失敗`); process.exit(1) }
console.log('\n全部通過')
