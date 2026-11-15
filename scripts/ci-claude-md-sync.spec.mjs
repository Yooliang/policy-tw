import test from 'node:test';
import assert from 'node:assert/strict';
import { checkClaudeMdSync } from './ci-claude-md-sync.mjs';

const mig = 'supabase/migrations/20261115070000_x.sql';

test('觸發檔＋有改 CLAUDE.md：通過', () => {
  assert.deepEqual(checkClaudeMdSync([mig, 'CLAUDE.md'], ''), []);
});
test('觸發檔＋PR 描述有「CLAUDE.md 無需更新」：通過', () => {
  assert.deepEqual(checkClaudeMdSync([mig], '修 bug\n\nCLAUDE.md 無需更新'), []);
});
test('觸發檔＋兩者皆無：紅，列出觸發檔與兩種解法', () => {
  const e = checkClaudeMdSync([mig, 'README.md'], '只是修 bug');
  assert.equal(e.length, 1);
  assert.match(e[0], /20261115070000_x\.sql/);
  assert.match(e[0], /修改 CLAUDE\.md/);
  assert.match(e[0], /CLAUDE\.md 無需更新/);
  assert.doesNotMatch(e[0], /README/);
});
test('無觸發檔：通過', () => {
  assert.deepEqual(checkClaudeMdSync(['src/a.ts', 'README.md'], ''), []);
});
test('protocol.ts 與 docs/decisions 也算觸發；同名他處不算', () => {
  assert.equal(checkClaudeMdSync(['supabase/functions/_shared/protocol.ts'], '').length, 1);
  assert.equal(checkClaudeMdSync(['docs/decisions/2026-11-15-a.md'], null).length, 1);
  assert.deepEqual(checkClaudeMdSync(['supabase/functions/_shared/protocol.test.ts', 'docs/DECISIONS.md'], ''), []);
});
