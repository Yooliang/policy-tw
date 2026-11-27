// 從 Supabase 的 Prometheus 指標文字（metrics.prom）抽出資料庫主機的記憶體、負載、連線、磁碟，寫成小 JSON（metrics.json）。
// 用法：node scripts/usage-metrics-summary.mjs <metrics.prom> <metrics.json>
// 缺檔、空檔或缺指標都不崩：缺的欄位寫 null，整份抓不到時 ok=false。不碰任何金鑰。
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MEMORY_KEYS = {
  mem_total: 'node_memory_MemTotal_bytes',
  mem_available: 'node_memory_MemAvailable_bytes',
  mem_free: 'node_memory_MemFree_bytes',
  cached: 'node_memory_Cached_bytes',
  swap_total: 'node_memory_SwapTotal_bytes',
  swap_free: 'node_memory_SwapFree_bytes',
  committed_as: 'node_memory_Committed_AS_bytes',
  commit_limit: 'node_memory_CommitLimit_bytes',
  load1: 'node_load1',
}
const DISK_MOUNTS = ['/data', '/']

// 解析 Prometheus 文字格式：回傳 [{ name, labels, value }]；註解與壞行略過
export function parseProm(text) {
  const out = []
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+\d+)?$/)
    if (!m) continue
    const value = Number(m[3])
    if (!Number.isFinite(value)) continue
    const labels = {}
    for (const lm of (m[2] ?? '').matchAll(/([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[lm[1]] = lm[2]
    out.push({ name: m[1], labels, value })
  }
  return out
}

const first = (samples, name) => samples.find((s) => s.name === name)?.value ?? null

// 沒有精確名稱時，用「名稱含某字」的方式找第一個（Committed／CommitLimit 這類名稱各版本略有差異）
const firstLike = (samples, re) => samples.find((s) => re.test(s.name))?.value ?? null

function diskFor(samples) {
  for (const mount of DISK_MOUNTS) {
    const size = samples.find((s) => s.name === 'node_filesystem_size_bytes' && s.labels.mountpoint === mount)
    const avail = samples.find(
      (s) => s.name === 'node_filesystem_avail_bytes' && s.labels.mountpoint === mount && s.labels.device === size?.labels.device,
    ) ?? samples.find((s) => s.name === 'node_filesystem_avail_bytes' && s.labels.mountpoint === mount)
    if (size && avail) return { mountpoint: mount, size_bytes: size.value, avail_bytes: avail.value }
  }
  return null
}

// 連線數：各資料庫 numbackends 加總；沒有就退回名稱含 connections 的 supabase／pg 指標
function connectionsFor(samples) {
  const backends = samples.filter((s) => s.name === 'pg_stat_database_numbackends')
  if (backends.length) return backends.reduce((a, s) => a + s.value, 0)
  const like = samples.find((s) => /^(supabase|pg)_.*(connections|backends)/.test(s.name))
  return like ? like.value : null
}

export function summarize(text, now = new Date()) {
  const samples = parseProm(text)
  const out = { fetched_at: now.toISOString(), ok: samples.length > 0 }
  for (const [key, name] of Object.entries(MEMORY_KEYS)) out[key] = first(samples, name)
  // 名稱不一致的備援：Committed_AS、CommitLimit 用名稱片段找
  if (out.committed_as == null) out.committed_as = firstLike(samples, /^node_memory_Committed/)
  if (out.commit_limit == null) out.commit_limit = firstLike(samples, /^node_memory_CommitLimit/)
  out.connections = connectionsFor(samples)
  out.disk = diskFor(samples)
  return out
}

function main() {
  const [promPath, jsonPath] = process.argv.slice(2)
  if (!promPath || !jsonPath) {
    console.error('用法：node scripts/usage-metrics-summary.mjs <metrics.prom> <metrics.json>')
    process.exit(2)
  }
  let text = ''
  try {
    text = readFileSync(promPath, 'utf8')
  } catch {
    console.warn(`讀不到 ${promPath}，metrics.json 標 ok=false`)
  }
  const summary = summarize(text)
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2) + '\n')
  console.log(`metrics.json ok=${summary.ok} mem_available=${summary.mem_available ?? 'null'}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
