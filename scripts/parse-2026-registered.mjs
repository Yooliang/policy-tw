// 解析中央社〈2026九合一選舉 22縣市長登記參選名單一次看〉→ data/2026/county-mayor-registered.json
// 用法：node scripts/parse-2026-registered.mjs [已下載的 html 路徑]
//   不給路徑就直接抓 https://www.cna.com.tw/news/aipl/202609045002.aspx
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_URL = 'https://www.cna.com.tw/news/aipl/202609045002.aspx';
const SOURCE = '中央社 2026-09-04';

const COUNTIES = new Set([
  '台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市',
  '基隆市', '新竹市', '新竹縣', '苗栗縣', '南投縣', '彰化縣', '雲林縣', '嘉義市', '嘉義縣',
  '屏東縣', '宜蘭縣', '台東縣', '花蓮縣', '澎湖縣', '金門縣', '連江縣',
]);

// 文中出現的政黨寫法 → 資料庫正規名（沿用 Edge Function partyMap，其餘照原名）
const PARTY_MAP = {
  '國民黨': '中國國民黨', '中國國民黨': '中國國民黨',
  '民進黨': '民主進步黨', '民主進步黨': '民主進步黨',
  '民眾黨': '台灣民眾黨', '台灣民眾黨': '台灣民眾黨',
  '無黨籍': '無黨籍', '無': '無黨籍',
  '時代力量': '時代力量', '台灣基進': '台灣基進',
  '台灣團結聯盟': '台灣團結聯盟', '親民黨': '親民黨', '新黨': '新黨', '綠黨': '綠黨',
  '社會民主黨': '社會民主黨', '台灣維新': '台灣維新',
};
// 文中會出現、要能從行首切出來的政黨名（長的先比）
const PARTY_TOKENS = [
  '台灣麻將最大黨', '台灣SoR無法黨', '三勢團結促進聯盟', '司法正義黨', '司法改革黨', '台灣團結聯盟', '台灣工黨',
  '台灣民眾黨', '中國國民黨', '民主進步黨', '時代力量', '台灣基進', '社會民主黨', '台灣維新', '親民黨',
  '民進黨', '國民黨', '民眾黨', '無黨籍', '新黨', '綠黨',
].sort((a, b) => b.length - a.length);

function htmlToLines(html) {
  const start = html.indexOf('class="paragraph"');
  const body = html.slice(start);
  const text = body
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/p>|<\/h2>|<\/li>|<\/div>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
  return text.split('\n').map((l) => l.replace(/　/g, ' ').trim()).filter(Boolean);
}

export function parseArticle(html) {
  const lines = htmlToLines(html);
  const rows = [];
  const skipped = [];
  let region = null;
  for (const line of lines) {
    const normalizedLine = line.replace(/臺/g, '台');
    if (COUNTIES.has(normalizedLine)) { region = normalizedLine; continue; }
    if (/^（編輯/.test(line)) break; // 名單結束
    if (!region) continue;
    const party = PARTY_TOKENS.find((p) => normalizedLine.startsWith(p));
    if (!party) { skipped.push({ region, line }); continue; }
    const rest = normalizedLine.slice(party.length);
    const [rawName, ...positionParts] = rest.split(/[，,]/);
    const name = rawName.trim();
    if (!name) { skipped.push({ region, line }); continue; }
    const currentPosition = positionParts.join('，').trim() || null;
    rows.push({
      name,
      party: PARTY_MAP[party] ?? party,
      party_as_written: party,
      region,
      position: '縣市長候選人',
      election_type: '縣市長',
      current_position: currentPosition,
      source: SOURCE,
      source_url: SOURCE_URL,
    });
  }
  return { rows, skipped };
}

async function loadHtml(arg) {
  if (arg) return fs.readFileSync(arg, 'utf8');
  const res = await fetch(SOURCE_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0' } });
  if (!res.ok) throw new Error(`CNA ${res.status}`);
  return await res.text();
}

const html = await loadHtml(process.argv[2]);
const { rows, skipped } = parseArticle(html);
const byRegion = rows.reduce((m, r) => ({ ...m, [r.region]: (m[r.region] ?? 0) + 1 }), {});
const out = {
  _meta: {
    source: SOURCE,
    source_url: SOURCE_URL,
    fetched_at: new Date().toISOString(),
    total: rows.length,
    regions: Object.keys(byRegion).length,
    by_region: byRegion,
    election_id: 2026,
    note: '中央社原文只有姓名／政黨／現職，沒有出生年；party 已用 partyMap 正規化，party_as_written 保留原文寫法。',
  },
  candidates: rows,
};
const outPath = path.join(ROOT, 'data/2026/county-mayor-registered.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`total ${rows.length} in ${Object.keys(byRegion).length} regions →`, outPath);
console.log(JSON.stringify(byRegion));
if (skipped.length) console.log('skipped lines:', JSON.stringify(skipped, null, 1));
