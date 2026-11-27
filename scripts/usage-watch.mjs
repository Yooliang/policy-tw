// 讀 Management API 用量端點的回應（由 workflow 的 curl 存成檔），印摘要、判斷門檻、產生 summary.json。不碰權杖。
// 用法：node scripts/usage-watch.mjs <回應目錄> <設定檔>
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const COUNT_KEYS = ['count', 'c', 'invocations', 'total_invocations', 'request_count', 'total', 'total_count']
const NAME_KEYS = ['function_name', 'slug', 'name', 'function_id', 'id']

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
const rowsOf = (j) => {
  if (Array.isArray(j)) return j
  if (Array.isArray(j?.result)) return j.result
  if (Array.isArray(j?.data)) return j.data
  return null
}
const pickCount = (row) => {
  for (const k of COUNT_KEYS) if (row?.[k] != null && num(row[k]) != null) return num(row[k])
  return null
}

// 把「函式 id → 名稱」對照表（/functions 清單）做成 Map
export function functionIdMap(list) {
  const m = new Map()
  const rows = rowsOf(list) ?? []
  for (const f of rows) if (f?.id) m.set(String(f.id), f.slug ?? f.name ?? String(f.id))
  return m
}

// 各函式 24h 呼叫數：同名加總、依次數由大到小
export function functionCounts(rows, idMap = new Map()) {
  if (!Array.isArray(rows)) return null
  const acc = new Map()
  for (const r of rows) {
    const count = pickCount(r)
    if (count == null) continue
    let name = null
    for (const k of NAME_KEYS) if (r?.[k] != null && r[k] !== '') { name = String(r[k]); break }
    if (name == null) continue
    name = idMap.get(name) ?? name
    acc.set(name, (acc.get(name) ?? 0) + count)
  }
  if (acc.size === 0) return null
  return [...acc].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
}

export function gatewayPaths(rows) {
  if (!Array.isArray(rows)) return null
  const out = []
  for (const r of rows) {
    const count = pickCount(r)
    const path = r?.p ?? r?.path
    if (count != null && path != null) out.push({ path: String(path), count })
  }
  return out.length ? out.sort((a, b) => b.count - a.count) : null
}

// dir 內的檔：status.tsv（每行「名稱<TAB>HTTP 狀態」）與各探測回應 <名稱>.json
export function buildSummary(read, statuses, nowIso) {
  const errors = []
  for (const [name, code] of Object.entries(statuses)) if (code !== '200') errors.push(`${name} HTTP ${code}`)

  const idMap = functionIdMap(read('functions-list.json'))
  let functions = null
  let functionsSource = null
  for (const n of ['functions.inv-stats', 'functions.combined-stats', 'functions.req-stats', 'functions-logs']) {
    if (statuses[n] !== '200') continue
    const got = functionCounts(rowsOf(read(`${n}.json`)), idMap)
    if (got) { functions = got; functionsSource = n; break }
  }

  const gwRows = rowsOf(read('gateway-total.json'))
  const gwTotal = gwRows?.[0] ? pickCount(gwRows[0]) : null
  const paths = gatewayPaths(rowsOf(read('gateway-paths.json')))

  let orgCycle = null
  for (const n of ['org-usage', 'org-billing-usage', 'project-billing-addons']) {
    if (statuses[n] !== '200') continue
    const data = read(`${n}.json`)
    if (data) { orgCycle = { source: n, data }; break }
  }

  return {
    at: nowIso,
    functions_source: functionsSource,
    functions_24h: (functions ?? []).slice(0, 30),
    functions_24h_total: functions ? functions.reduce((a, f) => a + f.count, 0) : null,
    gateway_24h_total: gwTotal,
    gateway_top_paths: (paths ?? []).slice(0, 15),
    org_cycle: orgCycle,
    errors,
  }
}

function readStatuses(dir) {
  const out = {}
  try {
    for (const line of readFileSync(join(dir, 'status.tsv'), 'utf8').split('\n')) {
      const [name, code] = line.trim().split('\t')
      if (name) out[name] = code
    }
  } catch { /* 沒有狀態檔就當全部沒抓 */ }
  return out
}

function main() {
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

  // Edge Function 24h 呼叫、閘道請求、組織週期用量
  const summary = buildSummary(read, readStatuses(dir), new Date().toISOString())
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2))
  out.push('')
  if (summary.functions_24h_total == null) {
    log('Edge Function 24h 呼叫：這次沒有取得')
  } else {
    log(`Edge Function 24h 呼叫總數 ${summary.functions_24h_total}（來源 ${summary.functions_source}），前 10：`)
    for (const f of summary.functions_24h.slice(0, 10)) log(`  ${f.name}  ${f.count}`)
    const max = cfg.daily_function_invocations_max
    if (max && summary.functions_24h_total > max) breaches.push(`Edge Function 24h 呼叫 ${summary.functions_24h_total} > ${max}`)
  }
  log(summary.gateway_24h_total == null ? '閘道 24h 請求：這次沒有取得' : `閘道 24h 總請求 ${summary.gateway_24h_total}`)
  for (const p of summary.gateway_top_paths.slice(0, 5)) log(`  ${p.path}  ${p.count}`)
  log(summary.org_cycle ? `組織本週期用量：已取得（${summary.org_cycle.source}），見 summary.json` : '組織本週期用量：需到後台看')
  if (summary.errors.length) log(`端點狀況：${summary.errors.join('；')}`)

  log(`門檻檢查：${breaches.length ? breaches.join('；') : '未超過'}（alert=${cfg.alert}）`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## 資料庫 REST 請求量與 Edge Function 呼叫\n\n```\n' + out.join('\n') + '\n```\n')
  writeFileSync(join(dir, 'breaches.txt'), breaches.join('\n'))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
