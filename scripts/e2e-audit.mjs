// 政見深度分析頁（/analysis/:policyId）「執行稽核」Playwright 抽驗：空白時按鈕 disabled、網址不合格顯示錯誤、
// 合格時打 request-task kind=audit 帶 source_url／policy_id／politician_id、成功文案＋看板連結。
// 用法：先 pnpm build，再 node scripts/e2e-audit.mjs [port]。request-task 用假回應攔截，不打 prod（頁面資料走 Supabase anon 唯讀）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.argv[2] || 4194)
const OUT = path.join(ROOT, '.dedupe-check')
fs.mkdirSync(OUT, { recursive: true })

// 從 SSG 輸出挑一條真的政見頁
const analysisDir = path.join(ROOT, 'dist/analysis')
const policyId = fs.readdirSync(analysisDir).map((f) => f.replace(/\.html$/, '')).find((f) => /^[0-9a-f-]{36}$/.test(f))
if (!policyId) { console.error('dist/analysis 沒有政見頁，先 pnpm build'); process.exit(1) }

const server = spawn(process.execPath, [path.join(ROOT, 'scripts/serve-dist.mjs'), String(PORT)], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1500))

const failures = []
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures.push(msg) }

const browser = await chromium.launch()
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const bodies = []
  await page.route('**/functions/v1/request-task', async (route) => {
    const body = route.request().postDataJSON()
    bodies.push(body)
    const dup = body.source_url.includes('dup')
    await route.fulfill({
      status: dup ? 200 : 201, contentType: 'application/json',
      body: JSON.stringify({ success: true, status: dup ? 'already_queued' : 'queued', task_id: 't-audit', queue_position: 3, open_tasks: 230, board_url: 'https://policy-tw.web.app/ai-assistant', message: 'x' }),
    })
  })
  await page.goto(`http://localhost:${PORT}/analysis/${policyId}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="audit-url"]', { timeout: 20000 })

  const input = page.locator('[data-testid="audit-url"]')
  const submit = page.locator('[data-testid="audit-submit"]')
  check(await submit.isDisabled(), '空白時「執行稽核」disabled')

  await input.fill('gov.taipei/news/123')
  check(!(await submit.isDisabled()), '有輸入後按鈕可按')
  await submit.click()
  await page.waitForSelector('[data-testid="audit-error"]')
  check((await page.locator('[data-testid="audit-error"]').textContent()).includes('http'), '網址不合格 → 輸入框下方顯示錯誤')
  check(bodies.length === 0, '網址不合格時不打 request-task')

  await input.fill('https://www.gov.taipei/News_Content.aspx?n=1&s=2')
  await submit.click()
  await page.waitForSelector('[data-testid="audit-done"]')
  const sent = bodies[0]
  check(sent?.kind === 'audit' && sent.source_url === 'https://www.gov.taipei/News_Content.aspx?n=1&s=2', 'request-task 收到 kind=audit 與 source_url')
  check(sent?.policy_id === policyId && typeof sent.politician_id === 'string', `帶頁面情境 policy_id=${policyId.slice(0, 8)}… 與 politician_id`)
  const done = await page.locator('[data-testid="audit-done"]').textContent()
  check(done.includes('已加入任務池') && done.includes('3 件'), `成功文案：${done.trim().replace(/\s+/g, ' ')}`)
  check((await page.locator('[data-testid="audit-done"] a').getAttribute('href')) === '/ai-assistant', '成功文案帶看板連結')

  await input.fill('https://example.org/dup.pdf')
  await submit.click()
  await page.waitForFunction(() => document.querySelector('[data-testid="audit-done"]')?.textContent.includes('已在任務池'))
  check(true, '重複網址 → 「已在任務池中」文案')

  await page.screenshot({ path: path.join(OUT, 'deep-analysis-audit.png'), fullPage: false })
  await context.close()
} finally {
  await browser.close()
  server.kill()
}
console.log(failures.length === 0 ? `\n全部通過，截圖在 ${OUT}` : `\n${failures.length} 項失敗`)
process.exit(failures.length === 0 ? 0 : 1)
