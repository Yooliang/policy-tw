<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { X } from 'lucide-vue-next'
import { useSupabase } from '../composables/useSupabase'
import { useDeskNav, type DeskGroup, type DeskItem } from '../composables/useDeskNav'
import { sectionOfRoute, type DeskSection } from '../lib/desk-sections'
import { footerElections, taipeiDay } from '../lib/election-list'
import { electionPath } from '../lib/election-regions'
import { electionSegment, electionYearOfDate } from '../lib/election-route'

/**
 * 桌面版延伸欄（約 260px）：頂部是該區標題，下面是子項目。
 * - 選舉區在選舉頁：內容類型（候選人｜承諾｜PK ‖ 串聯｜矩陣）、層級、地區（縣市→鄉鎮→村里／選區）三組直式清單，
 *   由選舉頁登記進 useDeskNav 的模型驅動（點了就是呼叫選舉頁自己的函式，跟手機版共用同一組狀態與網址）。
 * - 其他區：該區既有子頁（照原本頂部導覽與頁尾的歸類）。沒有子項的區塊（首頁、搜尋）整欄收起，由 App.vue 判斷。
 * 預渲染與第一次 hydrate 時選舉區一律畫「一般子項」（真連結），掛載後才換成選舉頁的篩選模型，兩邊 HTML 才一致。
 */
