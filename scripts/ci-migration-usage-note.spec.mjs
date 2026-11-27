import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUsageNote, hasUsageNote, MISSING_MESSAGE } from './ci-migration-usage-note.mjs';

const cronMigration = [
  { path: 'supabase/migrations/20261127000000_x.sql', added: "SELECT cron.schedule('x', '*/10 * * * *', 'select 1');" },
];

test('含 cron.schedule 的 migration 且沒寫呼叫量：失敗', () => {
  const e = checkUsageNote(cronMigration, '## 做法\n只是說明', 'pull_request');
  assert.equal(e.length, 1);
  assert.ok(e[0].includes(MISSING_MESSAGE));
});

test('有「每日呼叫量變化：」且含數字：通過', () => {
  assert.deepEqual(checkUsageNote(cronMigration, '每日呼叫量變化：+144／天（每 10 分鐘）', 'pull_request'), []);
  assert.deepEqual(checkUsageNote(cronMigration, '每日呼叫量變化: 0（純讀表改法）', 'pull_request'), []);
});

test('有欄位但沒有數字、或只剩範本註解：失敗', () => {
  assert.equal(checkUsageNote(cronMigration, '每日呼叫量變化：很少', 'pull_request').length, 1);
  assert.equal(checkUsageNote(cronMigration, '每日呼叫量變化：\n<!-- 寫 0 也可以 -->', 'pull_request').length, 1);
});

test('只改 docs：通過', () => {
  const files = [{ path: 'docs/decisions/x.md', added: 'cron.schedule( 只是文字' }];
  assert.deepEqual(checkUsageNote(files, '', 'pull_request'), []);
});

test('push 事件：通過', () => {
  assert.deepEqual(checkUsageNote(cronMigration, '', 'push'), []);
});

test('其他規則：觸發器、對外 fetch、setInterval、workflow schedule', () => {
  const body = '';
  const cases = [
    { path: 'supabase/migrations/1.sql', added: 'create trigger t after insert on x' },
    { path: 'supabase/migrations/2.sql', added: 'select net.http_post(url := 1)' },
    { path: 'supabase/functions/a/index.ts', added: 'setInterval(() => {}, 2000)' },
    { path: 'supabase/functions/a/index.ts', added: "await fetch('https://example.com/api')" },
    { path: '.github/workflows/z.yml', added: "  schedule:\n    - cron: '0 * * * *'" },
  ];
  for (const c of cases) assert.equal(checkUsageNote([c], body, 'pull_request').length, 1, c.path);
});

test('不算：fetch 到 supabase 網域、一般 yml 內容', () => {
  const files = [
    { path: 'supabase/functions/a/index.ts', added: "await fetch('https://abc.supabase.co/rest/v1/x')" },
    { path: '.github/workflows/z.yml', added: '  on: pull_request' },
  ];
  assert.deepEqual(checkUsageNote(files, '', 'pull_request'), []);
});

test('hasUsageNote 辨識', () => {
  assert.equal(hasUsageNote('每日呼叫量變化：−130,000／天'), true);
  assert.equal(hasUsageNote(undefined), false);
});
