/**
 * 誰在讀正見：依 User-Agent 與 Referer 分類（2026-09-23 小良哥：AI 時代要看「被 AI 讀了幾次」，不只看瀏覽數）。
 * 純函式，Worker 與測試共用。回 null＝一般瀏覽器或不認得的，不記。
 *
 * kind：
 *   ai_user        使用者問 AI 時，AI 當場來讀（會附來源連結、會帶人回來）
 *   ai_search      AI 搜尋服務建索引
 *   ai_training    大量抓資料訓練模型
 *   search_engine  傳統搜尋引擎（對照組）
 *   ai_referral    人從 AI 服務的回答點連結過來
 *
 * 注意：被 Cloudflare 在邊緣直接擋掉的請求進不到 Worker，這裡數不到。
 */

// 順序有意義：先比對較長、較特定的名字（Claude-SearchBot 要在 ClaudeBot 前面）
export const AI_AGENTS = [
  ['ChatGPT-User', 'ai_user'],
  ['Claude-User', 'ai_user'],
  ['Perplexity-User', 'ai_user'],
  ['MistralAI-User', 'ai_user'],
  ['Google-Agent', 'ai_user'],
  ['meta-externalfetcher', 'ai_user'],
  ['DuckAssistBot', 'ai_user'],
  ['OAI-SearchBot', 'ai_search'],
  ['Claude-SearchBot', 'ai_search'],
  ['PerplexityBot', 'ai_search'],
  ['GPTBot', 'ai_training'],
  ['ClaudeBot', 'ai_training'],
  ['anthropic-ai', 'ai_training'],
  ['CCBot', 'ai_training'],
  ['Bytespider', 'ai_training'],
  ['Amazonbot', 'ai_training'],
  ['meta-externalagent', 'ai_training'],
  ['cohere-ai', 'ai_training'],
  ['Applebot', 'search_engine'],
  ['Googlebot', 'search_engine'],
  ['bingbot', 'search_engine'],
]

export const AI_REFERRERS = [
  'chatgpt.com', 'chat.openai.com', 'perplexity.ai', 'claude.ai', 'gemini.google.com',
  'copilot.microsoft.com', 'chat.deepseek.com', 'grok.com', 'you.com', 'poe.com',
]

export const AI_READ_KINDS = ['ai_user', 'ai_search', 'ai_training', 'search_engine', 'ai_referral']

/** 路徑歸類：只記「讀的是哪一種頁」，不記個別網址 */
export function pathTypeOf(pathname) {
  if (/^\/politician\/[^/]+\/?$/.test(pathname)) return 'politician'
  if (/^\/policy\/[^/]+\/?$/.test(pathname)) return 'policy'
  if (/^\/election\//.test(pathname)) return 'election'
  if (pathname === '/skill.md') return 'skill'
  if (pathname === '/llms.txt') return 'llms'
  if (/^\/sitemap[-a-z]*\.xml$/.test(pathname)) return 'sitemap'
  if (/^\/(assets|images|brand|party)\//.test(pathname) || /\.(js|css|png|jpe?g|webp|svg|ico|woff2?)$/.test(pathname)) return null // 靜態資源不算「讀」
  return 'other'
}

/**
 * @param {string} userAgent
 * @param {string} referer
 * @param {string} pathname
 * @returns {{ agent: string, kind: string, path_type: string } | null}
 */
export function classifyRead(userAgent, referer, pathname) {
  const pathType = pathTypeOf(pathname)
  if (!pathType) return null
  const ua = (userAgent || '').toLowerCase()
  for (const [name, kind] of AI_AGENTS) {
    if (ua.includes(name.toLowerCase())) return { agent: name, kind, path_type: pathType }
  }
  if (referer) {
    let host = ''
    try { host = new URL(referer).hostname.replace(/^www\./, '').toLowerCase() } catch { host = '' }
    const hit = AI_REFERRERS.find((h) => host === h || host.endsWith(`.${h}`))
    if (hit) return { agent: hit, kind: 'ai_referral', path_type: pathType }
  }
  return null
}
