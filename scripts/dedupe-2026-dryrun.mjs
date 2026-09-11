// 2026 重複政治人物清理 dry-run（只讀 anon key，不執行任何寫入）
//
// 用法：node scripts/dedupe-2026-dryrun.mjs
//   - 讀 prod politicians / politician_elections / regions / policies（anon key，全 GET）
//   - 用 _shared/politician-identity.ts 同一套 resolvePolitician 判定每個重複群的去留
//   - 輸出 .dedupe-check/dryrun.md（計畫）與 scripts/dedupe-2026.sql（主線審過才跑）
//
// Node 22.18+ 原生支援 .ts 匯入（type stripping）；也可 deno run -A scripts/dedupe-2026-dryrun.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePolitician } from '../supabase/functions/_shared/politician-identity.ts';
import { storeFromSnapshot } from '../supabase/functions/_shared/identity-memory-store.ts';
import { normElectionType, normRegion, normText } from '../supabase/functions/_shared/identity-normalize.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_ELECTION = 2026;

// ---------- env / fetch ----------
function loadEnv() {
  const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const env = Object.fromEntries(
    text.split(/\r?\n/).filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
  );
  if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) throw new Error('.env 缺 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');
  return env;
}

async function fetchAll(env, table, select, filter = '') {
  const page = 1000;
  const rows = [];
  for (let from = 0; ; from += page) {
    const res = await fetch(`${env.VITE_SUPABASE_URL}/rest/v1/${table}?select=${select}${filter ? '&' + filter : ''}&order=id`, {
      headers: { apikey: env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${env.VITE_SUPABASE_ANON_KEY}`, Range: `${from}-${from + page - 1}` },
    });
    if (!res.ok) throw new Error(`${table} ${res.status} ${await res.text()}`);
    const chunk = await res.json();
    rows.push(...chunk);
    if (chunk.length < page) break;
  }
  return rows;
}

// ---------- 規則 ----------
const STATUS_RANK = { confirmed: 3, likely: 2, rumored: 1 };
const isOfficial = (pe) => pe.verified === true || /中選會/.test(pe.source_note || '');

/**
 * 保留優先序：有出生年 > 有 region_id > 政見多 > 有官方來源參選紀錄 > 參選紀錄多 > 最早的參選紀錄 id
 * 理由：出生年／region_id／政見是人物列自己帶的身份與內容（政見頁 URL 綁 UUID，SSG 也預渲染它）；
 *       參選紀錄只是掛在人身上的列，搬一筆 UPDATE 就好，所以官方來源排在後面。
 */
function keepScore(p, pes, policyCount) {
  return [
    p.birth_year ? 1 : 0,
    p.region_id ? 1 : 0,
    policyCount,
    pes.some(isOfficial) ? 1 : 0,
    pes.length,
    -Math.min(...pes.map((e) => e.id), Number.MAX_SAFE_INTEGER),
  ];
}
const cmpDesc = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i]; return 0; };

// ---------- main ----------
const env = loadEnv();
console.log('讀取 prod（只讀）…');
const [politicians, elections, regions, policies] = await Promise.all([
  fetchAll(env, 'politicians', 'id,name,party,status,election_type,position,region,sub_region,village,current_position,birth_year,region_id,avatar_url,bio'),
  fetchAll(env, 'politician_elections', 'id,politician_id,election_id,position,election_type,region_id,candidate_status,source_note,verified,election_result,votes_received'),
  fetchAll(env, 'regions', 'id,region'),
  fetchAll(env, 'policies', 'id,politician_id,title'),
]);
console.log(`politicians ${politicians.length}, politician_elections ${elections.length}, policies ${policies.length}`);

const polById = new Map(politicians.map((p) => [p.id, p]));
const regionById = new Map(regions.map((r) => [r.id, r.region]));
const pesOf = (id) => elections.filter((e) => e.politician_id === id);
const policiesOf = (id) => policies.filter((x) => x.politician_id === id);
const regionOfPe = (pe) => regionById.get(pe.region_id) ?? polById.get(pe.politician_id)?.region ?? null;

// 唯一約束檢查
const peKey = new Map();
for (const e of elections) { const k = `${e.politician_id}|${e.election_id}`; peKey.set(k, [...(peKey.get(k) ?? []), e.id]); }
const peViolations = [...peKey.entries()].filter(([, ids]) => ids.length > 1);

// 同一套 key store（等同 migration 回填）
const store = storeFromSnapshot(
  politicians,
  elections.map((e) => ({ politician_id: e.politician_id, region: regionOfPe(e), election_type: e.election_type, position: e.position })),
);

// 2026 重複群：同名 + 同類型 + 同縣市
const groups = new Map();
for (const e of elections.filter((x) => x.election_id === TARGET_ELECTION)) {
  const p = polById.get(e.politician_id);
  if (!p) continue;
  const key = `${normText(p.name)}|${normRegion(regionOfPe(e)) ?? '?'}|${normElectionType(e.election_type) ?? '?'}`;
  const g = groups.get(key) ?? new Map();
  g.set(p.id, p);
  groups.set(key, g);
}
const dupGroups = [...groups.entries()].filter(([, g]) => g.size > 1).map(([key, g]) => ({ key, members: [...g.values()] }));

// ---------- 逐群判定 ----------
const md = [];
const sqlBlocks = [];
let totalDelete = 0, totalMovePE = 0, totalDropPE = 0, totalMovePolicies = 0;

md.push(`# 2026 重複政治人物清理 dry-run`);
md.push(``);
md.push(`- 產生時間：${new Date().toISOString()}（只讀 anon key，未執行任何寫入）`);
md.push(`- 資料量：politicians ${politicians.length}、politician_elections ${elections.length}、policies ${policies.length}`);
md.push(`- politician_elections (politician_id, election_id) 違反唯一：**${peViolations.length} 組**${peViolations.length ? '：' + peViolations.map(([k, ids]) => `${k} → ids ${ids.join(',')}`).join('；') : ''}`);
md.push(`- 2026 同名同類型同縣市重複群：**${dupGroups.length} 組**`);
md.push(``);
md.push(`判定方式：每位成員以 \`resolvePolitician\` 對「排除整群後的資料庫」比對（問：這群若不存在，這筆會落到誰身上？）；`);
md.push(`有外部 matched 就以那位為保留者，否則在群內用「有出生年 > 有 region_id > 政見數 > 有官方來源參選紀錄 > 參選紀錄數 > 最早參選紀錄」挑（人物列帶的身份／內容優先，參選紀錄搬一筆 UPDATE 就好）。`);
md.push(`另對每位成員以「只排除自己」比對，確認成員彼此真的互相對得上（群內分數）。`);
md.push(``);

for (const { key, members } of dupGroups.sort((a, b) => a.key.localeCompare(b.key, 'zh-Hant'))) {
  const memberIds = members.map((m) => m.id);
  const outside = store.without(memberIds);

  const decisions = [];
  for (const m of members) {
    const facets = { name: m.name, party: m.party, region: m.region, election_type: m.election_type, position: m.position, current_position: m.current_position, birth_year: m.birth_year };
    const ext = await resolvePolitician(outside, facets, { persist: false });
    const inner = await resolvePolitician(store.without([m.id]), facets, { persist: false });
    const innerBest = inner.candidates.find((c) => memberIds.includes(c.politician_id));
    decisions.push({ m, ext, inner, innerBest });
  }

  const externalMatches = [...new Set(decisions.filter((d) => d.ext.decision === 'matched').map((d) => d.ext.politician_id))];
  let keep, keepReason;
  if (externalMatches.length === 1) {
    keep = polById.get(externalMatches[0]);
    keepReason = `群外有同一人（${decisions.filter((d) => d.ext.politician_id === keep.id).length}/${members.length} 位成員都判到他）`;
  } else {
    const ranked = [...members].sort((a, b) => cmpDesc(keepScore(a, pesOf(a.id), policiesOf(a.id).length), keepScore(b, pesOf(b.id), policiesOf(b.id).length)));
    keep = ranked[0];
    keepReason = externalMatches.length > 1 ? `⚠ 群外對到 ${externalMatches.length} 位不同人，改用群內規則` : '群外無同一人，用群內規則';
  }
  const toDelete = members.filter((m) => m.id !== keep.id);
  const keepPEs = pesOf(keep.id);
  const keepElectionIds = new Set(keepPEs.map((e) => e.election_id));

  // 參選紀錄搬移計畫
  const movePE = [], dropPE = [], statusUpgrade = [];
  for (const d of toDelete) {
    for (const pe of pesOf(d.id)) {
      if (keepElectionIds.has(pe.election_id)) {
        dropPE.push(pe);
        const kept = keepPEs.find((e) => e.election_id === pe.election_id);
        if ((STATUS_RANK[pe.candidate_status] ?? 0) > (STATUS_RANK[kept.candidate_status] ?? 0)) statusUpgrade.push({ kept, from: pe });
      } else {
        movePE.push(pe);
        keepElectionIds.add(pe.election_id);
      }
    }
  }
  const movePolicies = toDelete.flatMap((d) => policiesOf(d.id));
  const bestUpgrade = statusUpgrade.sort((a, b) => (STATUS_RANK[b.from.candidate_status] ?? 0) - (STATUS_RANK[a.from.candidate_status] ?? 0))[0];

  totalDelete += toDelete.length; totalMovePE += movePE.length; totalDropPE += dropPE.length; totalMovePolicies += movePolicies.length;

  const flags = decisions.filter((d) => d.ext.decision === 'ambiguous' || (d.innerBest && d.innerBest.score < 2) || !d.innerBest);

  md.push(`## ${key}（${members.length} 筆）`);
  md.push(``);
  md.push(`**保留** \`${keep.id}\` — ${keepReason}`);
  md.push(``);
  md.push(`| id | 出生年 | region_id | 政黨 | 職位 | 現職 | 參選紀錄 | 政見 | 群外判定 | 群內對保留者分數 | 處置 |`);
  md.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const d of decisions) {
    const { m, ext, innerBest } = d;
    const pes = pesOf(m.id);
    const peDesc = pes.map((e) => `${e.election_id}:${e.candidate_status}${isOfficial(e) ? '★' : ''}`).join(' ');
    const extDesc = ext.decision === 'matched' ? `matched→${ext.politician_id.slice(0, 8)}(${ext.candidates[0]?.score})` : ext.decision + (ext.flag ? `+${ext.flag}` : '') + (ext.decision === 'ambiguous' ? ` (${ext.candidates.map((c) => `${c.politician_id.slice(0, 8)}:${c.score}`).join(',')})` : '');
    const innerScore = m.id === keep.id ? '—' : innerBest ? `${innerBest.score}（${innerBest.matched_keys.map((k) => k.key_type).join('+')}）` : '0 ⚠';
    const action = m.id === keep.id ? '保留' : '刪除';
    md.push(`| \`${m.id.slice(0, 8)}\` | ${m.birth_year ?? ''} | ${m.region_id ?? ''} | ${m.party ?? ''} | ${m.position ?? ''} | ${m.current_position ?? ''} | ${peDesc} | ${policiesOf(m.id).length} | ${extDesc} | ${innerScore} | ${action} |`);
  }
  md.push(``);
  md.push(`- 刪除人物 ${toDelete.length} 筆；搬參選紀錄 ${movePE.length} 筆（${movePE.map((e) => `#${e.id}→${e.election_id}`).join(', ') || '無'}）；同場選舉重複而直接刪的參選紀錄 ${dropPE.length} 筆；搬政見 ${movePolicies.length} 筆`);
  if (bestUpgrade) md.push(`- 保留者 ${bestUpgrade.kept.election_id} 參選狀態 ${bestUpgrade.kept.candidate_status} → **${bestUpgrade.from.candidate_status}**（被刪者較新的判定）`);
  if (flags.length) md.push(`- ⚠ 需人看：${flags.map((d) => `${d.m.id.slice(0, 8)}（群外 ${d.ext.decision}${d.innerBest ? `、群內分數 ${d.innerBest.score}` : '、群內 0 分'}）`).join('；')}`);
  md.push(`- ★＝官方來源／已驗證`);
  md.push(``);

  // SQL
  const ids = (list) => list.map((x) => `'${x.id}'`).join(', ');
  const s = [];
  s.push(`-- ---------- ${key}：保留 ${keep.id}，刪 ${toDelete.length} 筆 ----------`);
  s.push(`SELECT assert_count('politicians ${key}', (SELECT COUNT(*) FROM politicians WHERE id IN (${ids([keep, ...toDelete])})), ${members.length});`);
  if (movePE.length) {
    s.push(`UPDATE politician_elections SET politician_id = '${keep.id}' WHERE id IN (${movePE.map((e) => e.id).join(', ')});`);
    s.push(`SELECT assert_count('moved PE ${key}', (SELECT COUNT(*) FROM politician_elections WHERE politician_id = '${keep.id}' AND id IN (${movePE.map((e) => e.id).join(', ')})), ${movePE.length});`);
  }
  if (bestUpgrade) {
    s.push(`UPDATE politician_elections SET candidate_status = '${bestUpgrade.from.candidate_status}' WHERE id = ${bestUpgrade.kept.id} AND candidate_status = '${bestUpgrade.kept.candidate_status}';`);
  }
  if (dropPE.length) s.push(`DELETE FROM politician_elections WHERE id IN (${dropPE.map((e) => e.id).join(', ')});`);
  if (movePolicies.length) {
    s.push(`UPDATE policies SET politician_id = '${keep.id}' WHERE id IN (${ids(movePolicies)});`);
    s.push(`SELECT assert_count('moved policies ${key}', (SELECT COUNT(*) FROM policies WHERE politician_id = '${keep.id}' AND id IN (${ids(movePolicies)})), ${movePolicies.length});`);
  }
  s.push(`UPDATE ai_prompts SET politician_id = '${keep.id}' WHERE politician_id IN (${ids(toDelete)});`);
  s.push(`SELECT assert_count('no PE left ${key}', (SELECT COUNT(*) FROM politician_elections WHERE politician_id IN (${ids(toDelete)})), 0);`);
  s.push(`SELECT assert_count('no policies left ${key}', (SELECT COUNT(*) FROM policies WHERE politician_id IN (${ids(toDelete)})), 0);`);
  s.push(`DELETE FROM politicians WHERE id IN (${ids(toDelete)});`);
  s.push(``);
  sqlBlocks.push(s.join('\n'));
}

md.push(`## 合計`);
md.push(``);
md.push(`| 項目 | 筆數 |`);
md.push(`|---|---|`);
md.push(`| 刪除 politicians | ${totalDelete} |`);
md.push(`| 搬移 politician_elections | ${totalMovePE} |`);
md.push(`| 刪除同場重複 politician_elections | ${totalDropPE} |`);
md.push(`| 搬移 policies | ${totalMovePolicies} |`);
md.push(``);
md.push(`對應 SQL：\`scripts/dedupe-2026.sql\`（transaction 包住、每步 assert、結尾 ROLLBACK；主線審過改 COMMIT）。`);

const sql = `-- ============================================================
-- 2026 重複政治人物清理（由 scripts/dedupe-2026-dryrun.mjs 於 ${new Date().toISOString()} 產生）
-- 計畫說明見 .dedupe-check/dryrun.md。
--
-- 執行前提：
--   1. migration 20260911000001~3 已套（politician_keys 存在；PE 唯一索引已建）
--   2. 先確認沒有人正在讀這些 id（前端 IndexedDB 快取會晚一點才換）
--   3. 整段在一個 transaction 內；任何 assert 失敗會 RAISE 直接中止
--   4. 最後一行是 ROLLBACK：先跑一次看 NOTICE 全部通過，再把 ROLLBACK 改成 COMMIT 跑第二次
--   5. 跑完用另一條連線重查：SELECT name, COUNT(*) FROM politicians WHERE name IN (...) GROUP BY 1;
-- 期望：刪 ${totalDelete} 位、搬 ${totalMovePE} 筆參選紀錄、刪 ${totalDropPE} 筆同場重複參選紀錄、搬 ${totalMovePolicies} 筆政見
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_count(label TEXT, actual BIGINT, expected BIGINT) RETURNS TEXT
LANGUAGE plpgsql AS $$
BEGIN
  IF actual <> expected THEN
    RAISE EXCEPTION 'ASSERT FAILED [%]: expected %, got %', label, expected, actual;
  END IF;
  RAISE NOTICE 'ok [%] = %', label, actual;
  RETURN 'ok';
END;
$$;

-- 事前總量
SELECT pg_temp.assert_count('politicians total', (SELECT COUNT(*) FROM politicians), ${politicians.length});
SELECT pg_temp.assert_count('politician_elections total', (SELECT COUNT(*) FROM politician_elections), ${elections.length});
SELECT pg_temp.assert_count('policies total', (SELECT COUNT(*) FROM policies), ${policies.length});

${sqlBlocks.join('\n').replace(/SELECT assert_count\(/g, 'SELECT pg_temp.assert_count(')}
-- 事後總量
SELECT pg_temp.assert_count('politicians after', (SELECT COUNT(*) FROM politicians), ${politicians.length - totalDelete});
SELECT pg_temp.assert_count('politician_elections after', (SELECT COUNT(*) FROM politician_elections), ${elections.length - totalDropPE});
SELECT pg_temp.assert_count('policies after', (SELECT COUNT(*) FROM policies), ${policies.length});

-- politician_keys 由 ON DELETE CASCADE 自動清掉被刪者的 key；保留者的 key 由觸發器在搬移 PE 時補上。

ROLLBACK; -- 主線審過後改成 COMMIT
`;

fs.mkdirSync(path.join(ROOT, '.dedupe-check'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.dedupe-check/dryrun.md'), md.join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(ROOT, 'scripts/dedupe-2026.sql'), sql, 'utf8');
console.log(`重複群 ${dupGroups.length} 組；刪 ${totalDelete}、搬 PE ${totalMovePE}、刪重複 PE ${totalDropPE}、搬政見 ${totalMovePolicies}`);
console.log(`PE 唯一約束違反：${peViolations.length} 組`);
console.log('已寫 .dedupe-check/dryrun.md 與 scripts/dedupe-2026.sql（未執行任何寫入）');
