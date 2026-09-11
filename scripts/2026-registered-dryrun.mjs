// 2026 縣市長登記參選名單（81 人）匯入 dry-run —— 只讀 anon key，不寫 prod
//
// 用法：node scripts/2026-registered-dryrun.mjs
//   讀 data/2026/county-mayor-registered.json，每筆走 resolvePolitician（記憶體 store 載入 prod 同名人物與其 politician_keys），
//   輸出 .dedupe-check/2026-registered-dryrun.md（計畫）與 scripts/import-2026-registered.sql（主線審過才跑）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePolitician } from '../supabase/functions/_shared/politician-identity.ts';
import { createMemoryIdentityStore } from '../supabase/functions/_shared/identity-memory-store.ts';
import { normText } from '../supabase/functions/_shared/identity-normalize.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTION_ID = 2026;
const ELECTION_TYPE = '縣市長';
const SOURCE_NOTE = '中央社 2026-09-04 登記參選名單';
const SOURCE_TAG = 'cna-2026-registered';

// 你要特別檢查的對應（主線指定）
const EXPECTED = {
  '陳素月': 'bcdfd014', '童子瑋': 'fab097b2', '許淑華': '46b9a63f', '蘇清泉': 'b6e1fec9',
  '吳宗憲': '5534465f', '吳秀華': '9f81d161',
};
const WATCH_NAMES = ['張善政', '蔣萬安', '謝國樑', '鍾東錦', '周春米', '王忠銘', '高虹安'];

