/**
 * 部署新版後，使用者開著的舊分頁再點任何路由會載入已不存在的舊 chunk（404）：
 * 「Failed to fetch dynamically imported module」。標準處理＝硬重載到目標路徑（不是 reload 當前頁，
 * 否則使用者會留在原地）；同一路徑 60 秒內只自動重載一次，第二次仍失敗就顯示提示，不無限跳。
 * 這裡不依賴 Vue 是否已掛載（初次載入的 chunk 也可能失敗，那時 app 根本掛不起來），提示用純 DOM。
 */
const RELOAD_KEY_PREFIX = 'policytw.chunk-reload:'
const RELOAD_WINDOW_MS = 60_000
const NOTICE_ID = 'site-updated-notice'

const CHUNK_ERROR_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
  /Unable to preload CSS/i,
]

/** sessionStorage 不可用時的記憶體備援（同一頁只擋一次） */
const attemptedInMemory = new Set<string>()
let reloadInProgress = false

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return CHUNK_ERROR_PATTERNS.some((re) => re.test(message))
}

function alreadyAttempted(key: string): boolean {
  try {
    const last = Number(sessionStorage.getItem(key) || 0)
    return Date.now() - last < RELOAD_WINDOW_MS
  } catch {
    return attemptedInMemory.has(key)
  }
}

function markAttempted(key: string): void {
  attemptedInMemory.add(key)
  try {
    sessionStorage.setItem(key, String(Date.now()))
  } catch {
    // 私密視窗／被擋：靠記憶體旗標
  }
}

function clearAttempt(key: string): void {
  attemptedInMemory.delete(key)
  try {
    sessionStorage.removeItem(key)
  } catch {
    // ignore
  }
}

/**
 * 遇到 chunk 載入失敗時呼叫：能自動重載就重載並回 true；60 秒內同路徑已試過就顯示提示並回 false。
 */
export function handleChunkLoadError(targetPath: string): boolean {
  if (typeof window === 'undefined') return false
  if (reloadInProgress) return true
  const key = RELOAD_KEY_PREFIX + targetPath
  if (alreadyAttempted(key)) {
    showSiteUpdatedNotice(targetPath)
    return false
  }
  markAttempted(key)
  reloadInProgress = true
  window.location.assign(targetPath)
  return true
}

/** 「網站剛更新，請重新整理頁面」提示；按鈕會清掉限制再重載到目標路徑。 */
export function showSiteUpdatedNotice(targetPath: string): void {
  if (typeof document === 'undefined' || document.getElementById(NOTICE_ID)) return
  const box = document.createElement('div')
  box.id = NOTICE_ID
  box.setAttribute('role', 'alert')
  box.style.cssText = [
    'position:fixed', 'left:50%', 'top:80px' /* 避開 sticky 導覽列（h-16） */, 'transform:translateX(-50%)', 'z-index:9999',
    'max-width:calc(100vw - 32px)', 'display:flex', 'flex-wrap:wrap', 'align-items:center', 'gap:12px',
    'padding:12px 16px', 'border-radius:14px', 'background:#0f172a', 'color:#fff',
    'font:600 14px/1.5 "Noto Sans TC",sans-serif', 'box-shadow:0 10px 30px rgba(15,23,42,.35)',
  ].join(';')
  const text = document.createElement('span')
  text.textContent = '網站剛更新，請重新整理頁面'
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = '重新整理'
  button.style.cssText = 'padding:6px 14px;border-radius:10px;border:0;background:#fbbf24;color:#0f172a;font-weight:800;cursor:pointer'
  button.addEventListener('click', () => {
    clearAttempt(RELOAD_KEY_PREFIX + targetPath)
    window.location.assign(targetPath)
  })
  box.append(text, button)
  document.body.appendChild(box)
}

/** 目前正在前往的路徑（router.beforeEach 記錄），vite:preloadError 沒有 to 可用時靠這個。 */
let pendingPath: string | null = null
export function setPendingPath(path: string | null): void {
  pendingPath = path
}
export function currentTargetPath(): string {
  return pendingPath ?? `${window.location.pathname}${window.location.search}`
}

/** 瀏覽器端一次性掛上：Vite 預載失敗事件＋沒人接的 chunk 錯誤 rejection（避免 console 留下未捕捉錯誤）。 */
export function installChunkReloadListeners(): void {
  if (typeof window === 'undefined') return
  // 不 preventDefault：Vite 會把錯誤照常丟進 import 鏈，router.onError 才拿得到原始錯誤與目標路徑；
  // 若 preventDefault，Vite 會讓 import 靜默回 undefined，vue-router 改丟「Couldn't resolve component」而接不到
  window.addEventListener('vite:preloadError', () => {
    handleChunkLoadError(currentTargetPath())
  })
  window.addEventListener('unhandledrejection', (event) => {
    if (!isChunkLoadError(event.reason)) return
    event.preventDefault()
    handleChunkLoadError(currentTargetPath())
  })
}
