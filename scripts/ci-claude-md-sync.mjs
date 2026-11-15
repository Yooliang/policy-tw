#!/usr/bin/env node
/**
 * PR 階段擋「動到會讓 CLAUDE.md 過時的檔，卻沒檢查 CLAUDE.md」（2026-11-15）。
 *
 * CLAUDE.md 的同步規則（11-15 #962）：PR 動到 supabase/migrations、
 * supabase/functions/_shared/protocol.ts 或 docs/decisions 時，同一張 PR 要檢查 CLAUDE.md；
 * 沒有要改，就在 PR 描述寫「CLAUDE.md 無需更新」。這支把那條規則變成硬規則。
 *
 * 用法（由 .github/workflows/claude-md-sync.yml 呼叫）：
 *   CHANGED_FILES=<換行分隔的檔案清單> PR_BODY=<PR 描述> node scripts/ci-claude-md-sync.mjs
 * PR 描述一律走環境變數，不內插進 shell。
 */
import { fileURLToPath } from 'node:url';

export const TRIGGERS = [
  { label: 'supabase/migrations/**', test: (f) => f.startsWith('supabase/migrations/') },
  { label: 'supabase/functions/_shared/protocol.ts', test: (f) => f === 'supabase/functions/_shared/protocol.ts' },
  { label: 'docs/decisions/**', test: (f) => f.startsWith('docs/decisions/') },
];
export const WAIVER = 'CLAUDE.md 無需更新';

/** 回傳錯誤訊息陣列；空陣列＝通過。 */
export function checkClaudeMdSync(files, body) {
  const list = files.map((f) => f.trim()).filter(Boolean);
  const triggered = list.filter((f) => TRIGGERS.some((t) => t.test(f)));
  if (triggered.length === 0) return [];
  if (list.includes('CLAUDE.md')) return [];
  if ((body ?? '').includes(WAIVER)) return [];
  const shown = triggered.slice(0, 10).map((f) => `  - ${f}`).join('\n');
  const more = triggered.length > 10 ? `\n  …另有 ${triggered.length - 10} 個` : '';
  return [
    `這張 PR 動到會影響 CLAUDE.md 的檔案，但 CLAUDE.md 沒有跟著檢查：\n${shown}${more}\n` +
      `兩種解法擇一：\n` +
      `  1. 這張 PR 一併修改 CLAUDE.md 對應的條目。\n` +
      `  2. 檢查後確定不用改，就在 PR 描述加一句「${WAIVER}」（改完描述會自動重跑）。`,
  ];
}

function main() {
  const files = (process.env.CHANGED_FILES ?? '').split(/\r?\n/);
  const errors = checkClaudeMdSync(files, process.env.PR_BODY ?? '');
  if (errors.length) {
    for (const e of errors) console.error(`::error title=CLAUDE.md 未同步::${e.replace(/\n/g, '%0A')}`);
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log('通過：這張 PR 沒有需要同步 CLAUDE.md 的變更，或已處理。');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
