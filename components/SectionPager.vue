<script setup lang="ts">
import { computed, markRaw, nextTick, onActivated, onBeforeUnmount, onMounted, reactive, ref, shallowReactive, watch, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SectionPane from './SectionPane.vue'
import { pagerPendingKey } from '../composables/usePane'
import { isMobileViewport } from '../composables/useMobileShell'
import { sectionTabsFor, type SectionTab } from '../lib/mobile-section-tabs'

/**
 * 手機版政見／參與／搜尋三區的水平分頁容器（2026-11-01，小良哥：「多個 div」）。
 * 每個頁籤一個 pane：目前頁＋左右相鄰頁都掛載在畫面上（相鄰頁平時 display:none，拖曳時由 styles/main.css 擺到左右一個螢幕寬的位置），
 * 手指拉到一半就看得到隔壁那頁的真實內容；放手過半才改網址（App.vue 的 useSwipeTabs），未過半彈回。
 * - 網址仍隨頁籤變：目前頁由路由決定（可分享、上一頁、直接開某個頁籤網址）。
 * - 預渲染／hydrate：只畫目前頁（伺服端與客戶端第一次渲染一致）；相鄰頁掛載後才出現，掛過的 pane 一直保留。
 * - 每個 pane 自己的捲動位置：切走時記下、切回時還原（共用視窗捲動，頁首收合跟著目前 pane）。
 * - 桌面：只顯示目前頁，不預掛相鄰頁（看過的才保留）。
 */
const props = defineProps<{ tabs: SectionTab[] }>()
const route = useRoute()
const router = useRouter()

const liveKey = computed(() => {
  const s = sectionTabsFor(route.path, route.query)
  return s && s.tabs === props.tabs ? s.active : null
})
// 路由不在這一區時（容器被 KeepAlive 收著）記住最後看的是哪一頁
const lastKey = ref(liveKey.value ?? props.tabs[0]!.key)
watch(liveKey, (k) => { if (k) lastKey.value = k })
const shownKey = computed(() => {
  const p = pagerPendingKey.value
  if (p && props.tabs.some(t => t.key === p)) return p
  return liveKey.value ?? lastKey.value
})
const shownIndex = computed(() => Math.max(0, props.tabs.findIndex(t => t.key === shownKey.value)))

// 元件：目前頁用路由已載好的元件（同步，預渲染也要有）；其餘用惰性載入
const comps = shallowReactive<Record<string, Component>>({})
const statics = new Map<string, ReturnType<typeof router.resolve>>()
function recordOf(t: SectionTab) {
  let r = statics.get(t.key)
  if (!r) { r = router.resolve(t.to); statics.set(t.key, r) }
  return r
}
const isLoaded = (c: unknown): c is Component => !!c && !(typeof c === 'function' && !(c as { __vccOpts?: unknown }).__vccOpts)
function syncComp(t: SectionTab): Component | undefined {
  if (comps[t.key]) return comps[t.key]
  const c = recordOf(t).matched.at(-1)?.components?.default
  if (isLoaded(c)) { comps[t.key] = markRaw(c); return comps[t.key] }
  return undefined
}
async function loadComp(t: SectionTab): Promise<void> {
  if (syncComp(t)) return
  const c = recordOf(t).matched.at(-1)?.components?.default
  if (typeof c !== 'function') return
  try {
    const m = await (c as () => Promise<{ default?: Component } | Component>)()
    comps[t.key] = markRaw(((m as { default?: Component }).default ?? m) as Component)
  } catch { /* 載入失敗（舊 chunk）由路由導覽的錯誤處理接手 */ }
}

// 掛載過的 pane（看過、或已預掛的相鄰頁）一直保留
const mounted = reactive(new Set<string>())
watch(shownKey, (k) => { mounted.add(k) }, { immediate: true })
function mountNeighbors(index: number) {
  if (!isMobileViewport()) return
  for (const off of [1, -1]) {
    const t = props.tabs[index + off]
    if (!t || mounted.has(t.key)) continue
    const run = () => { void loadComp(t).then(() => { mounted.add(t.key) }) }
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1500 })
    else setTimeout(run, 200)
  }
}
onMounted(() => mountNeighbors(shownIndex.value))
watch(shownIndex, (i) => { if (typeof window !== 'undefined') mountNeighbors(i) })

const paneActive = (t: SectionTab) => liveKey.value === t.key
const offsetOf = (i: number) => i - shownIndex.value

// ── 每個 pane 的捲動位置 ──
const scrolls = new Map<string, number>()
let restoring = false
function onScroll() { if (!restoring && liveKey.value === shownKey.value) scrolls.set(shownKey.value, window.scrollY) }
watch(shownKey, async (now, prev) => {
  if (prev === undefined || typeof window === 'undefined') return
  restoring = true
  await nextTick()
  window.scrollTo(0, scrolls.get(now) ?? 0)
  requestAnimationFrame(() => { restoring = false })
}, { flush: 'pre' })
onActivated(async () => {
  restoring = true
  await nextTick()
  window.scrollTo(0, scrolls.get(shownKey.value) ?? 0)
  requestAnimationFrame(() => { restoring = false })
})

// ── 拖曳開始：相鄰 pane 對齊目前畫面、顯示它自己的捲動位置，沒掛的立刻掛 ──
const root = ref<HTMLElement | null>(null)
function onSwipeBegin() {
  const el = root.value
  if (!el || liveKey.value === null) return
  const rootTop = el.getBoundingClientRect().top + window.scrollY
  const cur = window.scrollY
  const h = window.innerHeight
  props.tabs.forEach((t, i) => {
    const off = offsetOf(i)
    if (Math.abs(off) !== 1) return
    if (!mounted.has(t.key)) { void loadComp(t).then(() => { mounted.add(t.key) }) }
    const pane = el.querySelector<HTMLElement>(`[data-pane="${t.key}"]`)
    if (!pane) return
    pane.style.setProperty('--pane-top', `${cur - rootTop}px`)
    pane.style.setProperty('--pane-h', `${h}px`)
    pane.style.setProperty('--pane-ty', `${rootTop - (scrolls.get(t.key) ?? 0)}px`)
  })
}
onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('swipetabs:begin', onSwipeBegin)
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('swipetabs:begin', onSwipeBegin)
})
// 目前頁的元件要在渲染時就有（沒有就先載）
for (const t of props.tabs) if (t.key === shownKey.value) { syncComp(t); void loadComp(t) }
watch(shownKey, (k) => { const t = props.tabs.find(x => x.key === k); if (t) void loadComp(t) })
</script>

<template>
  <div ref="root" class="section-pager relative" data-testid="section-pager">
    <div
      v-for="(t, i) in tabs"
      v-show="t.key === shownKey"
      :key="t.key"
      class="section-pane"
      :data-pane="t.key"
      :data-pane-offset="offsetOf(i)"
    >
      <div class="section-pane-inner">
        <SectionPane v-if="mounted.has(t.key) && syncComp(t)" :comp="syncComp(t)!" :active="paneActive(t)" :static-route="recordOf(t)" />
      </div>
    </div>
  </div>
</template>
