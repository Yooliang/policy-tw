import test from 'node:test'
import assert from 'node:assert/strict'
import { parseProm, summarize } from './usage-metrics-summary.mjs'

const PROM = `# HELP node_memory_MemTotal_bytes Memory information field MemTotal_bytes.
# TYPE node_memory_MemTotal_bytes gauge
node_memory_MemTotal_bytes 4.005E+09
node_memory_MemAvailable_bytes 1000000
node_memory_MemFree_bytes 500000
node_memory_Cached_bytes 300000
node_memory_SwapTotal_bytes 2000000
node_memory_SwapFree_bytes 1500000
node_memory_Committed_AS_bytes 5000000000
node_memory_CommitLimit_bytes 4730000000
node_load1 1.25
pg_stat_database_numbackends{datname="postgres"} 12
pg_stat_database_numbackends{datname="template1"} 0
node_filesystem_size_bytes{device="/dev/nvme0n1p1",mountpoint="/"} 1000
node_filesystem_avail_bytes{device="/dev/nvme0n1p1",mountpoint="/"} 400
node_filesystem_size_bytes{device="/dev/nvme1n1",mountpoint="/data"} 8000
node_filesystem_avail_bytes{device="/dev/nvme1n1",mountpoint="/data"} 6000
壞行 not prom
node_bad abc
`

test('parseProm：略過註解與壞行，讀得出標籤與科學記號', () => {
  const s = parseProm(PROM)
  assert.equal(s.find((x) => x.name === 'node_memory_MemTotal_bytes').value, 4.005e9)
  const nb = s.filter((x) => x.name === 'pg_stat_database_numbackends')
  assert.equal(nb.length, 2)
  assert.equal(nb[0].labels.datname, 'postgres')
  assert.equal(s.some((x) => x.name === 'node_bad'), false)
})

test('summarize：抽出記憶體、swap、committed、連線與 /data 磁碟', () => {
  const r = summarize(PROM, new Date('2026-11-28T00:00:00Z'))
  assert.equal(r.ok, true)
  assert.equal(r.fetched_at, '2026-11-28T00:00:00.000Z')
  assert.equal(r.mem_total, 4.005e9)
  assert.equal(r.mem_available, 1000000)
  assert.equal(r.swap_total - r.swap_free, 500000)
  assert.equal(r.committed_as, 5e9)
  assert.equal(r.commit_limit, 4.73e9)
  assert.equal(r.load1, 1.25)
  assert.equal(r.connections, 12)
  assert.deepEqual(r.disk, { mountpoint: '/data', size_bytes: 8000, avail_bytes: 6000 })
})

test('summarize：沒有 /data 時用 /', () => {
  const r = summarize('node_filesystem_size_bytes{mountpoint="/"} 100\nnode_filesystem_avail_bytes{mountpoint="/"} 40\n')
  assert.equal(r.disk.mountpoint, '/')
  assert.equal(r.disk.avail_bytes, 40)
})

test('summarize：缺指標不崩，缺的是 null', () => {
  const r = summarize('node_load1 0.5\n')
  assert.equal(r.ok, true)
  assert.equal(r.load1, 0.5)
  assert.equal(r.mem_total, null)
  assert.equal(r.connections, null)
  assert.equal(r.disk, null)
})

test('summarize：空字串、undefined、HTML 錯誤頁都標 ok=false 不崩', () => {
  for (const t of ['', undefined, '<html>401</html>', '{"message":"Unauthorized"}']) {
    const r = summarize(t)
    assert.equal(r.ok, false)
    assert.equal(r.mem_total, null)
  }
})

test('Committed 名稱不同版本：用名稱片段備援', () => {
  const r = summarize('node_memory_Committed_AS 123\nnode_memory_CommitLimit 456\n')
  assert.equal(r.committed_as, 123)
  assert.equal(r.commit_limit, 456)
})
