// 由 fixtures/normalization-cases.json 產生 scripts/verify-identity-norm.sql
// 用法：node scripts/gen-identity-norm-check.mjs
// 產出的 SQL 在套完 migration 後於 Supabase SQL editor 跑，回傳 0 列＝SQL 版正規化與 TS 版案例一致。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cases = JSON.parse(fs.readFileSync(path.join(root, 'supabase/functions/_shared/fixtures/normalization-cases.json'), 'utf8'));

const lit = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const sections = [
  ['identity_norm_text', cases.text],
  ['identity_norm_party', cases.party],
  ['identity_norm_position', cases.position],
  ['identity_norm_election_type', cases.election_type],
  ['identity_position_strength', cases.position_strength],
];

const rows = sections.flatMap(([fn, list]) =>
  list.map((c) => `  (${lit(fn)}, ${lit(c.in)}, ${lit(c.out)}::TEXT)`),
);

const sql = `-- 由 scripts/gen-identity-norm-check.mjs 自動產生，勿手改；改案例請改 normalization-cases.json 後重跑。
-- 用途：驗 migration 20260911000001 的 SQL 正規化函式與 TS 版（identity-normalize.ts）行為一致。
-- 期望：回傳 0 列。有列就是兩邊分歧，列出 fn / 輸入 / 期望 / 實得。
WITH cases(fn, input, expected) AS (VALUES
${rows.join(',\n')}
),
actual AS (
  SELECT fn, input, expected,
    CASE fn
      WHEN 'identity_norm_text' THEN identity_norm_text(input)
      WHEN 'identity_norm_party' THEN identity_norm_party(input)
      WHEN 'identity_norm_position' THEN identity_norm_position(input)
      WHEN 'identity_norm_election_type' THEN identity_norm_election_type(input)
      WHEN 'identity_position_strength' THEN identity_position_strength(input)::TEXT
    END AS got
  FROM cases
)
SELECT fn, input, expected, got
FROM actual
WHERE got IS DISTINCT FROM expected
ORDER BY fn, input;
`;

const out = path.join(root, 'scripts/verify-identity-norm.sql');
fs.writeFileSync(out, sql, 'utf8');
console.log(`wrote ${out} (${rows.length} cases)`);
