// 由 data/tw-raster 產生精簡名稱索引 data/tw-raster-index.json（只有縣市與鄉鎮的代碼＋名稱，約 10KB）。
// 選舉頁手機版的晶片列要在預渲染／首次繪製就有縣市、鄉鎮清單，不能等點陣檔（每個含整份格點資料）的請求。
// 點陣檔更新後重跑：node scripts/build-tw-raster-index.mjs（lib/raster-index.test.ts 會比對兩者是否一致）
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
const dir = new URL('../data/tw-raster/', import.meta.url)
const read = (p) => JSON.parse(readFileSync(new URL(p, dir), 'utf8'))
const national = read('national.json')
const towns = {}
for (const f of readdirSync(new URL('towns/', dir)).sort()) {
  const t = read(`towns/${f}`)
  towns[f.replace(/\.json$/, '')] = { codes: t.codes, names: t.names }
}
const out = { counties: { codes: national.codes, names: national.names }, towns }
writeFileSync(new URL('../data/tw-raster-index.json', import.meta.url), JSON.stringify(out) + '\n')
