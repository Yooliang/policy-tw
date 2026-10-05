import { ref, readonly } from 'vue'

/**
 * 字級與明暗（2026-10-05，issue #350）。
 *
 * - 選擇存在 localStorage（`zj-theme`、`zj-font`），讀寫都包 try/catch：隱私模式、禁用儲存時不會炸。
 * - 明暗預設「跟隨系統」；字級預設「標準」。
 * - 預渲染的 HTML 沒有這些資訊，所以真正套用到 <html> 的動作有兩處：
 *   index.html 的 inline script（首次繪製前，避免閃白），以及這裡（互動後）。兩處的 key 與 class 名要一致。
 * - 只在瀏覽器執行：SSR 時 init 不做事，狀態維持預設。
 */

export type ThemeChoice = 'system' | 'light' | 'dark'
export type FontChoice = 'sm' | 'md' | 'lg'

export const THEME_KEY = 'zj-theme'
export const FONT_KEY = 'zj-font'

export const THEME_OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: '跟隨系統' },
  { value: 'light', label: '淺色' },
  { value: 'dark', label: '深色' },
]

export const FONT_OPTIONS: { value: FontChoice; label: string }[] = [
  { value: 'sm', label: '小' },
  { value: 'md', label: '中' },
  { value: 'lg', label: '大' },
]

const theme = ref<ThemeChoice>('system')
const font = ref<FontChoice>('md')
let initialized = false

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStore(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 儲存被擋也無妨，這次瀏覽仍然有效 */
  }
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

function apply() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const dark = theme.value === 'dark' || (theme.value === 'system' && systemPrefersDark())
  root.classList.toggle('dark', dark)
  root.classList.remove('zj-font-sm', 'zj-font-md', 'zj-font-lg')
  root.classList.add(`zj-font-${font.value}`)
}

/** 在瀏覽器掛載後呼叫一次：讀回選擇、套用、並在「跟隨系統」時監聽系統切換。 */
export function initAppearance() {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  const t = readStore(THEME_KEY)
  if (t === 'system' || t === 'light' || t === 'dark') theme.value = t
  const f = readStore(FONT_KEY)
  if (f === 'sm' || f === 'md' || f === 'lg') font.value = f
  apply()
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (theme.value === 'system') apply()
    })
  } catch {
    /* 舊瀏覽器沒有 addEventListener：就不即時跟隨，重新整理後仍會套用 */
  }
}

export function useAppearance() {
  function setTheme(value: ThemeChoice) {
    theme.value = value
    writeStore(THEME_KEY, value)
    apply()
  }
  function setFont(value: FontChoice) {
    font.value = value
    writeStore(FONT_KEY, value)
    apply()
  }
  return { theme: readonly(theme), font: readonly(font), setTheme, setFont }
}
