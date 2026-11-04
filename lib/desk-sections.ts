/**
 * 桌面版（md 以上）左欄的區塊歸屬：每個路由名稱屬於哪一區，最左窄欄用它決定「目前所在」、延伸欄用它決定顯示哪一區的子項目。
 * 五個主區塊沿用手機底部分頁列（首頁／政見／選舉／參與／搜尋）；關於、隱私等頁尾連結歸「關於」，放在窄欄最下面。
 */
export type DeskSection = 'home' | 'policy' | 'election' | 'join' | 'search' | 'about'

const BY_ROUTE: Record<string, DeskSection> = {
  home: 'home',
  tracking: 'policy', policy: 'policy', analysis: 'policy', 'analysis-detail': 'policy', lineage: 'policy', 'regional-data': 'policy',
  elections: 'search', election: 'election', 'election-region': 'election', 'election-township': 'election', 'election-matrix': 'election',
  politician: 'election', politicians: 'search', 'politicians-group': 'search', parties: 'search', 'party-flow': 'search', party: 'election',
  stats: 'join', 'stats-map': 'join', skill: 'join', contributions: 'join', queue: 'join', tasks: 'join', community: 'join', discussion: 'join', sources: 'join', dispatch: 'join', ai: 'join',
  search: 'search',
  vision: 'about', contact: 'about', terms: 'about', privacy: 'about', donation: 'about',
}

export function sectionOfRoute(name: unknown): DeskSection | null {
  return typeof name === 'string' ? BY_ROUTE[name] ?? null : null
}

/**
 * 政見詳情頁（路由 policy）的歸屬看資料不看網址：還在「承諾」階段（選前、落選／退選、結果待補）而且屬於某一屆選舉的條目，
 * 主選單亮「選舉」、延伸欄顯示那一屆的選舉選單；當選後的「政見」與任內施政維持「政見」區。
 * 網址不變（/policy/:id），這裡只決定左側選單怎麼亮。
 * @param stage 該條的階段（lib/policy-stage.ts 的 PolicyStage）
 * @param electionId 該條所屬選舉；沒標屆別＝不屬於任何一屆
 */
export function sectionOfPolicy(stage: string | null | undefined, electionId: number | null | undefined): DeskSection {
  return stage && stage !== 'policy' && typeof electionId === 'number' ? 'election' : 'policy'
}

/**
 * 延伸欄「一覽」組的高亮：人物／政黨的子頁（/politicians/xxx、/parties/xxx）也亮對應那項；
 * 但 /parties/flow（政黨分流圖）自己是一項，不算政黨一覽的子頁。
 */
export function overviewItemOn(itemPath: string, routePath: string): boolean {
  if (itemPath === '/parties' && (routePath === '/parties/flow' || routePath.startsWith('/parties/flow/'))) return false
  return routePath === itemPath || routePath.startsWith(itemPath + '/')
}
