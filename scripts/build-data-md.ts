/**
 * 預產 Markdown 摘要（維護者 2026-10-07：摘要定時預產、快取起來，不要每次被讀才算）。
 *
 * 撈一份完整資料（只用 anon）→ lib/md/dataset.ts 組出所有縣市（某屆）、分類、縣市×分類、索引（.md 與 .json）與矩陣 →
 * 跟 data_md_cache 現有的列比內容雜湊 → 輸出要套用的 SQL。這支本身不寫任何資料庫，套用由排程 workflow（.github/workflows/data-md.yml）
 * 用 supabase CLI 做。**一批全部換新**：
 *   00-reset.sql      清空暫存表 data_md_staging
 *   01-….sql          把「內容有變的列」分批放進暫存表（每個檔 ≤ 2.5 MB：管理 API 單次請求上限約 4 MB，實測 3 MB 過、5 MB 回 413）
 *   99-publish.sql    一個交易：確認暫存表筆數無誤 → 沒變的列只更新 generated_at → 暫存表併進 data_md_cache → 刪掉已不存在的列 → 清空暫存表
 * 每一列的 generated_at 都是這一批同一個值（也寫在 index.json 裡每個檔案的 generated_at），Worker 不會撈到一半新舊混雜。
 *
 * 用法（先 `pnpm build:md`，要有 VITE_SUPABASE_URL／VITE_SUPABASE_ANON_KEY 在建置時烤進去）：
 *   node dist-md/build-data-md.js --sql-dir out/sql [--out-dir out/md]
 *   --sql-dir  輸出上面那幾個檔與 summary.json
 *   --out-dir  另外把每一份整份文件寫成檔案（本機看結果用，路徑＝網址路徑）
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadCorpus } from '../lib/ssr/md-loaders'
import { buildAll, MATRIX_PATH } from '../lib/md/dataset'
import { SCOPE_VERSION } from '../lib/md/pledge'
import { renderPage, type MdPage } from '../lib/md/format'

const args = process.argv.slice(2)
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const sqlDir = arg('--sql-dir')
const outDir = arg('--out-dir')
if (!sqlDir && !outDir) { console.error('至少要給 --sql-dir 或 --out-dir'); process.exit(1) }

const log = (s: string) => console.log(`[data-md] ${s}`)
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string
const STAGE_FILE_MAX = 2_500_000

interface Row { path: string; body: string; meta: Record<string, unknown>; row_count: number; content_sha: string }

// 內容雜湊把範圍版本（lib/md/pledge.ts SCOPE_VERSION）算進去：改範圍上線後的第一次排程，每一列的雜湊都跟舊的不同，整批作廢重建，
// 不會有「內容碰巧一樣、只更新時間」的舊範圍列留在快取裡（維護者 10-07：範圍由人改為政見）
const sha = (o: unknown) => createHash('sha256').update(JSON.stringify({ scope: SCOPE_VERSION, o })).digest('hex')
const splitPage = (page: MdPage) => { const { body, ...meta } = page; return { bodyText: body.join('\n'), meta } }
/** 一份頁面的內容雜湊（資料庫列的 content_sha 與 index.json 的 sha 用同一個函式） */
const pageSha = (page: MdPage) => { const { bodyText, meta } = splitPage(page); return sha({ bodyText, meta }) }

