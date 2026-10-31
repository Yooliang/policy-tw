import { ref } from 'vue'

/**
 * 手機版頁首正中間要顯示什麼（X 式：每頁不同）。頁面把自己的內容放進來，頁首（Navbar）讀。
 * - crumbs：選舉頁的定位麵包屑（全台 › 新竹縣 › 湖口鄉 › 中興村），go 是點那一段的動作（退到那一層）
 * - person：候選人頁的姓名＋小字職位
 * 頁面離開（deactivated／unmounted）要清掉，頁首只在對應的路由上採用，不會殘留。
 */
export interface HeaderCrumb { label: string; go: () => void }
const crumbs = ref<HeaderCrumb[] | null>(null)
const person = ref<{ name: string; sub?: string } | null>(null)
/** 桌面細頁首麵包屑（候選人頁、政見詳情頁）：頁面把自己算好的路徑放進來（選舉名稱 › 地區 › 人物…），to 是可點的連結 */
export interface PageCrumb { label: string; to?: string }
const pageCrumbs = ref<PageCrumb[] | null>(null)
/** 手機版人物頁頁首麵包屑（2026 › 台南市 › 新營區 › 三仙里 › 范二任）：放不下時 compact 版——有 short 的換短名、skip 的（鄉鎮）省成「…」，屆別與人名永遠完整 */
export interface PersonCrumb { label: string; to?: string; short?: string; skip?: boolean }
const personCrumbs = ref<PersonCrumb[] | null>(null)

export function useMobileHeader() {
  return {
    crumbs,
    person,
    pageCrumbs,
    personCrumbs,
    setPersonCrumbs: (v: PersonCrumb[] | null) => { personCrumbs.value = v },
    setPageCrumbs: (v: PageCrumb[] | null) => { pageCrumbs.value = v },
    setCrumbs: (v: HeaderCrumb[] | null) => { crumbs.value = v },
    setPerson: (v: { name: string; sub?: string } | null) => { person.value = v },
  }
}
