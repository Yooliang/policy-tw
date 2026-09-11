// 查核履歷 Playwright 抽驗：政見頁／人物頁／分析頁的「查核履歷」區塊（預設展開、標題帶筆數、時間軸每筆可個別收合看驗證者與改動）、
// 政見頁有 applied 紀錄時標題徽章「已查核 · N 筆」且點擊會捲到履歷區塊、空狀態顯示來源、手機不破版。
// 用法：先 pnpm build，再 node scripts/e2e-history.mjs [port]。history 端點用 fixture 攔截（scripts/fixtures/history-policy.json），不打 prod；頁面資料走 Supabase anon 唯讀。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.argv[2] || 4220)
const OUT = path.join(ROOT, '.dedupe-check')
fs.mkdirSync(OUT, { recursive: true })
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/history-policy.json'), 'utf8'))
// fixture 3 筆：1 筆 disputed（裁決中）、2 筆 applied（已上線）→ 徽章應顯示「已查核 · 2 筆」
const appliedCount = fixture.entries.filter((e) => e.status === 'applied').length

const pick = (dir) => fs.readdirSync(path.join(ROOT, 'dist', dir)).map((f) => f.replace(/\.html$/, '')).find((f) => /^[0-9a-f-]{36}$/.test(f))
const policyId = pick('policy')
const politicianId = pick('politician')
const analysisId = pick('analysis')
if (!policyId || !politicianId || !analysisId) { console.error('dist 缺頁，先 pnpm build'); process.exit(1) }

const server = spawn(process.execPath, [path.join(ROOT, 'scripts/serve-dist.mjs'), String(PORT)], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1500))

const failures = []
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures.push(msg) }

