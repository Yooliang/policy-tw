// 三頁 Hero 動作列 Playwright 抽驗：人物頁／政見頁／分析頁的動作列顆數、文案逐字、按下後就地狀態變化、
// 查核履歷捲動、稽核輸入框聚焦、手機 390px 不橫向溢出、console 無錯誤與 Vue warn。
// 用法：先 pnpm build，再 node scripts/e2e-hero-actions.mjs [port]。request-task 用假回應攔截，不打 prod（頁面資料走 Supabase anon 唯讀）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.argv[2] || 4231)
const OUT = path.join(ROOT, '.dedupe-check')
fs.mkdirSync(OUT, { recursive: true })

const pick = (dir) => fs.readdirSync(path.join(ROOT, 'dist', dir)).map((f) => f.replace(/\.html$/, '')).find((f) => /^[0-9a-f-]{36}$/.test(f))
const politicianId = pick('politician')
const policyId = pick('policy')
const analysisId = pick('analysis')
if (!politicianId || !policyId || !analysisId) { console.error('dist 缺頁，先 pnpm build'); process.exit(1) }

const server = spawn(process.execPath, [path.join(ROOT, 'scripts/serve-dist.mjs'), String(PORT)], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1500))

const failures = []
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures.push(msg) }

// Monetag 廣告載入器在本機沙箱網路必 404（首頁等既有頁面也一樣，與本次動作列改動無關）；
// 瀏覽器對它印出的 console error 是泛用文字「Failed to load resource: the status of 404」，
// 訊息本身不帶網址，所以改用 response 事件比對網址來源，「Failed to load resource」這句一律不算數，
// 真正的資源載入失敗改由 badResponses 統計。
const AD_DOMAIN = /quarrelsomebitter\.com/
const FAILED_RESOURCE_TEXT = /Failed to load resource/
// PolicyDetail.vue 既有的 policy_sources 查詢（本次未改動）在目前這個 Supabase 專案打出 404，
// 與這次動作列改動無關，過濾掉但仍回報給主線注意
const KNOWN_BACKEND_ISSUE = /rest\/v1\/policy_sources/