function loadEnv() {
  const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const env = Object.fromEntries(text.split(/\r?\n/).filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) throw new Error('.env 缺 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');
  return env;
}
const env = loadEnv();
async function fetchAll(table, select, filter = '') {
  const page = 1000; const rows = [];
  for (let from = 0; ; from += page) {
    const res = await fetch(`${env.VITE_SUPABASE_URL}/rest/v1/${table}?select=${select}${filter ? '&' + filter : ''}&order=id`, {
      headers: { apikey: env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${env.VITE_SUPABASE_ANON_KEY}`, Range: `${from}-${from + page - 1}` },
    });
    if (!res.ok) throw new Error(`${table} ${res.status} ${await res.text()}`);
    const chunk = await res.json(); rows.push(...chunk);
    if (chunk.length < page) break;
  }
  return rows;
}
const inList = (values) => `(${values.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(',')})`;
const sqlStr = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

// ---------- 載入 ----------
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/2026/county-mayor-registered.json'), 'utf8'));
const candidates = data.candidates;
const names = [...new Set(candidates.map((c) => normText(c.name)))];
console.log(`名單 ${candidates.length} 人，讀 prod（只讀）…`);

const [sameName, pe2026, countyRegions] = await Promise.all([
  fetchAll('politicians', 'id,name,party,region,election_type,position,current_position,birth_year,region_id', `name=in.${inList(names)}`),
  fetchAll('politician_elections', 'id,politician_id,election_id,election_type,position,candidate_status,source_note,verified,region_id', `election_id=eq.${ELECTION_ID}&election_type=eq.${ELECTION_TYPE}`),
  fetchAll('regions', 'id,region', 'sub_region=is.null&village=is.null'),
]);
const sameIds = sameName.map((p) => p.id);
const keys = sameIds.length ? await fetchAll('politician_keys', 'id,politician_id,key_type,key_value,strength,source', `politician_id=in.${inList(sameIds)}`) : [];
const pe2026People = await fetchAll('politicians', 'id,name,party,region,current_position', `id=in.${inList([...new Set(pe2026.map((e) => e.politician_id))])}`);
console.log(`同名人物 ${sameName.length}、其 key ${keys.length}、2026 縣市長 PE ${pe2026.length}、縣市 regions ${countyRegions.length}`);

const regionIdOf = new Map(countyRegions.map((r) => [normText(r.region), r.id]));
const polById = new Map([...sameName, ...pe2026People].map((p) => [p.id, p]));
const store = createMemoryIdentityStore(sameName.map((p) => ({ id: p.id, name: p.name })), keys);

// ---------- 逐筆判定 ----------
const results = [];
for (const c of candidates) {
  const r = await resolvePolitician(store, {
    name: c.name, party: c.party, region: c.region, election_type: c.election_type, position: c.position, current_position: c.current_position,
  }, { persist: false });
  const pid = r.decision === 'matched' ? r.politician_id : null;
  const existingPE = pid ? pe2026.find((e) => e.politician_id === pid) : null;
  const expected = EXPECTED[c.name];
  const check = expected ? (pid?.startsWith(expected) ? '✅' : `❌ 預期 ${expected}`) : (WATCH_NAMES.includes(c.name) ? (pid ? '✅ 對到既有' : '⚠ 現任首長卻無既有人物') : '');
  results.push({ c, r, pid, existingPE, check });
}
const matched = results.filter((x) => x.r.decision === 'matched');
const created = results.filter((x) => x.r.decision === 'new');
const ambiguous = results.filter((x) => x.r.decision === 'ambiguous');

// 描述既有人物（ambiguous 時給人看要不要手動指定）
const describe = (id) => {
  const p = polById.get(id);
  return p ? `${p.region ?? '?'}／${p.election_type ?? '?'}／${p.party ?? '?'}／${p.current_position ?? p.position ?? ''}${p.birth_year ? `／${p.birth_year}年生` : ''}` : '';
};

// 異體字：名單寫法與 DB 寫法只差一個異體字的既有人物（例：張啓楷 vs 張啟楷）
const VARIANTS = { '啓': '啟', '溫': '温', '裏': '裡', '峯': '峰', '麽': '麼', '澂': '澄', '爲': '為', '衞': '衛', '羨': '羡' };
const fold = (s) => [...(s ?? '')].map((ch) => VARIANTS[ch] ?? ch).join('');
const variantHits = pe2026People
  .filter((p) => !names.includes(normText(p.name)) && candidates.some((c) => fold(normText(c.name)) === fold(normText(p.name))))
  .map((p) => ({ p, c: candidates.find((c) => fold(normText(c.name)) === fold(normText(p.name))) }));

// ---------- not_running ----------
const keepIds = new Set(matched.map((x) => x.pid));
const notRunning = pe2026.filter((e) => !keepIds.has(e.politician_id) && /^AI/.test(e.source_note || ''));
const otherLeft = pe2026.filter((e) => !keepIds.has(e.politician_id) && !/^AI/.test(e.source_note || ''));

// ---------- Markdown ----------
const md = [];
md.push(`# 2026 縣市長登記參選名單匯入 dry-run`);
md.push(``);
md.push(`- 產生時間：${new Date().toISOString()}（只讀 anon key，未執行任何寫入）`);
md.push(`- 名單：${data._meta.source}，${candidates.length} 人／${data._meta.regions} 縣市（${data._meta.source_url}）`);
md.push(`- prod 現況：同名人物 ${sameName.length} 位、politician_keys ${keys.length} 筆、2026 縣市長參選紀錄 ${pe2026.length} 筆`);
md.push(`- 判定：**matched ${matched.length}／new ${created.length}／ambiguous ${ambiguous.length}**`);
md.push(`- matched 中已有 2026 縣市長 PE：${matched.filter((x) => x.existingPE).length}；沒有、要新增 PE：${matched.filter((x) => !x.existingPE).length}`);
md.push(`- 收尾 not_running：2026 縣市長、不在名單內、source_note 以 AI 開頭 → **${notRunning.length} 筆**；不在名單但非 AI 來源（不動、列出供人看）：${otherLeft.length} 筆`);
if (variantHits.length) {
  md.push(`- ⚠ 異體字：${variantHits.map(({ p, c }) => `名單「${c.name}」vs DB「${p.name}」(${p.id.slice(0, 8)}，${p.region})`).join('；')} —— 比對只看字面，這些不會自動對上；建議人工確認後補 alias_name key 再匯入，或先把 DB 姓名改成名單寫法。`);
}
md.push(``);
md.push(`ambiguous 的 ${ambiguous.length} 人**不會建立**、只進 politician_identity_reviews；他們在人工認定前不會出現在 2026 選舉頁。SQL 檔尾附「人工確認同一人時」的註解版指令，逐條解除註解即可。`);
md.push(``);
md.push(`## 特別檢查`);
md.push(``);
md.push(`| 姓名 | 預期 | 結果 | 判定 |`);
md.push(`|---|---|---|---|`);
for (const x of results.filter((x) => x.check)) md.push(`| ${x.c.name}（${x.c.region}） | ${EXPECTED[x.c.name] ?? '既有人物'} | ${x.pid ? x.pid.slice(0, 8) : x.r.decision} | ${x.check} |`);
md.push(``);
md.push(`## 逐筆`);
md.push(``);
md.push(`| # | 縣市 | 政黨 | 姓名 | 現職 | 判定 | 對到 | 分數 | 命中 key | 2026 PE | 備註 |`);
md.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
results.forEach((x, i) => {
  const top = x.r.candidates[0];
  const others = x.r.candidates.slice(0, 3).map((k) => `${k.politician_id.slice(0, 8)}:${k.score}${k.vetoed ? '(vetoed)' : ''}`).join(' ');
  const note = x.r.decision === 'ambiguous' ? `${x.r.reason}；候選＝${describe(top.politician_id)}` : '';
  md.push(`| ${i + 1} | ${x.c.region} | ${x.c.party} | ${x.c.name} | ${x.c.current_position ?? ''} | ${x.r.decision}${x.r.flag ? '+' + x.r.flag : ''} | ${x.pid ? x.pid.slice(0, 8) : (x.r.decision === 'ambiguous' ? others : '')} | ${top ? top.score : ''} | ${x.r.matched_keys.map((k) => k.key_type).join('+')} | ${x.existingPE ? `#${x.existingPE.id} ${x.existingPE.candidate_status}` : ''} | ${x.check} ${note} |`);
});
md.push(``);
md.push(`## 收尾：會被標成 not_running 的 2026 縣市長參選紀錄（${notRunning.length} 筆）`);
md.push(``);
md.push(`| PE id | 姓名 | 縣市 | 政黨 | 現狀態 | source_note |`);
md.push(`|---|---|---|---|---|---|`);
for (const e of notRunning) { const p = polById.get(e.politician_id); md.push(`| ${e.id} | ${p?.name ?? e.politician_id.slice(0, 8)} | ${p?.region ?? ''} | ${p?.party ?? ''} | ${e.candidate_status} | ${e.source_note} |`); }
md.push(``);
md.push(`## 不在名單、但來源不是 AI 的 2026 縣市長參選紀錄（不動，${otherLeft.length} 筆）`);
md.push(``);
md.push(`| PE id | 姓名 | 縣市 | 現狀態 | source_note |`);
md.push(`|---|---|---|---|---|`);
for (const e of otherLeft) { const p = polById.get(e.politician_id); md.push(`| ${e.id} | ${p?.name ?? e.politician_id.slice(0, 8)} | ${p?.region ?? ''} | ${e.candidate_status} | ${e.source_note ?? ''} |`); }
md.push(``);
md.push(`對應 SQL：\`scripts/import-2026-registered.sql\`（需先套 migration 20260912000001；transaction＋assert＋結尾 ROLLBACK）。`);

// ---------- SQL ----------
const s = [];
s.push(`-- ============================================================`);
s.push(`-- 2026 縣市長登記參選名單匯入（由 scripts/2026-registered-dryrun.mjs 於 ${new Date().toISOString()} 產生）`);
s.push(`-- 來源：${data._meta.source} ${data._meta.source_url}`);
s.push(`-- 計畫：matched ${matched.length}（更新／補 2026 PE 為 registered）、new ${created.length}（建人物＋PE）、ambiguous ${ambiguous.length}（進待審不建）、not_running ${notRunning.length}`);
s.push(`-- 前提：migration 20260912000001（candidate_status 加 registered/qualified/not_running）與 20260911000001~3 已套`);
s.push(`-- 先原樣跑（結尾 ROLLBACK）看 NOTICE 全 ok，再改 COMMIT 跑第二次；跑完另開連線查：`);
s.push(`--   SELECT candidate_status, COUNT(*) FROM politician_elections WHERE election_id = ${ELECTION_ID} AND election_type = '${ELECTION_TYPE}' GROUP BY 1;`);
s.push(`-- ============================================================`);
s.push(`BEGIN;`);
s.push(``);
s.push(`CREATE OR REPLACE FUNCTION pg_temp.assert_count(label TEXT, actual BIGINT, expected BIGINT) RETURNS TEXT`);
s.push(`LANGUAGE plpgsql AS $$`);
s.push(`BEGIN`);
s.push(`  IF actual <> expected THEN RAISE EXCEPTION 'ASSERT FAILED [%]: expected %, got %', label, expected, actual; END IF;`);
s.push(`  RAISE NOTICE 'ok [%] = %', label, actual;`);
s.push(`  RETURN 'ok';`);
s.push(`END; $$;`);
s.push(``);
s.push(`SELECT pg_temp.assert_count('2026 縣市長 PE before', (SELECT COUNT(*) FROM politician_elections WHERE election_id = ${ELECTION_ID} AND election_type = '${ELECTION_TYPE}'), ${pe2026.length});`);
s.push(`SELECT pg_temp.assert_count('同名人物 before', (SELECT COUNT(*) FROM politicians WHERE name IN (${names.map(sqlStr).join(', ')})), ${sameName.length});`);
s.push(``);
s.push(`-- ---------- matched：更新／補 2026 參選紀錄 ----------`);
for (const x of matched) {
  const rid = regionIdOf.get(normText(x.c.region)) ?? null;
  s.push(`-- ${x.c.region} ${x.c.party} ${x.c.name}（${x.c.current_position ?? ''}）→ ${x.pid}  [${x.r.matched_keys.map((k) => k.key_value).join(', ')}]`);
  if (x.existingPE) {
    s.push(`UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '${ELECTION_TYPE}', region_id = COALESCE(region_id, ${rid}), source_note = ${sqlStr(SOURCE_NOTE)} WHERE id = ${x.existingPE.id} AND politician_id = '${x.pid}';`);
  } else {
    s.push(`INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note) VALUES ('${x.pid}', ${ELECTION_ID}, '縣市長候選人', '${ELECTION_TYPE}', ${rid}, 'registered', false, ${sqlStr(SOURCE_NOTE)});`);
  }
  s.push(`UPDATE politicians SET current_position = COALESCE(current_position, ${sqlStr(x.c.current_position)}), party = ${sqlStr(x.c.party)} WHERE id = '${x.pid}';`);
}
s.push(``);
s.push(`-- ---------- new：建人物＋參選紀錄（觸發器會自動產 politician_keys） ----------`);
for (const x of created) {
  const rid = regionIdOf.get(normText(x.c.region)) ?? null;
  s.push(`-- ${x.c.region} ${x.c.party} ${x.c.name}（${x.c.current_position ?? ''}）${x.r.flag ? ' ⚠ ' + x.r.flag : ''}`);
  s.push(`WITH ins AS (`);
  s.push(`  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)`);
  s.push(`  VALUES (${sqlStr(x.c.name)}, ${sqlStr(x.c.party)}, 'politician', '${ELECTION_TYPE}', '縣市長候選人', ${sqlStr(x.c.current_position)}, ${sqlStr(x.c.region)}, ${rid})`);
  s.push(`  RETURNING id`);
  s.push(`) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)`);
  s.push(`  SELECT id, ${ELECTION_ID}, '縣市長候選人', '${ELECTION_TYPE}', ${rid}, 'registered', false, ${sqlStr(SOURCE_NOTE)} FROM ins;`);
}
s.push(``);
s.push(`-- ---------- ambiguous：不建，進待審 ----------`);
for (const x of ambiguous) {
  s.push(`INSERT INTO politician_identity_reviews (candidate, candidates, reason, source) VALUES (${sqlStr(JSON.stringify(x.c))}::jsonb, ${sqlStr(JSON.stringify(x.r.candidates))}::jsonb, ${sqlStr(x.r.reason)}, ${sqlStr(SOURCE_TAG)});`);
}
s.push(``);
s.push(`-- ---------- 收尾：AI 猜的、但沒登記 → not_running（${notRunning.length} 筆） ----------`);
if (notRunning.length) {
  s.push(`UPDATE politician_elections SET candidate_status = 'not_running' WHERE id IN (${notRunning.map((e) => e.id).join(', ')}) AND election_id = ${ELECTION_ID} AND candidate_status <> 'registered';`);
}
s.push(``);
s.push(`-- ---------- 事後檢查 ----------`);
s.push(`SELECT pg_temp.assert_count('registered', (SELECT COUNT(*) FROM politician_elections WHERE election_id = ${ELECTION_ID} AND election_type = '${ELECTION_TYPE}' AND candidate_status = 'registered'), ${matched.length + created.length});`);
s.push(`SELECT pg_temp.assert_count('not_running', (SELECT COUNT(*) FROM politician_elections WHERE election_id = ${ELECTION_ID} AND election_type = '${ELECTION_TYPE}' AND candidate_status = 'not_running'), ${notRunning.length});`);
s.push(`SELECT pg_temp.assert_count('new politicians', (SELECT COUNT(*) FROM politicians WHERE name IN (${names.map(sqlStr).join(', ')})), ${sameName.length + created.length});`);
s.push(`SELECT pg_temp.assert_count('reviews', (SELECT COUNT(*) FROM politician_identity_reviews WHERE source = ${sqlStr(SOURCE_TAG)}), ${ambiguous.length});`);
s.push(``);
s.push(`-- ---------- 人工確認「ambiguous 其實就是那個人」時，逐條解除註解（會取代上面對應的 reviews 插入，請一併刪掉那列）----------`);
for (const x of ambiguous) {
  const top = x.r.candidates[0];
  const rid = regionIdOf.get(normText(x.c.region)) ?? null;
  const existing = pe2026.find((e) => e.politician_id === top.politician_id);
  s.push(`-- ${x.c.region} ${x.c.party} ${x.c.name}（${x.c.current_position ?? ''}）↔ ${top.politician_id}（${describe(top.politician_id)}，分數 ${top.score}）`);
  if (existing) {
    s.push(`-- UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '${ELECTION_TYPE}', source_note = ${sqlStr(SOURCE_NOTE)} WHERE id = ${existing.id};`);
  } else {
    s.push(`-- INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note) VALUES ('${top.politician_id}', ${ELECTION_ID}, '縣市長候選人', '${ELECTION_TYPE}', ${rid}, 'registered', false, ${sqlStr(SOURCE_NOTE)});`);
  }
  s.push(`-- UPDATE politicians SET current_position = COALESCE(current_position, ${sqlStr(x.c.current_position)}), party = ${sqlStr(x.c.party)} WHERE id = '${top.politician_id}';`);
}
if (variantHits.length) {
  s.push(``);
  s.push(`-- ---------- 異體字：人工確認同一人後，先補 alias_name 再重跑 dry-run，就會 matched ----------`);
  for (const { p, c } of variantHits) {
    s.push(`-- INSERT INTO politician_keys (politician_id, key_type, key_value, strength, source) VALUES ('${p.id}', 'alias_name', ${sqlStr(normText(c.name))}, 3, 'manual:variant') ON CONFLICT DO NOTHING;  -- DB「${p.name}」← 名單「${c.name}」`);
  }
}
s.push(``);
s.push(`ROLLBACK; -- 主線審過後改成 COMMIT`);

fs.mkdirSync(path.join(ROOT, '.dedupe-check'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.dedupe-check/2026-registered-dryrun.md'), md.join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(ROOT, 'scripts/import-2026-registered.sql'), s.join('\n') + '\n', 'utf8');
console.log(`matched ${matched.length} / new ${created.length} / ambiguous ${ambiguous.length}；not_running ${notRunning.length}；非 AI 未登記 ${otherLeft.length}`);
console.log('已寫 .dedupe-check/2026-registered-dryrun.md 與 scripts/import-2026-registered.sql（未執行任何寫入）');
