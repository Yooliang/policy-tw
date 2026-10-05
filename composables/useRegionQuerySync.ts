import { nextTick, onActivated, onDeactivated, onMounted, watch, type Ref } from 'vue'
import { useRoute, useRouter, type LocationQuery, type LocationQueryValue } from 'vue-router'
import { useGlobalState } from './useGlobalState'

/**
 * 全站共用的縣市選擇器狀態 ↔ 網址 query（?region=&sub=&village=…）雙向同步，每個有選擇器的頁都掛一份。
 * - 進頁（mount／KeepAlive 重新啟用）：網址有本頁的參數就以網址為準；沒有就把目前狀態寫回網址
 *   （全站狀態在 A 頁選了彰化走到 B 頁，B 頁網址會補上 ?region=彰化縣；預設值不寫，所以按「全台」後不會冒出來）
 * - 切換：router.replace 更新 query（不推 history，返回鍵不會在縣市間來回）；回預設值就拿掉參數
 * - 只在 routeName 那一頁動網址；不屬於本頁的其他 query（例如 ?filter=）原樣保留
 * - 套用時機在 mounted 之後：預渲染的 HTML 是全國版，先 hydrate 一致再切，避免 hydration mismatch
 *   （選舉頁的縣市與鄉鎮在路徑上，預渲染本身就是該縣市／鄉鎮版；見 regionPath）
 * - 各頁既有的篩選 ref 可用 extra 一起同步（分類、頁籤…），不新增篩選功能
 */
export interface QueryField {
  ref: Ref<string>
  default: string
  /** 合法值白名單；網址帶了不合法的值就退回預設 */
  allowed?: readonly string[]
  /** 只有在這個條件成立時才寫進網址（例如選舉頁的 type 只在政見 PK 頁籤有意義） */
  when?: () => boolean
}

interface QueryFieldOptions<T extends string> {
  allowed?: readonly T[]
  when?: () => boolean
}

/** 把型別較窄的 ref（例如 Ref<'hot' | 'latest'>）包成 QueryField；allowed 沒給時任何字串都收。 */
export function queryField<T extends string>(ref: Ref<T>, defaultValue: T, options: QueryFieldOptions<T> = {}): QueryField {
  return {
    ref: ref as unknown as Ref<string>,
    default: defaultValue,
    allowed: options.allowed as readonly string[] | undefined,
    when: options.when,
  }
}

export interface RegionQuerySyncOptions {
  /** router 裡的 route name，只在這頁作用 */
  routeName: string | string[]
  /**
   * 縣市放在路徑上的頁（選舉頁 /election/:id/:region，2026-09-30）：region 不寫進 query，改寫路徑。
   * get 回傳路徑上的縣市（不合法就回 undefined＝全台）；網址還帶舊的 ?region= 時照樣讀進來，
   * 之後同步網址時會換成路徑的寫法（舊連結自動升級）。
   */
  regionPath?: {
    get: () => string | undefined
    /**
     * 鄉鎮也在路徑上（/election/:id/:region/:sub，2026-10-05）：回傳路徑上的鄉鎮（沒有就 undefined）。
     * 給了這個，sub 就不寫進 query、改寫路徑；網址還帶舊的 ?sub= 時照樣讀進來，之後換成路徑的寫法。
     */
    getSub?: () => string | undefined
    /** sub 只在有 getSub 時傳入（'All' 之外的值） */
    build: (region: string, sub?: string) => string
  }
  /** 鄉鎮市區（依賴 region） */
  sub?: Ref<string>
  /** 村里（依賴 sub） */
  village?: Ref<string>
  /** 本頁其他既有篩選狀態，key 就是 query 參數名 */
  extra?: Record<string, QueryField>
}

const ALL = 'All'

interface ResolvedField extends QueryField {
  key: string
  /** 上層欄位是預設值時，本欄位無意義（沒選縣市就不會有鄉鎮） */
  dependsOn?: string
}