async function routeHistory(page, body) {
  await page.route('**/functions/v1/history**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }))
}

const browser = await chromium.launch()
try {
  for (const viewport of [{ width: 1280, height: 900, name: 'desktop' }, { width: 390, height: 844, name: 'mobile' }]) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
    const page = await context.newPage()
    const requests = []
    page.on('request', (r) => { if (r.url().includes('/functions/v1/history')) requests.push(new URL(r.url()).search) })
    await routeHistory(page, fixture)

    // 政見頁
    await page.goto(`http://localhost:${PORT}/policy/${policyId}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="history-panel"]', { timeout: 20000 })
    check(requests.some((q) => q.includes('target=policy') && q.includes(`id=${policyId}`)), `${viewport.name}: 政見頁打 history?target=policy&id=<本頁政見>`)
    await page.waitForSelector('[data-testid="history-list"]', { timeout: 20000 })
    check(await page.locator('[data-testid="history-body"]').count() === 1, `${viewport.name}: 預設展開（不用點開就看得到列表）`)
    const toggleText = await page.locator('[data-testid="history-toggle"]').textContent()
    check(toggleText.includes('查核履歷（3 筆）'), `${viewport.name}: 標題帶筆數「${toggleText.trim().replace(/\s+/g, ' ')}」`)
    check(await page.locator('[data-testid="history-entry"]').count() === 3, `${viewport.name}: 展開列 3 筆`)
    check((await page.locator('[data-testid="history-entry"]').first().textContent()).includes('裁決中'), `${viewport.name}: 最新一筆是裁決中的更正`)

    // 徽章：有 2 筆 applied → 標題區顯示「已查核 · 2 筆」，點擊平滑捲到履歷區塊
    const badge = page.locator('[data-testid="history-badge"]')
    check(await badge.count() === 1, `${viewport.name}: 有 applied 紀錄時顯示查核徽章`)
    const badgeText = (await badge.textContent()).trim().replace(/\s+/g, ' ')
    check(badgeText.includes('已查核') && badgeText.includes(`${appliedCount} 筆`), `${viewport.name}: 徽章顯示「${badgeText}」`)
    await page.evaluate(() => window.scrollTo(0, 0))
    await badge.click()
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="history-panel"]')
      return !!el && el.getBoundingClientRect().top <= 150
    }, { timeout: 3000 }).catch(() => null)
    const rect = await page.locator('[data-testid="history-panel"]').boundingBox()
    check(!!rect && rect.y <= 150, `${viewport.name}: 點擊徽章後捲動到履歷區塊（top=${rect?.y}）`)

    // 個別項目仍可各自收合展開
    await page.locator('[data-testid="history-entry"]').nth(2).locator('button').first().click()
    await page.waitForSelector('[data-testid="history-entry-detail"]')
    check(await page.locator('[data-testid="verifier"]').count() === 2, `${viewport.name}: 再展開看到 2 位驗證者`)
    check((await page.locator('[data-testid="verifier"]').nth(1).textContent()).includes('中央社報導第二段有寫'), `${viewport.name}: 驗證者理由顯示`)
    const progressEntry = page.locator('[data-testid="history-entry"]').nth(1)
    await progressEntry.locator('button').first().click()
    check(await progressEntry.locator('[data-testid="edit-list"] li').count() === 3, `${viewport.name}: 進度更新那筆列 3 處改動（舊值→新值）`)
    const editText = await progressEntry.locator('[data-testid="edit-list"]').textContent()
    check(editText.includes('進度') && editText.includes('40'), `${viewport.name}: 改動顯示欄位與新值`)
    const corrEntry = page.locator('[data-testid="history-entry"]').nth(0)
    await corrEntry.locator('button').first().click()
    check((await corrEntry.locator('[data-testid="adjudication-list"]').textContent()).includes('裁決任務已建立'), `${viewport.name}: 裁決中的更正顯示裁決任務`)
    // 收合單筆後應仍留在展開的整體區塊中（單筆收合不影響整體展開狀態）
    await corrEntry.locator('button').first().click()
    check(await page.locator('[data-testid="history-body"]').count() === 1, `${viewport.name}: 收合單筆項目後整體區塊仍展開`)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    check(overflow <= 1, `${viewport.name}: 無橫向溢出（${overflow}）`)
    await page.screenshot({ path: path.join(OUT, `history-policy-${viewport.name}.png`), fullPage: true })

    if (viewport.name === 'desktop') {
      // 人物頁
      await page.goto(`http://localhost:${PORT}/politician/${politicianId}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="history-panel"]', { timeout: 20000 })
      check(requests.some((q) => q.includes('target=politician') && q.includes(`id=${politicianId}`)), '人物頁打 history?target=politician&id=<本頁人物>')
      check((await page.locator('[data-testid="history-toggle"]').textContent()).includes('資料來源與查核履歷'), '人物頁區塊標題「資料來源與查核履歷」')
      check(await page.locator('[data-testid="history-body"]').count() === 1, '人物頁履歷區塊也預設展開')
      // 分析頁
      await page.goto(`http://localhost:${PORT}/analysis/${analysisId}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="history-panel"]', { timeout: 20000 })
      check(requests.some((q) => q.includes('target=policy') && q.includes(`id=${analysisId}`)), '分析頁打 history?target=policy&id=<該分析的政見>')
      await page.screenshot({ path: path.join(OUT, 'history-analysis-desktop.png'), fullPage: false })
    }
    await context.close()
  }

  // 空狀態：沒有貢獻紀錄 → 預設展開時直接顯示來源說明，不留空白；政見頁不顯示查核徽章
  const emptyBody = { ...fixture, total: 0, count: 0, entries: [], origin: { kind: 'imported', note: '早期由 AI 搜尋匯入，尚未經過貢獻流程；來源見下方網址', source_url: 'https://www.cec.gov.tw/bulletin.pdf' } }
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  await routeHistory(page, emptyBody)
  await page.goto(`http://localhost:${PORT}/policy/${policyId}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="history-empty"]')
  const empty = await page.locator('[data-testid="history-empty"]').textContent()
  check(empty.includes('尚未經過 AI 貢獻流程') && empty.includes('bulletin.pdf'), '政見頁預設展開時空狀態直接列來源網址，不留空白')
  check(await page.locator('[data-testid="history-badge"]').count() === 0, '沒有 applied 紀錄時不顯示查核徽章')

  // 人物頁空狀態同樣維持來源說明呈現
  await page.goto(`http://localhost:${PORT}/politician/${politicianId}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="history-empty"]')
  const emptyPolitician = await page.locator('[data-testid="history-empty"]').textContent()
  check(emptyPolitician.includes('尚未經過 AI 貢獻流程') && emptyPolitician.includes('bulletin.pdf'), '人物頁無紀錄時同樣直接顯示來源說明，不留空白')
  await context.close()
} finally {
  await browser.close()
  server.kill()
}
console.log(failures.length === 0 ? `\n全部通過，截圖在 ${OUT}` : `\n${failures.length} 項失敗`)
process.exit(failures.length === 0 ? 0 : 1)
