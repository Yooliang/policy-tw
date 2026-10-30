/**
 * 桌面版（md 以上）左欄的區塊歸屬：每個路由名稱屬於哪一區，最左窄欄用它決定「目前所在」、延伸欄用它決定顯示哪一區的子項目。
 * 五個主區塊沿用手機底部分頁列（首頁／政見／選舉／參與／搜尋）；關於、隱私等頁尾連結歸「關於」，放在窄欄最下面。
 */
export type DeskSection = 'home' | 'policy' | 'election' | 'join' | 'search' | 'about'

const BY_ROUTE: Record<string, DeskSection> = {
  home: 'home',
  tracking: 'policy', policy: 'policy', analysis: 'policy', 'analysis-detail': 'policy', lineage: 'policy', 'regional-data': 'policy',
  elections: 'election', election: 'election', 'election-region': 'election', 'election-township': 'election', 'election-matrix': 'election',
  politician: 'election', politicians: 'election', 'politicians-group': 'election', parties: 'election', party: 'election',
  stats: 'join', 'stats-map': 'join', skill: 'join', contributions: 'join', queue: 'join', tasks: 'join', community: 'join', discussion: 'join', sources: 'join', dispatch: 'join', ai: 'join',
  search: 'search',
  vision: 'about', contact: 'about', terms: 'about', privacy: 'about', donation: 'about',
}

export function sectionOfRoute(name: unknown): DeskSection | null {
  return typeof name === 'string' ? BY_ROUTE[name] ?? null : null
}
