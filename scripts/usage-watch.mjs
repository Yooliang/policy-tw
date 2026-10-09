// 讀 Management API 用量端點的原始回應（由 workflow 的 curl 存成檔），印數字摘要、判斷門檻。
// 不碰權杖。用法：node scripts/usage-watch.mjs <回應目錄> <設定檔>
import { readFileSync, readdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, cfgPath] = process.argv.slice(2)
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
const out = []
const log = (s) => { console.log(s); out.push(s) }

// 遞迴收集欄位名稱與數值欄位加總，端點回應格式第一次實跑前未知，所以不寫死欄位
function walk(v, path, acc) {
  if (Array.isArray(v)) { v.forEach((x) => walk(x, path + '[]', acc)); return }
  if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, acc); return }
  if (typeof v === 'number') acc[path] = (acc[path] || 0) + v
  else if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) && !/time|date|stamp/i.test(path)) acc[path] = (acc[path] || 0) + Number(v)
}

const sums = {}
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
  let j
  try { j = JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch { log(`### ${f}\n無法解析（非 JSON）`); continue }
  const acc = {}
  walk(j, '', acc)
  const top = j && typeof j === 'object' ? Object.keys(j).join(', ') : typeof j
  log(`### ${f}\n頂層欄位：${top}\n數值欄位加總：${JSON.stringify(acc)}`)
  sums[f] = acc
}

// 門檻：用欄位名稱比對（含 request/count 的當請求數，含 byte/egress/size 的當傳輸量）
const breaches = []
for (const [f, acc] of Object.entries(sums)) {
  for (const [k, v] of Object.entries(acc)) {
    if (/byte|egress|size/i.test(k) && v > cfg.hourly_egress_bytes_max) breaches.push(`${f} ${k}=${v} > ${cfg.hourly_egress_bytes_max}`)
    else if (/request|count/i.test(k) && !/byte/i.test(k) && v > cfg.hourly_rest_requests_max) breaches.push(`${f} ${k}=${v} > ${cfg.hourly_rest_requests_max}`)
  }
}
log(`\n門檻檢查：${breaches.length ? breaches.join('；') : '未超過'}（alert=${cfg.alert}）`)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## 資料庫用量\n\n```\n' + out.join('\n') + '\n```\n')
writeFileSync(join(dir, 'breaches.txt'), breaches.join('\n'))