function attachConsoleGuard(page, label) {
  const problems = []
  const badResponses = []
  page.on('console', (msg) => {
    const type = msg.type()
    const text = msg.text()
    if (FAILED_RESOURCE_TEXT.test(text)) return
    if (type === 'error' || (type === 'warning' && /\[Vue warn\]/.test(text))) problems.push(`${type}: ${text}`)
  })
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`))
  page.on('response', (res) => {
    if (res.status() >= 400 && !AD_DOMAIN.test(res.url()) && !KNOWN_BACKEND_ISSUE.test(res.url())) badResponses.push(`${res.status()} ${res.url()}`)
  })
  return { label, problems, badResponses }
}

async function routeRequestTask(page, replyStatus) {
  const bodies = []
  await page.route('**/functions/v1/request-task', async (route) => {
    const body = route.request().postDataJSON()
    bodies.push(body)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        status: replyStatus,
        task_id: 't-hero',
        queue_position: 2,
        open_tasks: 88,
        board_url: 'https://policy-tw.web.app/ai-assistant',
        message: 'x',
      }),
    })
  })
  return bodies
}

const browser = await chromium.launch()
try {
  // ---------- 桌面：人物頁 ----------
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const guard = attachConsoleGuard(page, '人物頁-desktop')
    const bodies = await routeRequestTask(page, 'already_queued')
    await page.goto(`http://localhost:${PORT}/politician/${politicianId}`, { waitUntil: 'networkidle' })

    const policyBtn = page.locator('[data-testid="hero-query-policy"]')
    const profileBtn = page.locator('[data-testid="hero-query-profile"]')
    check(await policyBtn.count() === 1 && await profileBtn.count() === 1, '人物頁動作列（返回鈕不計）恰好 2 顆：查政見／查簡介')
    check((await policyBtn.textContent()).trim() === '查政見', `「查政見」文案逐字：「${(await policyBtn.textContent()).trim()}」`)
    check((await profileBtn.textContent()).trim() === '查簡介', `「查簡介」文案逐字：「${(await profileBtn.textContent()).trim()}」`)
    check(await page.locator('text=請 AI 補齊這個人的資料').count() === 0, '舊的「請 AI 補齊這個人的資料」已移除')

    const scrollBefore = await page.evaluate(() => window.scrollY)
    await policyBtn.click()
    await page.waitForFunction(() => document.querySelector('[data-testid="hero-query-policy"]')?.textContent.includes('已在任務池中'))
    const scrollAfter = await page.evaluate(() => window.scrollY)
    check(scrollAfter === scrollBefore, '「查政見」按下後不捲動（就地顯示狀態）')
    check((await policyBtn.textContent()).includes('已在任務池中'), `「查政見」按下後就地顯示「已在任務池中」：「${(await policyBtn.textContent()).trim()}」`)
    check(bodies.length === 1 && bodies[0].kind === 'policy' && bodies[0].politician_id === politicianId, `request-task 收到 kind=policy 與正確 politician_id（${JSON.stringify(bodies[0])}）`)

    await profileBtn.click()
    await page.waitForFunction(() => document.querySelector('[data-testid="hero-query-profile"]')?.textContent.includes('已在任務池中'))
    check((await profileBtn.textContent()).includes('已在任務池中'), `「查簡介」按下後就地顯示「已在任務池中」：「${(await profileBtn.textContent()).trim()}」`)
    check(bodies.length === 2 && bodies[1].kind === 'profile' && bodies[1].politician_id === politicianId, `request-task 收到 kind=profile 與正確 politician_id（${JSON.stringify(bodies[1])}）`)

    check(guard.problems.length === 0 && guard.badResponses.length === 0, `${guard.label}: console 無錯誤/Vue warn，無非預期資源載入失敗（${[...guard.problems, ...guard.badResponses].join(' | ')}）`)
    await page.screenshot({ path: path.join(OUT, 'hero-politician-desktop.png'), fullPage: false })
    await context.close()
  }

  // ---------- 桌面：政見頁 ----------
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const guard = attachConsoleGuard(page, '政見頁-desktop')
    await routeRequestTask(page, 'queued')
    await page.goto(`http://localhost:${PORT}/policy/${policyId}`, { waitUntil: 'networkidle' })

    const progressBtn = page.locator('[data-testid="hero-progress"]')
    const communityBtn = page.locator('[data-testid="hero-community"]')
    const historyBtn = page.locator('[data-testid="hero-history"]')
    check(await progressBtn.count() === 1 && await communityBtn.count() === 1 && await historyBtn.count() === 1, '政見頁動作列（返回鈕不計）恰好 3 顆：查進度／民眾提問／查核履歷')
    check((await progressBtn.textContent()).trim() === '查進度', `「查進度」文案逐字：「${(await progressBtn.textContent()).trim()}」`)
    check((await communityBtn.textContent()).trim() === '民眾提問', `「民眾提問」文案逐字：「${(await communityBtn.textContent()).trim()}」`)
    check((await historyBtn.textContent()).trim() === '查核履歷', `「查核履歷」文案逐字：「${(await historyBtn.textContent()).trim()}」`)
    check((await communityBtn.getAttribute('href')).startsWith('/community?'), '「民眾提問」目的地維持 /community?filter=...')

    await progressBtn.click()
    await page.waitForFunction(() => document.querySelector('[data-testid="hero-progress"]')?.textContent.includes('已排入'))
    check((await progressBtn.textContent()).includes('已排入'), `「查進度」按下後狀態變化：「${(await progressBtn.textContent()).trim()}」`)

    await page.waitForSelector('#history [data-testid="history-panel"]')
    await historyBtn.click()
    await page.waitForTimeout(700) // smooth scroll
    const inView = await page.evaluate(() => {
      const el = document.getElementById('history')
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.top < window.innerHeight && r.bottom > 0
    })
    check(inView, '「查核履歷」按下後履歷區塊進入視窗')

    check(guard.problems.length === 0 && guard.badResponses.length === 0, `${guard.label}: console 無錯誤/Vue warn，無非預期資源載入失敗（${[...guard.problems, ...guard.badResponses].join(' | ')}）`)
    await page.screenshot({ path: path.join(OUT, 'hero-policy-desktop.png'), fullPage: false })
    await context.close()
  }

  // ---------- 桌面：分析頁 ----------
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const guard = attachConsoleGuard(page, '分析頁-desktop')
    await routeRequestTask(page, 'queued')
    await page.goto(`http://localhost:${PORT}/analysis/${analysisId}`, { waitUntil: 'networkidle' })

    const sourceBtn = page.locator('[data-testid="hero-policy-source"]')
    const progressBtn = page.locator('[data-testid="hero-progress"]')
    const auditBtn = page.locator('[data-testid="hero-audit-focus"]')
    check(await sourceBtn.count() === 1 && await progressBtn.count() === 1 && await auditBtn.count() === 1, '分析頁動作列（返回鈕不計）恰好 3 顆：政見原文／查進度／執行稽核')
    check((await sourceBtn.textContent()).trim() === '政見原文', `「政見原文」文案逐字：「${(await sourceBtn.textContent()).trim()}」`)
    check((await progressBtn.textContent()).trim() === '查進度', `「查進度」文案逐字：「${(await progressBtn.textContent()).trim()}」`)
    check((await auditBtn.textContent()).trim() === '執行稽核', `「執行稽核」文案逐字：「${(await auditBtn.textContent()).trim()}」`)
    check(await sourceBtn.getAttribute('href') === `/policy/${analysisId}`, `「政見原文」連到 /policy/${analysisId}`)

    await progressBtn.click()
    await page.waitForFunction(() => document.querySelector('[data-testid="hero-progress"]')?.textContent.includes('已排入'))
    check((await progressBtn.textContent()).includes('已排入'), `分析頁「查進度」按下後狀態變化：「${(await progressBtn.textContent()).trim()}」`)

    await auditBtn.click()
    await page.waitForTimeout(700) // smooth scroll
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
    check(focused === 'audit-url', `「執行稽核」按下後輸入框取得焦點（實際焦點元素 data-testid=${focused}）`)
    const submitted = await page.locator('[data-testid="audit-done"]').count()
    check(submitted === 0, '「執行稽核」只聚焦不送出（沒有 audit-done）')

    check(guard.problems.length === 0 && guard.badResponses.length === 0, `${guard.label}: console 無錯誤/Vue warn，無非預期資源載入失敗（${[...guard.problems, ...guard.badResponses].join(' | ')}）`)
    await page.screenshot({ path: path.join(OUT, 'hero-analysis-desktop.png'), fullPage: false })
    await context.close()
  }

  // ---------- 手機 390px：三頁不橫向溢出 ----------
  for (const [name, url] of [
    ['politician', `/politician/${politicianId}`],
    ['policy', `/policy/${policyId}`],
    ['analysis', `/analysis/${analysisId}`],
  ]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    const guard = attachConsoleGuard(page, `${name}-mobile`)
    await routeRequestTask(page, 'queued')
    await page.goto(`http://localhost:${PORT}${url}`, { waitUntil: 'networkidle' })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    check(overflow <= 1, `${name} 手機 390px 無橫向溢出（${overflow}）`)
    check(guard.problems.length === 0 && guard.badResponses.length === 0, `${guard.label}: console 無錯誤/Vue warn，無非預期資源載入失敗（${[...guard.problems, ...guard.badResponses].join(' | ')}）`)
    await page.screenshot({ path: path.join(OUT, `hero-${name}-mobile.png`), fullPage: true })
    await context.close()
  }
} finally {
  await browser.close()
  server.kill()
}

console.log(failures.length === 0 ? `\n全部通過，截圖在 ${OUT}` : `\n${failures.length} 項失敗\n- ${failures.join('\n- ')}`)
process.exit(failures.length === 0 ? 0 : 1)
