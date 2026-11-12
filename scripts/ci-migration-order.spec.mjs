import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOrder, nextMinute, stamp } from './ci-migration-order.mjs';

const main = [
  'supabase/migrations/20261112060000_a.sql',
  'supabase/migrations/20261112110000_b.sql',
];

test('晚於 main 最新：通過', () => {
  assert.deepEqual(checkOrder(['supabase/migrations/20261112120000_x.sql'], main), []);
});
test('早於 main 最新：紅，並建議改名', () => {
  const e = checkOrder(['supabase/migrations/20261112020000_x.sql'], main);
  assert.equal(e.length, 1);
  assert.match(e[0], /20261112110100_x\.sql/);
});
test('等於 main 最新：紅', () => {
  assert.ok(checkOrder(['supabase/migrations/20261112110000_x.sql'], main).length >= 1);
});
test('同 PR 重複時間戳：紅', () => {
  const e = checkOrder(
    ['supabase/migrations/20261113000000_x.sql', 'supabase/migrations/20261113000000_y.sql'],
    main,
  );
  assert.equal(e.length, 1);
  assert.match(e[0], /重複/);
});
test('檔名格式不對：紅', () => {
  assert.equal(checkOrder(['supabase/migrations/foo.sql'], main).length, 1);
});
test('nextMinute 進位與 stamp', () => {
  assert.equal(nextMinute('20261231235900'), '20270101000000');
  assert.equal(stamp('supabase/migrations/20261112060000_a.sql'), '20261112060000');
});
