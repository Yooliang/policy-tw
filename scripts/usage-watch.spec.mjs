import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, combinedStatsCount, functionCounts, functionIdMap, gatewayPaths, safeName } from './usage-watch.mjs';

const files = (m) => (f) => (f in m ? m[f] : null);
const AT = '2026-11-27T00:00:00.000Z';

test('Logs 排行：函式 id 對照成名稱，依次數排序、總數加總', () => {
  const s = buildSummary(
    files({
      'functions-list.json': [{ id: 'id-1', slug: 'next' }, { id: 'id-2', slug: 'report' }],
      'functions-logs.json': { result: [{ function_id: 'id-2', c: 5 }, { function_id: 'id-1', c: 90 }, { function_id: 'zzz', c: 1 }] },
    }),
    { 'functions-list': '200', 'functions-logs': '200' },
    AT,
  );
  assert.deepEqual(s.functions_24h, [
    { name: 'next', count: 90 },
    { name: 'report', count: 5 },
    { name: 'zzz', count: 1 },
  ]);
  assert.equal(s.functions_24h_total, 96);
  assert.equal(s.functions_source, 'logs');
  assert.equal(s.at, AT);
  assert.equal(s.org_cycle, null);
});

test('Logs 優先於 combined-stats', () => {
  const s = buildSummary(
    files({
      'functions-list.json': [{ id: 'id-1', slug: 'next' }],
      'functions-logs.json': { result: [{ function_id: 'id-1', c: 7 }] },
      'fn-next.json': { result: [{ count: 999 }] },
    }),
    { 'functions-list': '200', 'functions-logs': '200', 'fn-next': '200' },
    AT,
  );
  assert.equal(s.functions_source, 'logs');
  assert.equal(s.functions_24h_total, 7);
});

test('Logs 失敗（410）：改用 combined-stats 逐函式，errors 帶 Logs 錯誤體前 300 字', () => {
  const body = '{"message":"removed ' + 'x'.repeat(400) + '"}';
  const s = buildSummary(
    files({
      'functions-list.json': [
        { id: 'id-1', slug: 'next' },
        { id: 'id-2', slug: 'my.report' },
        { id: 'id-3', slug: 'odd' },
        { id: 'id-4', slug: 'gone' },
      ],
      'fn-next.json': { result: [{ timestamp: 1, count: 10 }, { timestamp: 2, count: '5' }] },
      'fn-my_report.json': { result: [{ total_invocations: 3 }] },
      'fn-odd.json': { foo: 1 },
      'fn-gone.json': { message: 'not found' },
    }),
    { 'functions-list': '200', 'functions-logs': '410', 'fn-next': '200', 'fn-my_report': '200', 'fn-odd': '200', 'fn-gone': '404' },
    AT,
    files({ 'functions-logs.json': body, 'fn-odd.json': '{"foo":1}', 'fn-gone.json': '{"message":"not found"}' }),
  );
  assert.equal(s.functions_source, 'combined-stats');
  assert.deepEqual(s.functions_24h, [
    { name: 'next', count: 15 },
    { name: 'my.report', count: 3 },
  ]);
  assert.equal(s.functions_24h_total, 18);
  assert.equal(s.errors[0], `functions-logs HTTP 410：${body.slice(0, 300)}`);
  assert.equal(s.errors[0].length, 'functions-logs HTTP 410：'.length + 300);
  assert.ok(s.errors.includes('fn-gone HTTP 404：{"message":"not found"}'));
  assert.ok(s.errors.includes('fn-odd 回應格式不明：{"foo":1}'));
});

test('逐函式錯誤超過三筆只列前三筆，其餘合併成數量', () => {
  const list = [1, 2, 3, 4, 5].map((i) => ({ id: `i${i}`, slug: `f${i}` }));
  const statuses = { 'functions-list': '200' };
  for (const f of list) statuses[`fn-${f.slug}`] = '400';
  const s = buildSummary(files({ 'functions-list.json': list }), statuses, AT);
  assert.equal(s.functions_24h_total, null);
  assert.equal(s.errors.length, 4);
  assert.equal(s.errors[3], '另有 2 支函式的 combined-stats 非 200');
});

test('閘道總數與路徑排行', () => {
  const s = buildSummary(
    files({
      'gateway-total.json': { result: [{ c: 1000 }] },
      'gateway-paths.json': { result: [{ p: '/a', c: 3 }, { p: '/b', c: 7 }] },
    }),
    { 'gateway-total': '200', 'gateway-paths': '200' },
    AT,
  );
  assert.equal(s.gateway_24h_total, 1000);
  assert.deepEqual(s.gateway_top_paths, [{ path: '/b', count: 7 }, { path: '/a', count: 3 }]);
});

test('全部沒抓到：形狀仍完整、org_cycle 為 null、閘道錯誤帶錯誤體', () => {
  const s = buildSummary(files({}), { 'gateway-total': '403' }, AT, files({ 'gateway-total.json': 'forbidden' }));
  assert.deepEqual(s.functions_24h, []);
  assert.equal(s.functions_24h_total, null);
  assert.equal(s.functions_source, null);
  assert.equal(s.gateway_24h_total, null);
  assert.deepEqual(s.gateway_top_paths, []);
  assert.equal(s.org_cycle, null);
  assert.deepEqual(s.errors, ['gateway-total HTTP 403：forbidden']);
});

test('小工具：非陣列與缺欄位', () => {
  assert.equal(functionCounts(null), null);
  assert.equal(functionCounts([{ foo: 1 }]), null);
  assert.equal(gatewayPaths([{ c: 1 }]), null);
  assert.equal(functionIdMap(null).size, 0);
});

test('combinedStatsCount：加總、空陣列為 0、形狀不明為 null', () => {
  assert.equal(combinedStatsCount({ result: [{ count: 2 }, { count: 3 }] }), 5);
  assert.equal(combinedStatsCount({ result: [] }), 0);
  assert.equal(combinedStatsCount([{ invocations: 4 }]), 4);
  assert.equal(combinedStatsCount({ foo: 1 }), null);
  assert.equal(combinedStatsCount({ result: [{ avg_ms: 12 }] }), null);
  assert.equal(combinedStatsCount(null), null);
});

test('safeName 與 workflow 的檔名規則一致', () => {
  assert.equal(safeName('a-b_c9'), 'a-b_c9');
  assert.equal(safeName('a.b c'), 'a_b_c');
});
