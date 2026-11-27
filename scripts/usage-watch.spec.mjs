import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, functionCounts, functionIdMap, gatewayPaths } from './usage-watch.mjs';

const files = (m) => (f) => (f in m ? m[f] : null);
const AT = '2026-11-27T00:00:00.000Z';

test('路徑 B：函式 id 對照成名稱，依次數排序、總數加總', () => {
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
  assert.equal(s.functions_source, 'functions-logs');
  assert.equal(s.at, AT);
});

test('路徑 A 優先於 B；不是 200 的端點記進 errors', () => {
  const s = buildSummary(
    files({
      'functions.inv-stats.json': { result: [{ function_name: 'next', count: '12' }] },
      'functions-logs.json': { result: [{ function_id: 'x', c: 999 }] },
    }),
    { 'functions.inv-stats': '200', 'functions.combined-stats': '404', 'functions-logs': '200' },
    AT,
  );
  assert.equal(s.functions_source, 'functions.inv-stats');
  assert.equal(s.functions_24h_total, 12);
  assert.deepEqual(s.errors, ['functions.combined-stats HTTP 404']);
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

test('全部沒抓到：形狀仍完整、org_cycle 為 null', () => {
  const s = buildSummary(files({}), { 'org-usage': '403' }, AT);
  assert.deepEqual(s.functions_24h, []);
  assert.equal(s.functions_24h_total, null);
  assert.equal(s.gateway_24h_total, null);
  assert.deepEqual(s.gateway_top_paths, []);
  assert.equal(s.org_cycle, null);
  assert.deepEqual(s.errors, ['org-usage HTTP 403']);
});

test('組織用量取第一個 200 的端點', () => {
  const s = buildSummary(
    files({ 'org-usage.json': { usages: [] }, 'org-billing-usage.json': { x: 1 } }),
    { 'org-usage': '404', 'org-billing-usage': '200' },
    AT,
  );
  assert.equal(s.org_cycle.source, 'org-billing-usage');
});

test('小工具：非陣列與缺欄位', () => {
  assert.equal(functionCounts(null), null);
  assert.equal(functionCounts([{ foo: 1 }]), null);
  assert.equal(gatewayPaths([{ c: 1 }]), null);
  assert.equal(functionIdMap(null).size, 0);
});
