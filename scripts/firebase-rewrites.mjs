// firebase.json 的 hosting.rewrites 比對規則（scripts/serve-dist.mjs 與 lib/election-regions.test.ts 共用）。
// firebase 的 rewrite 可以是 source（glob：`**` 任意段、`*` 單段）或 regex（RE2）；這裡的 regex 規則只用到 JS 也支援的語法。
// 只有找不到靜態檔時才會套 rewrite，第一條符合的勝出。

const DOUBLE_STAR = '__DOUBLE_STAR__'

export function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, DOUBLE_STAR)
    .replace(/\*/g, '[^/]*')
    .replace(new RegExp(DOUBLE_STAR, 'g'), '.*')
  return new RegExp(`^${escaped}$`)
}

export function compileRewrites(rewrites) {
  return (rewrites || []).map((r) => ({ re: r.regex ? new RegExp(r.regex) : globToRegExp(r.source), destination: r.destination }))
}

/** 這個路徑（找不到靜態檔時）會被 rewrite 到哪裡；沒有符合的回 null（Firebase 就回 404.html） */
export function rewriteFor(rules, urlPath) {
  return rules.find((r) => r.re.test(urlPath))?.destination ?? null
}
