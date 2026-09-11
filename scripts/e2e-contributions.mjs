// 貢獻看板（/ai-assistant）Playwright 抽驗：列表有資料、篩選可用、任務分頁與維護者面板可用、手機寬度不破版。
// 用法：先 pnpm build，再 node scripts/e2e-contributions.mjs [port]
//   - 用 scripts/serve-dist.mjs 模擬 Firebase（/ai-assistant rewrite 到 app.html）
//   - contributions-feed／tasks／apply 端點全部用 fixture 攔截（scripts/fixtures/），不打 prod
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.argv[2] || 4191)
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/contributions-feed.json'), 'utf8'))
const tasksFixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/contributions-tasks.json'), 'utf8'))
const OUT = path.join(ROOT, '.dedupe-check')
fs.mkdirSync(OUT, { recursive: true })

const server = spawn(process.execPath, [path.join(ROOT, 'scripts/serve-dist.mjs'), String(PORT)], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1500))

const failures = []
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures.push(msg) }

async function routeFeed(page, feedRequests) {
  await page.route('**/functions/v1/contributions-feed**', async (route) => {
    const url = new URL(route.request().url())
    feedRequests.push(url.search)
    const status = url.searchParams.get('status') || 'all'
    const type = url.searchParams.get('type') || ''
    const agent = url.searchParams.get('agent_name') || ''
    const ATTENTION = ['disputed']
    const matchStatus = (it) => status === 'all' || (status === 'attention' ? ATTENTION.includes(it.status) : it.status === status)
    const items = fixture.items.filter((it) => matchStatus(it) && (!type || it.contribution_type === type) && (!agent || it.agent_name === agent))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...fixture, items, count: items.length, has_more: false, next_cursor: null }) })
  })
}
const historyFixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/history-policy.json'), 'utf8'))
async function routeHistory(page) {
  await page.route('**/functions/v1/history**', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('id')
    const entry = historyFixture.entries.find((e) => e.id === id) ?? { ...historyFixture.entries[2], id }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...historyFixture, target: 'contribution', id, total: 1, count: 1, entries: [entry] }) })
  })
}
async function routeTasks(page, taskRequests = []) {
  await page.route('**/functions/v1/tasks**', async (route) => {
    taskRequests.push(new URL(route.request().url()).search)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tasksFixture) })
  })
}