defineProps<{ drawer?: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const route = useRoute()
const { elections, getActiveElection, categories } = useSupabase()
const { electionNav } = useDeskNav()
const mounted = ref(false)
onMounted(() => { mounted.value = true })

const section = computed<DeskSection | null>(() => sectionOfRoute(route.name))
const model = computed(() => (mounted.value && electionNav.value ? electionNav.value.value : null))

const link = (key: string, label: string, to: string): DeskItem => ({ key, label, to, active: false })
const POLICY: DeskGroup[] = [
  { key: 'policy', title: '政見', blocks: [[link('list', '全部政見', '/tracking'), link('relay', '政策脈絡', '/analysis'), link('mine', '我的關注', '/tracking?view=mine'), link('regional', '縣市數據分佈', '/regional-data')]] },
]
// 參與區三組（2026-10-31 小良哥）：看板／工作那幾項就是貢獻看板列（components/contributions/BoardNav.vue）的分頁；
// 「貢獻統計」就是 /stats（BoardNav 的「統計」），所以看板組不再重複放「統計」。
const JOIN: DeskGroup[] = [
  { key: 'join', title: '參與', blocks: [[link('stats', '貢獻統計', '/stats'), link('skill', '參與協議', '/skill'), link('community', '公民提問', '/community')]] },
  { key: 'board', title: '看板', blocks: [[link('contributions', 'AI 協作動態牆', '/contributions'), link('map', '參選地圖', '/stats/map'), link('ai', 'AI 表現統計', '/ai')]] },
  { key: 'work', title: '工作', blocks: [[link('tasks', '任務清單', '/tasks'), link('queue', '派工隊列', '/queue'), link('dispatch', '任務排派日程', '/dispatch')]] },
]
const ABOUT: DeskGroup[] = [
  { key: 'about', title: '關於', blocks: [[link('vision', '關於正見', '/vision'), link('contact', '聯絡我們', '/contact'), link('terms', '使用條款', '/terms'), link('privacy', '隱私權政策', '/privacy'), link('donation', '贊助支持', '/donation')]] },
]

const activeElection = computed(() => getActiveElection())
const electionList = computed(() => footerElections(elections.value, taipeiDay(Date.now())))
/** 選舉區的一般子項（不在選舉頁、或還沒掛載時）：內容類型連結＋選舉清單＋一覽 */
const genericElection = computed<DeskGroup[]>(() => {
  const e = activeElection.value
  const base = e ? electionPath(electionSegment(e)) : '/elections'
  const groups: DeskGroup[] = []
  if (e) {
    const v = (key: string, label: string, q: string): DeskItem => link(key, label, q ? `${base}?view=${q}` : base)
    groups.push({
      key: 'views', title: '內容類型',
      blocks: [[v('politicians', '候選人', ''), v('pledges', '承諾', 'pledges'), v('comparison', 'PK', 'comparison')], [v('issues', '串聯', 'issues'), link('matrix', '矩陣', `${base}/matrix`)]],
    })
  }
  groups.push({ key: 'elections', title: '選舉', blocks: [electionList.value.map(x => link(`e${x.id}`, x.shortName, electionPath(electionSegment(x))))] })
  return groups
})
const moreElection: DeskGroup = { key: 'more', title: '一覽', blocks: [[link('elections', '選舉一覽', '/elections'), link('politicians', '人物一覽', '/politicians'), link('parties', '政黨一覽', '/parties')]] }
/** 人物一覽、政黨一覽只在建置時產生內容：用一般連結整頁載入預渲染那一份（lib/full-load.ts） */
const FULL_LOAD = new Set(['/politicians', '/parties'])
const policyCategories = computed<DeskGroup[]>(() => categories.value.length === 0 ? [] : [{ key: 'cat', title: '政見分類', scroll: true, blocks: [categories.value.map(c => link(`c${c}`, c, `/tracking?category=${encodeURIComponent(c)}`))] }])

/** 選舉一覽／人物一覽／政黨一覽這幾頁（以及搜尋頁）的延伸欄只放同一組「一覽」（moreElection），不放選舉頁的內容類型與選舉清單 */
const OVERVIEW_ROUTES = new Set(['elections', 'politicians', 'politicians-group', 'parties', 'party'])
const overviewOnly = computed(() => OVERVIEW_ROUTES.has(String(route.name)))

const title = computed(() => {
  if (overviewOnly.value) return '選舉'
  if (section.value === 'election') {
    if (model.value) return model.value.title
    const e = activeElection.value
    const y = e ? electionYearOfDate(e.electionDate) : null
    return y ? `${y} 選舉` : '選舉'
  }
  return ({ policy: '政見', join: '參與', about: '關於', home: '關於', search: '搜尋' } as Record<string, string>)[section.value ?? ''] ?? '正見'
})
const groups = computed<DeskGroup[]>(() => {
  switch (section.value) {
    case 'policy': return [...POLICY, ...policyCategories.value]
    case 'join': return JOIN
    case 'home':
    case 'about': return ABOUT
    case 'search': return [moreElection]
    case 'election': if (overviewOnly.value) return [moreElection]; return model.value ? model.value.groups : [...genericElection.value, moreElection] // 選舉頁的延伸欄只留內容類型／層級／縣市三組
    default: return []
  }
})

function isOn(item: DeskItem): boolean {
  if (!item.to) return item.active
  const [path, qs] = item.to.split('?')
  // 一覽組：人物／政黨的子頁（/politicians/xxx、/parties/xxx）也高亮對應那項
  if (['/politicians', '/parties'].includes(path)) { if (!(route.path === path || route.path.startsWith(path + '/'))) return false } else if (route.path !== path) return false
  const want = new URLSearchParams(qs ?? '')
  if (path === '/tracking') return want.has('view') ? route.query.view === want.get('view') : want.has('category') ? route.query.category === want.get('category') : !route.query.view && !route.query.category
  if (want.has('view')) return route.query.view === want.get('view')
  if (path.startsWith('/election/') && !path.endsWith('/matrix')) return !route.query.view
  return true
}
function onPick(item: DeskItem, e: Event) {
  if (item.select) { e.preventDefault(); item.select() }
}

// 選中的項目捲到清單可見處（只動清單自己的捲動，不動頁面）
const rootEl = ref<HTMLElement | null>(null)
watch([groups, () => route.fullPath], () => {
  void nextTick(() => {
    rootEl.value?.querySelectorAll<HTMLElement>('[data-scroll-list]').forEach(box => {
      const el = box.querySelector<HTMLElement>('[data-active="true"]')
      if (!el) return
      const top = el.offsetTop - box.offsetTop
      if (top < box.scrollTop || top + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top - (box.clientHeight - el.offsetHeight) / 2
    })
  })
}, { flush: 'post' })

const itemClass = (on: boolean) => ['block w-full rounded-lg px-3 py-1.5 text-left text-sm font-bold transition-colors', on ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100 hover:text-navy-900']
</script>

<template>
  <aside ref="rootEl" class="flex h-full w-[176px] flex-col border-r border-slate-200 bg-white" :aria-label="`${title}選單`" data-testid="desk-ext">
    <div class="flex h-14 shrink-0 items-center justify-between border-b border-slate-100 px-4">
      <h2 class="truncate text-lg font-black text-navy-900" data-testid="desk-ext-title">{{ title }}</h2>
      <button v-if="drawer" type="button" class="flex h-8 w-8 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100" aria-label="關閉選單" @click="emit('close')"><X :size="18" /></button>
    </div>
    <div class="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-3 py-4">
      <section v-for="g in groups" :key="g.key" :data-testid="`desk-group-${g.key}`">
        <h3 class="mb-1.5 px-3 text-xs font-bold text-slate-400">{{ g.title }}</h3>
        <div :class="g.scroll ? 'max-h-60 overflow-y-auto overscroll-contain' : ''" :data-scroll-list="g.scroll ? '' : undefined">
          <template v-for="(block, bi) in g.blocks" :key="bi">
            <hr v-if="bi > 0" class="my-1.5 border-slate-200" data-testid="desk-group-divider" />
            <ul class="space-y-0.5">
              <li v-for="item in block" :key="item.key">
                <a v-if="item.to && FULL_LOAD.has(item.to)" :href="item.to" :class="itemClass(isOn(item))" :data-active="isOn(item) ? 'true' : 'false'" :aria-current="isOn(item) ? 'page' : undefined">{{ item.label }}</a>
                <RouterLink v-else-if="item.to" :to="item.to" :class="itemClass(isOn(item))" :data-active="isOn(item) ? 'true' : 'false'" :aria-current="isOn(item) ? 'page' : undefined">{{ item.label }}</RouterLink>
                <button v-else type="button" :class="itemClass(item.active)" :data-active="item.active ? 'true' : 'false'" :aria-pressed="item.active" @click="onPick(item, $event)">{{ item.label }}</button>
              </li>
            </ul>
          </template>
        </div>
      </section>
    </div>
  </aside>
</template>