/** 現有快取列的雜湊（只用 anon 讀；表還沒建＝空）。DATA_MD_EXISTING_FILE 給一個 {path: sha} 的 JSON 檔就改讀它（本機驗證用，不打網路） */
async function existingShas(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (process.env.DATA_MD_EXISTING_FILE) {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(process.env.DATA_MD_EXISTING_FILE, 'utf8')) as Record<string, string>)) out.set(k, v)
    return out
  }
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/data_md_cache?select=path,content_sha&order=path`, {
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, Range: `${from}-${from + 999}`, 'Range-Unit': 'items' },
    })
    if (r.status === 404) return out
    if (!r.ok) throw new Error(`讀 data_md_cache 失敗 ${r.status}`)
    const rows = (await r.json()) as Array<{ path: string; content_sha: string }>
    for (const x of rows) out.set(x.path, x.content_sha)
    if (rows.length < 1000) return out
  }
}

/** 美元引號字串：挑一個不在內容裡的標記，內容怎麼寫都不必跳脫 */
function dq(s: string): string {
  for (let i = 0; ; i++) {
    const tag = `$m${i}$`
    if (!s.includes(tag)) return `${tag}${s}${tag}`
  }
}

const generatedAt = Date.now()
const stamp = new Date(generatedAt).toISOString()
const corpus = await loadCorpus(log)
const { pages, json, matrix } = buildAll(corpus, { generatedAt, sha: pageSha })
if (!matrix) throw new Error('找不到最新一屆定期選舉，不產生快取')

const rows: Row[] = [
  ...pages.map(({ path, page }) => { const { bodyText, meta } = splitPage(page); return { path, body: bodyText, meta, row_count: page.rowCount, content_sha: sha({ bodyText, meta }) } }),
  ...json.map((j) => ({ path: j.path, body: j.body, meta: { format: 'json' }, row_count: j.rowCount, content_sha: sha({ json: j.body }) })),
]
// 矩陣：Worker 用它認「最新一屆」，矩陣頁用它畫表
const matrixBody = JSON.stringify(matrix)
rows.push({ path: MATRIX_PATH, body: matrixBody, meta: {}, row_count: matrix.total, content_sha: sha({ matrixBody }) })
log(`共 ${rows.length} 列（Markdown ${pages.length}、JSON ${json.length}）`)

if (outDir) {
  for (const { path, page } of pages) {
    const file = join(outDir, ...path.split('/').filter(Boolean))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, renderPage(page, path, generatedAt))
  }
  for (const j of json) {
    const file = join(outDir, ...j.path.split('/').filter(Boolean))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, j.body)
  }
  writeFileSync(join(outDir, '_matrix.json'), JSON.stringify(matrix, null, 2))
  log(`已寫到 ${outDir}`)
}

if (sqlDir) {
  const existing = await existingShas()
  const next = new Set(rows.map((r) => r.path))
  const changed = rows.filter((r) => existing.get(r.path) !== r.content_sha)
  const unchanged = rows.filter((r) => existing.get(r.path) === r.content_sha)
  const stale = [...existing.keys()].filter((p) => !next.has(p))
  // 保險：產出的列數比現有少了一成以上，多半是資料撈不全，不要拿它去刪現有快取
  if (existing.size > 0 && rows.length < existing.size * 0.9) throw new Error(`產出 ${rows.length} 列，現有 ${existing.size} 列，少太多，不套用`)
  mkdirSync(sqlDir, { recursive: true })

  const files: Array<[string, string]> = [['00-reset.sql', 'TRUNCATE data_md_staging;']]
  const stmt = (r: Row) => `(${dq(r.path)}, ${dq(r.body)}, ${dq(JSON.stringify(r.meta))}::jsonb, ${r.row_count}, '${r.content_sha}')`
  let cur: string[] = []
  let size = 0
  let n = 0
  const flush = () => {
    if (cur.length === 0) return
    n++
    files.push([`${String(n).padStart(2, '0')}-stage.sql`, `INSERT INTO data_md_staging (path, body, meta, row_count, content_sha) VALUES\n${cur.join(',\n')};`])
    cur = []; size = 0
  }
  for (const r of changed) {
    const s = stmt(r)
    const bytes = Buffer.byteLength(s)
    if (size + bytes > STAGE_FILE_MAX) flush()
    cur.push(s); size += bytes
  }
  flush()

  const arr = (rs: Array<{ path: string }>) => `ARRAY[${rs.map((r) => dq(r.path)).join(', ')}]::text[]`
  const publish = [
    'BEGIN;',
    // 暫存表筆數不對（有一批沒送到）就整個交易失敗，現有快取不動
    `DO $chk$ BEGIN IF (SELECT count(*) FROM data_md_staging) <> ${changed.length} THEN RAISE EXCEPTION '暫存表筆數不對：預期 ${changed.length}'; END IF; END $chk$;`,
    unchanged.length > 0 ? `UPDATE data_md_cache SET generated_at = '${stamp}'::timestamptz WHERE path = ANY (${arr(unchanged)});` : '',
    `INSERT INTO data_md_cache (path, body, meta, row_count, content_sha, generated_at, changed_at)
SELECT path, body, meta, row_count, content_sha, '${stamp}'::timestamptz, '${stamp}'::timestamptz FROM data_md_staging
ON CONFLICT (path) DO UPDATE SET body = EXCLUDED.body, meta = EXCLUDED.meta, row_count = EXCLUDED.row_count, content_sha = EXCLUDED.content_sha, generated_at = EXCLUDED.generated_at, changed_at = EXCLUDED.changed_at;`,
    `DELETE FROM data_md_cache WHERE path <> ALL (${arr(rows)});`,
    'TRUNCATE data_md_staging;',
    'COMMIT;',
  ].filter(Boolean).join('\n')
  files.push(['99-publish.sql', publish])

  for (const [name, sql] of files) writeFileSync(join(sqlDir, name), `${sql}\n`)
  const summary = {
    generatedAt: stamp, rows: rows.length, changed: changed.length, unchanged: unchanged.length, stale: stale.length, sqlFiles: files.length,
    matrixNonZero: Object.values(matrix.counts).flatMap((r) => Object.values(r)).filter((x) => x > 0).length,
    matrixCells: matrix.regions.length * matrix.categories.length, matrixTotal: matrix.total,
  }
  writeFileSync(join(sqlDir, 'summary.json'), JSON.stringify(summary, null, 2))
  log(`SQL ${files.length} 個檔：${JSON.stringify(summary)}`)
}
