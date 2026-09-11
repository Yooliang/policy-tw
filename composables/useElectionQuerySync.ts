import { nextTick, onActivated, onDeactivated, onMounted, watch, type Ref } from 'vue'
import { useRoute, useRouter, type LocationQuery, type LocationQueryValue } from 'vue-router'
import { ElectionType } from '../types'

/**
 * 選舉頁的縣市／鄉鎮／村里／頁籤／PK 層級 ↔ 網址 query 雙向同步，讓人能貼連結直達。
 *   /election/2026?region=彰化縣&sub=彰化市&village=xx&view=comparison&type=縣市議員
 * - 進頁（mount／KeepAlive 重新啟用）：網址有參數就以網址為準；沒有就把保留的狀態寫回網址
 * - 切換：router.replace 更新 query（不推 history，返回鍵不會在縣市間來回）；回全國就拿掉參數
 * - 只在選舉頁動網址；GlobalRegionSelector 的全站狀態在其他頁不受影響
 * - 套用時機在 mounted 之後：預渲染的 HTML 是全國版，先 hydrate 一致再切，避免 hydration mismatch
 */
export type ElectionViewMode = 'politicians' | 'pledges' | 'issues' | 'comparison'

export interface ElectionQueryState {
  region: string
  sub: string
  village: string
  view: ElectionViewMode
  type: ElectionType
}

const ALL = 'All'
const VIEW_MODES: readonly ElectionViewMode[] = ['politicians', 'pledges', 'issues', 'comparison']
const ELECTION_TYPES = Object.values(ElectionType) as string[]
const QUERY_KEYS = ['region', 'sub', 'village', 'view', 'type'] as const
export const DEFAULT_ELECTION_QUERY_STATE: ElectionQueryState = {
  region: ALL,
  sub: ALL,
  village: ALL,
  view: 'politicians',
  type: ElectionType.MAYOR,
}

function first(value: LocationQueryValue | LocationQueryValue[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value
  return typeof v === 'string' ? v.trim() : ''
}

/** 網址 query → 狀態。不合法的值退回預設；沒有縣市就不可能有鄉鎮、沒有鄉鎮就不可能有村里。 */
export function parseElectionQuery(query: LocationQuery): ElectionQueryState {
  const region = first(query.region) || ALL
  const sub = region !== ALL ? (first(query.sub) || ALL) : ALL
  const village = sub !== ALL ? (first(query.village) || ALL) : ALL
  const viewRaw = first(query.view)
  const view = (VIEW_MODES as readonly string[]).includes(viewRaw) ? (viewRaw as ElectionViewMode) : 'politicians'
  const typeRaw = first(query.type)
  const type = ELECTION_TYPES.includes(typeRaw) ? (typeRaw as ElectionType) : ElectionType.MAYOR
  return { region, sub, village, view, type }
}

/** 狀態 → 網址 query。預設值不寫進網址；不屬於本頁的其他參數原樣保留。 */
export function buildElectionQuery(state: ElectionQueryState, base: LocationQuery = {}): LocationQuery {
  const query: LocationQuery = Object.fromEntries(
    Object.entries(base).filter(([key]) => !(QUERY_KEYS as readonly string[]).includes(key)),
  )
  if (state.region !== ALL) {
    query.region = state.region
    if (state.sub !== ALL) {
      query.sub = state.sub
      if (state.village !== ALL) query.village = state.village
    }
  }
  if (state.view !== 'politicians') query.view = state.view
  if (state.view === 'comparison' && state.type !== ElectionType.MAYOR) query.type = state.type
  return query
}

function hasElectionKeys(query: LocationQuery): boolean {
  return QUERY_KEYS.some((key) => query[key] !== undefined)
}

function normalize(query: LocationQuery): string {
  return JSON.stringify(Object.entries(query).map(([k, v]) => [k, first(v)]).sort())
}

export function sameQuery(a: LocationQuery, b: LocationQuery): boolean {
  return normalize(a) === normalize(b)
}

interface ElectionQueryRefs {
  region: Ref<string>
  sub: Ref<string>
  village: Ref<string>
  view: Ref<ElectionViewMode>
  type: Ref<ElectionType>
  /** 讓 GlobalRegionSelector（全站共用狀態）跟著亮起來 */
  setGlobalRegion: (region: string) => void
}

export function useElectionQuerySync(refs: ElectionQueryRefs, routeName = 'election'): void {
  const route = useRoute()
  const router = useRouter()
  let active = false
  let applying = false

  const currentState = (): ElectionQueryState => ({
    region: refs.region.value,
    sub: refs.sub.value,
    village: refs.village.value,
    view: refs.view.value,
    type: refs.type.value,
  })

  // 頁面既有的 watcher 會在縣市變動時把鄉鎮／村里重設為 All，所以要一層一層等 watcher 跑完再設下一層
  async function applyQuery(query: LocationQuery): Promise<void> {
    const target = parseElectionQuery(query)
    applying = true
    try {
      if (refs.region.value !== target.region) {
        refs.setGlobalRegion(target.region)
        refs.region.value = target.region
        await nextTick()
      }
      if (refs.sub.value !== target.sub) {
        refs.sub.value = target.sub
        await nextTick()
      }
      if (refs.village.value !== target.village) refs.village.value = target.village
      refs.view.value = target.view
      refs.type.value = target.type
      await nextTick()
    } finally {
      applying = false
    }
  }

  function syncUrl(): void {
    if (!active || applying || route.name !== routeName) return
    const query = buildElectionQuery(currentState(), route.query)
    if (sameQuery(query, route.query)) return
    void router.replace({ query })
  }

  function onEnter(): void {
    active = true
    if (hasElectionKeys(route.query)) void applyQuery(route.query)
    else syncUrl()
  }

  onMounted(onEnter)
  onActivated(onEnter)
  onDeactivated(() => { active = false })

  watch([refs.region, refs.sub, refs.village, refs.view, refs.type], syncUrl)

  // 同一頁上換了帶不同參數的連結（例如貼上分享連結）：以網址為準
  watch(() => route.query, (query) => {
    if (!active || applying || route.name !== routeName) return
    if (!sameQuery(buildElectionQuery(currentState(), query), query)) void applyQuery(query)
  })
}