function first(value: LocationQueryValue | LocationQueryValue[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value
  return typeof v === 'string' ? v.trim() : ''
}

function resolveFields(options: RegionQuerySyncOptions, region: Ref<string>): ResolvedField[] {
  const fields: ResolvedField[] = [{ key: 'region', ref: region, default: ALL }]
  if (options.sub) fields.push({ key: 'sub', ref: options.sub, default: ALL, dependsOn: 'region' })
  if (options.village) fields.push({ key: 'village', ref: options.village, default: ALL, dependsOn: options.sub ? 'sub' : 'region' })
  for (const [key, field] of Object.entries(options.extra ?? {})) fields.push({ key, ...field })
  return fields
}

/** 網址 query → 每個欄位的目標值。不合法或上層是預設值的一律退回預設。 */
export function parseRegionQuery(fields: ResolvedField[], query: LocationQuery): Record<string, string> {
  const target: Record<string, string> = {}
  for (const field of fields) {
    const raw = first(query[field.key])
    const parentIsDefault = field.dependsOn ? target[field.dependsOn] === fields.find((f) => f.key === field.dependsOn)?.default : false
    const valid = raw !== '' && !parentIsDefault && (!field.allowed || field.allowed.includes(raw))
    target[field.key] = valid ? raw : field.default
  }
  return target
}

/** 目前狀態 → 網址 query。預設值不寫；不屬於本頁的參數原樣保留。 */
export function buildRegionQuery(fields: ResolvedField[], base: LocationQuery = {}): LocationQuery {
  const ownKeys = new Set(fields.map((f) => f.key))
  const query: LocationQuery = Object.fromEntries(Object.entries(base).filter(([key]) => !ownKeys.has(key)))
  const written: Record<string, boolean> = {}
  for (const field of fields) {
    const value = field.ref.value
    const parentWritten = field.dependsOn ? written[field.dependsOn] === true : true
    const shouldWrite = value !== field.default && parentWritten && (field.when ? field.when() : true)
    written[field.key] = shouldWrite
    if (shouldWrite) query[field.key] = value
  }
  return query
}

function normalize(query: LocationQuery): string {
  return JSON.stringify(Object.entries(query).map(([k, v]) => [k, first(v)]).sort())
}

export function sameQuery(a: LocationQuery, b: LocationQuery): boolean {
  return normalize(a) === normalize(b)
}

function decodePath(path: string): string {
  try { return decodeURIComponent(path) } catch { return path }
}

export function useRegionQuerySync(options: RegionQuerySyncOptions): void {
  const route = useRoute()
  const router = useRouter()
  const { globalRegion } = useGlobalState()
  const fields = resolveFields(options, globalRegion)
  const routeNames = Array.isArray(options.routeName) ? options.routeName : [options.routeName]
  const regionPath = options.regionPath
  let active = false
  let applying = false

  const isOwnRoute = () => routeNames.includes(String(route.name ?? ''))
  /** 鄉鎮也放在路徑上嗎（舊的 ?sub= 要換成路徑） */
  const subOnPath = !!regionPath?.getSub
  /** 路徑上的縣市（與鄉鎮）當成 query 的 region（與 sub）一起解析（路徑上沒有才退回舊的 ?region=、?sub=） */
  const effectiveQuery = (query: LocationQuery): LocationQuery => {
    const fromPath = regionPath?.get()
    if (!fromPath) return query
    const subFromPath = regionPath?.getSub?.()
    return subFromPath ? { ...query, region: fromPath, sub: subFromPath } : { ...query, region: fromPath }
  }
  /** 網址還帶著該搬到路徑上的舊參數 */
  const hasLegacyKeys = (query: LocationQuery) => query.region !== undefined || (subOnPath && query.sub !== undefined)
  const hasOwnKeys = (query: LocationQuery) => !!regionPath?.get() || fields.some((f) => query[f.key] !== undefined)

  // 頁面既有的 watcher 會在上層變動時把下層重設（縣市變 → 鄉鎮／村里回 All），所以一個欄位設完等 watcher 跑完再設下一個
  async function applyQuery(query: LocationQuery): Promise<void> {
    const target = parseRegionQuery(fields, effectiveQuery(query))
    applying = true
    try {
      for (const field of fields) {
        if (field.ref.value === target[field.key]) continue
        field.ref.value = target[field.key]
        await nextTick()
      }
      await nextTick()
    } finally {
      applying = false
    }
  }

  function syncUrl(): void {
    if (!active || applying || !isOwnRoute()) return
    const query = buildRegionQuery(fields, route.query)
    if (!regionPath) {
      if (sameQuery(query, route.query)) return
      void router.replace({ query })
      return
    }
    delete query.region
    let sub: string | undefined
    if (subOnPath) {
      const written = query.sub
      sub = typeof written === 'string' ? written : undefined
      delete query.sub
    }
    const path = regionPath.build(globalRegion.value, sub)
    if (decodePath(path) === decodePath(route.path) && sameQuery(query, route.query)) return
    // 頁內錨點照帶（舊的 ?sub=…#村里長-東門里 換成路徑時，麵包屑要捲到的區塊不能丟）
    void router.replace({ path, query, hash: route.hash })
  }

  /** 套完網址後：縣市在路徑上的頁順手把網址整理成正式寫法（舊的 ?region= → 路徑） */
  async function applyAndNormalize(query: LocationQuery): Promise<void> {
    await applyQuery(query)
    if (regionPath) syncUrl()
  }

  function onEnter(): void {
    active = true
    if (hasOwnKeys(route.query)) void applyAndNormalize(route.query)
    else syncUrl()
  }

  onMounted(onEnter)
  onActivated(onEnter)
  onDeactivated(() => { active = false })

  watch(fields.map((f) => f.ref), syncUrl)

  // 同一頁上換了帶不同參數的連結（例如貼上分享連結、點縣市頁或鄉鎮頁連結）：以網址為準
  watch([() => route.query, () => regionPath?.get(), () => regionPath?.getSub?.()], () => {
    if (!active || applying || !isOwnRoute()) return
    const query = route.query
    if (regionPath) {
      const target = parseRegionQuery(fields, effectiveQuery(query))
      if (fields.some((f) => f.ref.value !== target[f.key]) || hasLegacyKeys(query)) void applyAndNormalize(query)
      return
    }
    if (!sameQuery(buildRegionQuery(fields, query), query)) void applyQuery(query)
  })
}
