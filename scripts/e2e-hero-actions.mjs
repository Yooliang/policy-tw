// Hero 動作列 Playwright 抽驗：政見頁／分析頁的動作列顆數（人物頁 hero 的查詢鈕已由各分頁的 AI 卡取代，2026-11-01），人物頁只留手機版不溢出、文案逐字、按下後就地狀態變化、
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
// 政見頁要挑「查進度」可以按的那種：還沒投票的競選承諾會顯示 hero-progress-blocked，沒有按鈕可測
const policyId = fs.readdirSync(path.join(ROOT, 'dist', 'policy'))
  .filter((f) => /^[0-9a-f-]{36}$/.test(f))
  .find((f) => {
    const file = path.join(ROOT, 'dist', 'policy', f, 'index.html')
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('data-testid="hero-progress"')
  })
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
    if (res.status() >= 400 && !AD_DOMAIN.test(res.url())) badResponses.push(`${res.status()} ${res.url()}`)
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
  // ---------- 桌面：政見頁 ----------
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const guard = attachConsoleGuard(page, '政見頁-desktop')
    const policyBodies = await routeRequestTask(page, 'queued')
    await page.goto(`http://localhost:${PORT}/policy/${policyId}`, { waitUntil: 'networkidle' })

    const progressBtn = page.locator('[data-testid="hero-progress"]')
    const communityBtn = page.locator('[data-testid="hero-community"]')
    const historyBtn = page.locator('[data-testid="hero-history"]')
    check(await progressBtn.count() === 1 && await communityBtn.count() === 1 && await historyBtn.count() === 1, '政見頁動作列（返回鈕不計）恰好 3 顆：查進度／民眾提問／查核履歷')
    // 施政中的政見叫「查進度」，已投票的競選承諾叫「查兌現情形」
    check(['查進度', '查兌現情形'].includes((await progressBtn.textContent()).trim()), `「查進度／查兌現情形」文案逐字：「${(await progressBtn.textContent()).trim()}」`)
    check((await communityBtn.textContent()).trim() === '民眾提問', `「民眾提問」文案逐字：「${(await communityBtn.textContent()).trim()}」`)
    check((await historyBtn.textContent()).trim() === '查核履歷', `「查核履歷」文案逐字：「${(await historyBtn.textContent()).trim()}」`)
    check((await communityBtn.getAttribute('href')).startsWith('/community?'), '「民眾提問」目的地維持 /community?filter=...')

    await progressBtn.click()
    await page.waitForFunction(() => document.querySelector('[data-testid="hero-progress"]')?.textContent.includes('已排入'))
    check((await progressBtn.textContent()).includes('已排入'), `「查進度」按下後狀態變化：「${(await progressBtn.textContent()).trim()}」`)
    check(policyBodies.length === 1 && policyBodies[0].kind === 'progress' && policyBodies[0].policy_id === policyId, `request-task 收到 kind=progress 與正確 policy_id（${JSON.stringify(policyBodies[0])}）`)
    check(page.url().includes(`/policy/${policyId}`), '「查進度」按下後留在政見頁，不跳去公民提問')

    // 「這不是承諾？／這不是政見？」（依那一條的階段）：按一下就建 policy_validity 任務，不跳頁、不用填文字
    const validityBtn = page.locator('[data-testid="hero-not-a-policy"]')
    await validityBtn.click()
    await page.waitForFunction(() => document.querySelector('[data-testid="hero-not-a-policy"]')?.textContent.includes('已排入'))
    check(policyBodies.length === 2 && policyBodies[1].kind === 'validity' && policyBodies[1].policy_id === policyId, `request-task 收到 kind=validity 與正確 policy_id（${JSON.stringify(policyBodies[1])}）`)
    check(page.url().includes(`/policy/${policyId}`), '「這不是承諾？／這不是政見？」按下後留在政見頁')
    check((await page.locator('a[href="/ai-assistant?tab=tasks"]').count()) >= 1, '送出後有連到任務看板（/ai-assistant?tab=tasks）的連結')

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
    check(await sourceBtn.count() === 1 && await progressBtn.count() === 1 && await auditBtn.count() === 1, '分析頁動作列（返回鈕不計）恰好 3 顆：承諾原文或政見原文／查進度／執行稽核')
    check(/^(承諾|政見)原文$/.test((await sourceBtn.textContent()).trim()), `「承諾原文／政見原文」（依那一條的階段）文案逐字：「${(await sourceBtn.textContent()).trim()}」`)
    check((await progressBtn.textContent()).trim() === '查進度', `「查進度」文案逐字：「${(await progressBtn.textContent()).trim()}」`)
    check((await auditBtn.textContent()).trim() === '執行稽核', `「執行稽核」文案逐字：「${(await auditBtn.textContent()).trim()}」`)
    check(await sourceBtn.getAttribute('href') === `/policy/${analysisId}`, `「承諾原文／政見原文」連到 /policy/${analysisId}`)

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
