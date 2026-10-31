/**
 * 手機版政見／參與／搜尋三區的頁籤條（2026-10-31）：頁首下方一排可左右滑動的頁籤，
 * 切換＝導航到對應路由。只在「頁籤本身的那幾個路由」顯示；詳情頁（單一政見、單一人物…）不顯示。
 * 純函式，不依賴 Vue。
 */
export interface SectionTab { key: string; label: string; to: string }

export const MOBILE_SECTION_TABS: SectionTab[][] = [
  // 政見
  [
    { key: 'tracking', label: '全部政見', to: '/tracking' },
    { key: 'analysis', label: '政策脈絡', to: '/analysis' },
    { key: 'mine', label: '我的關注', to: '/tracking?view=mine' },
  ],
  // 參與
  [
    { key: 'stats', label: '貢獻統計', to: '/stats' },
    { key: 'skill', label: '參與協議', to: '/skill' },
    { key: 'community', label: '公民提問', to: '/community' },
  ],
  // 搜尋
  [
    { key: 'search', label: '搜尋', to: '/search' },
    { key: 'elections', label: '選舉一覽', to: '/elections' },
    { key: 'politicians', label: '人物一覽', to: '/politicians' },
    { key: 'parties', label: '政黨一覽', to: '/parties' },
  ],
]

/** 目前路由落在哪一組、哪一個頁籤；不在任何頁籤上回 null */
export function sectionTabsFor(path: string, query: Record<string, unknown>): { tabs: SectionTab[]; active: string } | null {
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path
  let key: string | null = null
  if (p === '/tracking') key = query.view === 'mine' ? 'mine' : 'tracking'
  else if (['/analysis', '/stats', '/skill', '/community', '/search', '/elections', '/politicians', '/parties'].includes(p)) key = p.slice(1)
  if (!key) return null
  const tabs = MOBILE_SECTION_TABS.find(g => g.some(t => t.key === key))
  return tabs ? { tabs, active: key } : null
}
