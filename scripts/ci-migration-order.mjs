#!/usr/bin/env node
/**
 * PR 階段擋「新增的 migration 時間戳不大於 main 最新一支」（2026-11-12）。
 *
 * 起因：`supabase db push` 不收比遠端已套用的最新一支還早的檔。當天兩個 PR（020000、080000）
 * 合在 060000、110000 之後，合併後的 db push 兩次都失敗。這個守門把失敗提前到 PR 階段。
 * 也擋同一個 PR 內新增檔重複時間戳（schema_migrations 的 version 是主鍵）。
 *
 * 用法：node scripts/ci-migration-order.mjs   （需要能取得 origin/main；會自己 fetch）
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = 'supabase/migrations/';

/** 檔名（可含路徑）前 14 碼時間戳；不符格式回 null。 */
export function stamp(name) {
  const base = name.split('/').pop();
  const m = /^(\d{14})_/.exec(base);
  return m ? m[1] : null;
}

/** 14 碼時間戳加一分鐘（秒歸零）。 */
export function nextMinute(ts) {
  const d = new Date(Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12)));
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00`;
}

/**
 * 純函式：回傳錯誤訊息陣列（空＝通過）。
 * @param {string[]} added PR 新增的 migration 檔名
 * @param {string[]} mainFiles main 上現有的 migration 檔名
 */
export function checkOrder(added, mainFiles) {
  const errors = [];
  const mainStamps = mainFiles.map(stamp).filter(Boolean).sort();
  const mainLatest = mainStamps[mainStamps.length - 1] ?? '';
  const seen = new Map();
  for (const f of added) {
    const ts = stamp(f);
    if (!ts) {
      errors.push(`${f}：檔名要以 14 碼時間戳開頭（YYYYMMDDHHMMSS_名稱.sql）。`);
      continue;
    }
    if (seen.has(ts)) {
      errors.push(`${f} 與 ${seen.get(ts)} 時間戳重複（${ts}）；同一 PR 內每支要不同。`);
    } else {
      seen.set(ts, f);
    }
    if (ts <= mainLatest) {
      const rest = f.split('/').pop().slice(15);
      errors.push(
        `${f}：時間戳 ${ts} 不大於 main 最新的 ${mainLatest}，合併後 db push 會被拒絕。` +
          `建議改名為 ${nextMinute(mainLatest)}_${rest}`,
      );
    }
  }
  return errors;
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);

function main() {
  execFileSync('git', ['fetch', 'origin', 'main', '--depth=1'], { stdio: 'inherit' });
  const added = git('diff', '--name-only', '--diff-filter=A', 'origin/main...HEAD', '--', DIR).filter((f) => f.endsWith('.sql'));
  if (added.length === 0) {
    console.log('這個 PR 沒有新增 migration，略過時間戳檢查。');
    return;
  }
  const mainFiles = git('ls-tree', '--name-only', 'origin/main', DIR);
  const errors = checkOrder(added, mainFiles);
  if (errors.length) {
    for (const e of errors) console.error(`::error::${e}`);
    process.exit(1);
  }
  console.log(`新增 ${added.length} 支 migration，時間戳都大於 main 最新一支。`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