const browser = await chromium.launch()
try {
  for (const viewport of [{ width: 1280, height: 900, name: 'desktop' }, { width: 390, height: 844, name: 'mobile' }]) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
    const page = await context.newPage()
    const feedRequests = []
    await routeFeed(page, feedRequests)
    await routeTasks(page)
    await routeHistory(page)

    await page.goto(`http://localhost:${PORT}/ai-assistant`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="feed-list"], [data-testid="empty"], [data-testid="error"]', { timeout: 15000 })

    const count = await page.locator('[data-testid="feed-item"]').count()
    check(count === fixture.items.length, `${viewport.name}: 列表有 ${count} 筆（fixture ${fixture.items.length}）`)
    check((await page.locator('[data-testid="stats"] p.text-2xl').allTextContents()).join(',').includes(String(fixture.summary.by_status.applied)), `${viewport.name}: 統計卡顯示 applied=${fixture.summary.by_status.applied}`)
    check(await page.locator('text=還差').count() >= 1, `${viewport.name}: pending 項顯示「還差 N 票」`)
    check((await page.locator('[data-testid="stat-adjudicating"]').getAttribute('data-alert')) === 'true' && (await page.locator('[data-testid="stat-adjudicating"] p.text-2xl').textContent()).trim() === String(fixture.summary.adjudicating), `${viewport.name}: 「裁決中」=${fixture.summary.adjudicating} 且亮提示色`)
    check((await page.locator('[data-testid="stat-contributors"] p.text-2xl').textContent()).trim() === String(fixture.summary.contributors_30d), `${viewport.name}: 貢獻者（近 30 天）=${fixture.summary.contributors_30d}`)
    check(!(await page.locator('[data-testid="stats"]').textContent()).includes('你'), `${viewport.name}: 統計卡文案沒有「你」`)
    await page.locator('[data-testid="stat-adjudicating"]').click()
    await page.waitForSelector('[data-testid="task-list"], [data-testid="task-empty"]')
    check(await page.locator('[data-testid="task-type-filter"]').inputValue() === 'adjudicate', `${viewport.name}: 點「裁決中」卡 → 任務分頁、類型篩選=裁決`)
    check(await page.locator('[data-testid="task-item"][data-type="adjudicate"]').count() === tasksFixture.tasks.filter((t) => t.task_type === 'adjudicate' && t.status === 'open').length && await page.locator('[data-testid="task-item"]').count() === await page.locator('[data-testid="task-item"][data-type="adjudicate"]').count(), `${viewport.name}: 只列裁決任務`)
    await page.locator('[data-testid="task-type-filter"]').selectOption('')
    await page.locator('[data-testid="tab-feed"]').click()
    await page.waitForSelector('[data-testid="feed-list"]')
    check(await page.locator('[data-testid="leaderboard"] li').first().textContent().then((t) => t.includes('驗證 12')), `${viewport.name}: 貢獻榜顯示驗證數`)

    // 狀態篩選
    await page.locator('[data-testid="status-tabs"] button', { hasText: '已上線' }).click()
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="feed-item"]').length === n, fixture.items.filter((i) => i.status === 'applied').length)
    check(feedRequests.some((q) => q.includes('status=applied')), `${viewport.name}: 切換「已上線」有帶 status=applied`)
    // 型別篩選
    await page.locator('[data-testid="type-filter"]').selectOption('policy')
    await page.waitForTimeout(400)
    check(feedRequests.some((q) => q.includes('type=policy')), `${viewport.name}: 型別篩選有帶 type=policy`)
    const shown = await page.locator('[data-testid="feed-item"]').count()
    check(shown === fixture.items.filter((i) => i.status === 'applied' && i.contribution_type === 'policy').length, `${viewport.name}: 篩選後筆數 ${shown} 正確`)

    // 展開一筆
    await page.locator('[data-testid="status-tabs"] button', { hasText: '全部' }).click()
    await page.locator('[data-testid="type-filter"]').selectOption('')
    await page.waitForSelector('[data-testid="feed-item"]')
    await page.locator('[data-testid="feed-item"] button').first().click()
    check(await page.locator('[data-testid="feed-detail"]').count() === 1, `${viewport.name}: 點開展開來源與備註`)
    await page.waitForSelector('[data-testid="feed-detail"] [data-testid="verifier"]')
    check(await page.locator('[data-testid="feed-detail"] [data-testid="verifier"]').count() === 2, `${viewport.name}: 展開看到 2 位驗證者（history?target=contribution）`)
    check(await page.locator('[data-testid="feed-detail"] [data-testid="edit-list"] li').count() === 1, `${viewport.name}: 展開看到 edit_history 改動`)

    // 不破版：body 不能橫向捲動
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    check(overflow <= 1, `${viewport.name}: 無橫向溢出（scrollWidth−clientWidth=${overflow}）`)
    check(await page.locator('[data-testid="leaderboard"] li').count() === fixture.summary.leaderboard.length, `${viewport.name}: 貢獻榜 ${fixture.summary.leaderboard.length} 筆`)
    const title = await page.title()
    check(title.includes('AI 貢獻看板'), `${viewport.name}: 標題「${title}」`)
    check((await page.locator('meta[name="robots"]').getAttribute('content')) === 'noindex', `${viewport.name}: noindex`)
    await page.screenshot({ path: path.join(OUT, `contributions-${viewport.name}.png`), fullPage: true })

    // 任務分頁
    await page.locator('[data-testid="tab-tasks"]').click()
    await page.waitForSelector('[data-testid="task-list"], [data-testid="task-empty"], [data-testid="task-error"]')
    const openCount = tasksFixture.tasks.filter((t) => t.source !== 'auto' && t.status === 'open').length
    const manualCount = tasksFixture.tasks.filter((t) => t.source !== 'auto').length
    check(await page.locator('[data-testid="task-item"]').count() === openCount, `${viewport.name}: 任務分頁預設列 open ${openCount} 筆（自動缺口不列）`)
    check((await page.locator('[data-testid="gap-counts"]').textContent()).includes(String(tasksFixture.totals.policy_missing)), `${viewport.name}: 自動缺口數量顯示 policy_missing=${tasksFixture.totals.policy_missing}`)
    check(await page.locator('[data-testid="task-item"][data-source="suggested"]').count() === 1, `${viewport.name}: AI 提議的任務有標示來源`)
    await page.locator('[data-testid="toggle-closed"]').check()
    check(await page.locator('[data-testid="task-item"]').count() === manualCount, `${viewport.name}: 勾「顯示已關閉」後 ${manualCount} 筆`)
    const overflowTasks = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    check(overflowTasks <= 1, `${viewport.name}: 任務分頁無橫向溢出（${overflowTasks}）`)
    await page.screenshot({ path: path.join(OUT, `contributions-tasks-${viewport.name}.png`), fullPage: true })
    if (viewport.name === 'desktop') fs.writeFileSync(path.join(OUT, 'task-board.html'), await page.locator('[data-testid="task-board"]').evaluate((el) => el.outerHTML))
    await context.close()
  }

  // 任務分頁純顯示（公開頁沒有金鑰欄位、沒有 apply 呼叫）；?tab=tasks 直接開任務分頁；?type= 預設篩選
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const feedRequests = []
    await routeFeed(page, feedRequests)
    await routeTasks(page)
    const applyCalls = []
    await page.route('**/functions/v1/apply', (route) => { applyCalls.push(route.request().url()); return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }) })
    await page.goto(`http://localhost:${PORT}/ai-assistant?tab=tasks&type=policy`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="task-list"]')
    check(await page.locator('[data-testid="task-board"]').count() === 1, '?tab=tasks 直接開任務分頁')
    check(await page.locator('[data-testid="task-board"] input[type="password"]').count() === 0 && !(await page.locator('[data-testid="task-board"]').textContent()).includes('金鑰'), '任務分頁沒有金鑰欄位')
    check(await page.locator('[data-testid="task-board"] button', { hasText: '新增任務' }).count() === 0 && await page.locator('[data-testid="task-close"]').count() === 0, '沒有新增／關閉任務按鈕')
    check(applyCalls.length === 0, '公開頁不呼叫 apply')
    await page.locator('[data-testid="tab-feed"]').click()
    await page.waitForSelector('[data-testid="feed-list"]')
    check(feedRequests.some((q) => q.includes('type=policy')), '?type=policy 帶進貢獻分頁的第一次請求')
    check(await page.locator('[data-testid="type-filter"]').inputValue() === 'policy', '型別下拉預選 policy')
    await context.close()
  }

  // 空狀態與錯誤狀態
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  await routeTasks(page)
  await page.route('**/functions/v1/contributions-feed**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...fixture, items: [], count: 0, has_more: false, summary: { ...fixture.summary, by_status: { ...fixture.summary.by_status, disputed: 0 }, needs_attention: { total: 0, disputed: 0, retrying: 0 }, adjudicating: 0 } }) }))
  await page.goto(`http://localhost:${PORT}/ai-assistant`, { waitUntil: 'networkidle' })
  check(await page.locator('[data-testid="empty"]').count() === 1, '空狀態顯示')
  check((await page.locator('[data-testid="stat-adjudicating"]').getAttribute('data-alert')) === 'false', '裁決中=0 時不亮提示色')
  await page.unroute('**/functions/v1/contributions-feed**')
  await page.route('**/functions/v1/contributions-feed**', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'internal_error', message: 'boom' }) }))
  await page.locator('button', { hasText: '重新整理' }).click()
  await page.waitForSelector('[data-testid="error"]')
  check(await page.locator('[data-testid="error"]').count() === 1, '錯誤狀態顯示')
  await context.close()
} finally {
  await browser.close()
  server.kill()
}
console.log(failures.length === 0 ? `\n全部通過，截圖在 ${OUT}` : `\n${failures.length} 項失敗`)
process.exit(failures.length === 0 ? 0 : 1)
