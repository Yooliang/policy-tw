#!/usr/bin/env node
/**
 * PR 階段擋「新增排程、輪詢、觸發器、對外呼叫，卻沒寫每日呼叫量」（2026-11-27）。
 *
 * 起因：Supabase 帳單超量的真因是 11-10 加的一支每 2 秒輪詢（一天約 13 萬次），
 * 加的時候沒有人寫「一天幾次」。這個守門要求這類 PR 的說明必須有一行
 * 「每日呼叫量變化：…」，內容要有數字（例如「+432／天（3 台 × 每 10 分鐘保底）」、
 * 「−130,000／天」、「0（純讀表改法）」）。
 *
 * 判斷「會增加呼叫量」的規則（簡單字串比對，寬鬆）：
 *   - supabase/migrations/*.sql 新增行含 cron.schedule( 、CREATE TRIGGER、net.http_post、net.http_get
 *   - supabase/functions/** 新增行含 setInterval( 、EventSource，或 fetch( 到非 supabase 網域
 *   - .github/workflows/*.yml 新增行含 schedule:
 * 非 PR 事件（push main）直接通過。
 *
 * 用法：PR_BODY=<PR 說明> GITHUB_EVENT_NAME=pull_request node scripts/ci-migration-usage-note.mjs
 * PR 說明一律走環境變數，不內插進 shell。需要能取得 origin/main（會自己 fetch）。
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MISSING_MESSAGE =
  'PR 說明缺「每日呼叫量變化：…」，新增排程／輪詢／觸發器／對外呼叫的 PR 必填';

const MIGRATION_KEYWORDS = ['cron.schedule(', 'CREATE TRIGGER', 'net.http_post', 'net.http_get'];

/** 一行 fetch( 呼叫是否打到非 supabase 網域。 */
function isExternalFetch(line) {
  if (!line.includes('fetch(')) return false;
  const m = /https?:\/\/[^\s'"`)]+/.exec(line);
  return m !== null && !/supabase/i.test(m[0]);
}

/** 回傳這個檔案新增行裡命中的規則說明（空陣列＝沒命中）。 */
export function hitsOf(path, added) {
  const p = path.replace(/\\/g, '/');
  const hits = [];
  if (/^supabase\/migrations\/[^/]+\.sql$/.test(p)) {
    const upper = added.toUpperCase();
    for (const k of MIGRATION_KEYWORDS) {
      if (upper.includes(k.toUpperCase())) hits.push(k);
    }
  } else if (p.startsWith('supabase/functions/')) {
    if (added.includes('setInterval(')) hits.push('setInterval(');
    if (added.includes('EventSource')) hits.push('EventSource');
    if (added.split(/\r?\n/).some(isExternalFetch)) hits.push('fetch( 對外網域');
  } else if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)) {
    if (/^\s*[+-]?\s*schedule:/m.test(added)) hits.push('schedule:');
  }
  return hits;
}

/** PR 說明有沒有一行含數字的「每日呼叫量變化：…」（先去掉 HTML 註解，免得範本提示充數）。 */
export function hasUsageNote(body) {
  const text = (body ?? '').replace(/<!--[\s\S]*?-->/g, '');
  return text.split(/\r?\n/).some((line) => {
    const m = /每日呼叫量變化[:：][ \t]*(\S.*)$/.exec(line);
    return m !== null && /\d/.test(m[1]);
  });
}

/**
 * 純函式：回傳錯誤訊息陣列（空＝通過）。
 * @param {{path: string, added: string}[]} files 變更檔與其新增行文字
 * @param {string} body PR 說明
 * @param {string} eventName GitHub 事件名稱
 */
export function checkUsageNote(files, body, eventName) {
  if (eventName !== 'pull_request') return [];
  const triggered = [];
  for (const f of files) {
    const hits = hitsOf(f.path, f.added);
    if (hits.length) triggered.push(`  - ${f.path}（${hits.join('、')}）`);
  }
  if (triggered.length === 0) return [];
  if (hasUsageNote(body)) return [];
  return [`${MISSING_MESSAGE}\n這張 PR 有下列變更會增加呼叫量：\n${triggered.join('\n')}`];
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function collectFiles() {
  const names = git('diff', '--name-only', '--no-renames', 'origin/main...HEAD').split(/\r?\n/).filter(Boolean);
  return names.map((path) => {
    const diff = git('diff', '-U0', '--no-renames', 'origin/main...HEAD', '--', path);
    const added = diff
      .split(/\r?\n/)
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1))
      .join('\n');
    return { path, added };
  });
}

function main() {
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';
  if (eventName !== 'pull_request') {
    console.log('不是 PR 事件，略過每日呼叫量檢查。');
    return;
  }
  execFileSync('git', ['fetch', 'origin', 'main', '--depth=1'], { stdio: 'inherit' });
  const errors = checkUsageNote(collectFiles(), process.env.PR_BODY ?? '', eventName);
  if (errors.length) {
    for (const e of errors) console.error(`::error title=缺每日呼叫量變化::${e.replace(/\n/g, '%0A')}`);
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log('通過：這張 PR 沒有新增排程／輪詢／觸發器／對外呼叫，或說明已寫每日呼叫量變化。');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
