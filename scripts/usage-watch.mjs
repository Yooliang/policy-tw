// 讀 Management API 用量端點的回應（由 workflow 的 curl 存成檔），印摘要、判斷門檻。不碰權杖。
// 用法：node scripts/usage-watch.mjs <回應目錄> <設定檔>
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, cfgPath] = process.argv.slice(2)
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
const out = []
const log = (s) => { console.log(s); out.push(s) }
const read = (f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch { return null } }

const breaches = []

// usage.api-counts（interval=1hr）：result[] 每分鐘一列，total_rest_requests 等
const counts = read('usage.api-counts.json')
const rows = Array.isArray(counts?.result) ? counts.result : null
if (!rows) {
  log(`usage.api-counts 無法使用：${JSON.stringify(counts)?.slice(0, 200)}`)
} else {
  const rest = rows.map((r) => Number(r.total_rest_requests) || 0)
  const hourly = rest.reduce((a, b) => a + b, 0)
  const peak = rest.length ? Math.max(...rest) : 0
  log(`REST 請求（${rows.length} 分鐘）：每小時加總 ${hourly}，單分鐘峰值 ${peak}`)
  if (hourly > cfg.hourly_rest_requests_max) breaches.push(`每小時 REST 請求 ${hourly} > ${cfg.hourly_rest_requests_max}`)
  if (peak > cfg.minute_rest_requests_max) breaches.push(`單分鐘 REST 請求峰值 ${peak} > ${cfg.minute_rest_requests_max}`)
}

// usage.api-requests-count：時間窗不明，只記錄不判斷
const total = read('usage.api-requests-count.json')
log(`usage.api-requests-count（只記錄，時間窗不明）：${total?.result?.[0]?.count ?? JSON.stringify(total)?.slice(0, 200)}`)

log(`門檻檢查：${breaches.length ? breaches.join('；') : '未超過'}（alert=${cfg.alert}）`)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## 資料庫 REST 請求量\n\n```\n' + out.join('\n') + '\n```\n')
writeFileSync(join(dir, 'breaches.txt'), breaches.join('\n'))
