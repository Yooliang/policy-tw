<script setup lang="ts">
// 重播派工流動（/trace）：用流程圖重播派工系統的真實事件。
//   不指定對象：近 4 小時全站事件壓縮重播（預設 60 倍，4 小時約 4 分鐘），可拖時間軸、暫停、調倍速
//   指定對象：貼任務編號、交件編號、人物編號或人名，照真實時間順序一件一件走，旁邊列時間軸
// 資料來自 trace_events()（匿名可執行、只回事件摘要與代理顯示名）；客戶端渲染、noindex、不進網站地圖，做法同 /queue。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Waypoints, Search, ListOrdered } from 'lucide-vue-next'
import Hero from '../components/Hero.vue'
import LoadError from '../components/LoadError.vue'
import { usePageHead } from '../composables/usePageHead'
import { fetchNames, fetchScoped, fetchWindow, probeUuid, searchPeople, type PersonHit, type Scope, type TraceResult } from '../lib/trace-api'
import {
  COUNT_LABEL, nodeCounts, parseTarget, personFromTaskId, taipeiFull, taskTypeOfId, toItems, topActive,
  type Active, type NodeId, type TraceItem,
} from '../lib/trace'
import { taskTypeLabel } from '../lib/task-labels'
import TraceCanvas from './trace/TraceCanvas.vue'
import TraceControls from './trace/TraceControls.vue'
import TraceTimeline from './trace/TraceTimeline.vue'
import TraceTop from './trace/TraceTop.vue'

usePageHead({ title: '重播派工流動', description: '用流程圖重播派工系統的真實事件', noindex: true })

const route = useRoute()
const router = useRouter()

const WINDOW_SPEEDS = [30, 60, 120, 240]
const EVENT_SPEEDS = [0.5, 1, 2, 4]

const input = ref('')
const loading = ref(false)
const failed = ref(false)
const unavailable = ref(false)
const truncated = ref(false)
const notice = ref('')
const candidates = ref<PersonHit[]>([])

const scope = ref<Scope>({ by: 'all' })
const items = ref<TraceItem[]>([])
const windowStart = ref(0)
const windowMs = ref(1)
const position = ref(0)
const playing = ref(false)
const speed = ref(60)
const names = ref<Record<string, string>>({})
const subject = ref('')

const mode = computed<'window' | 'events'>(() => (scope.value.by === 'all' ? 'window' : 'events'))
const speeds = computed(() => (mode.value === 'window' ? WINDOW_SPEEDS : EVENT_SPEEDS))
const reduced = ref(false)
let mql: MediaQueryList | null = null
const onMql = (e: MediaQueryListEvent): void => { reduced.value = e.matches }

const currentIndex = computed(() => {
  if (mode.value !== 'events') return -1
  return Math.max(0, Math.min(items.value.length - 1, Math.floor(position.value)))
})
const totals = computed(() => nodeCounts(items.value))
const totalChips = computed(() => (Object.keys(COUNT_LABEL) as NodeId[])
  .filter((n) => n !== 'queue')
  .map((n) => ({ key: n, label: COUNT_LABEL[n] as string, n: totals.value[n] ?? 0 })))
const top = computed(() => (mode.value === 'window' ? topActive(items.value, 10) : []))

const canvasLabel = computed(() => mode.value === 'window'
  ? '派工流程圖：近 4 小時全站事件重播，圓點沿線從官方資料、臂、佇列、派工、交件、驗證走到落庫或退件'
  : `派工流程圖：${subject.value || '指定對象'}的事件依真實順序重播`)

const spanText = computed(() => {
  const n = items.value.length
  if (mode.value === 'window') return `全站近 4 小時，共 ${n.toLocaleString('zh-TW')} 件事${truncated.value ? '（事件太多，只取到一部分）' : ''}`
  if (n === 0) return ''
  return `${subject.value}，共 ${n} 件事，${taipeiFull(items.value[0].ms)} 到 ${taipeiFull(items.value[n - 1].ms)}${truncated.value ? '（事件太多，只取到一部分）' : ''}`
})

function taskLabel(id: string): string {
  const type = taskTypeOfId(id)
  if (!type) return '手動任務'
  const pid = personFromTaskId(id)
  const who = pid ? names.value[pid] : ''
  return who ? `${taskTypeLabel(type)}・${who}` : taskTypeLabel(type)
}
const personLabel = (id: string): string => names.value[id] ?? '載入中…'
const labelOf = (a: Active): string => (a.kind === 'task' ? taskLabel(a.id) : personLabel(a.id))

let seq = 0
function reset(next: Scope, result: TraceResult, label: string): void {
  scope.value = next
  items.value = toItems(result.rows)
  windowStart.value = result.since
  windowMs.value = Math.max(1, result.until - result.since)
  truncated.value = result.truncated
  unavailable.value = result.unavailable
  subject.value = label
  position.value = 0
  speed.value = next.by === 'all' ? 60 : 1
  playing.value = !reduced.value && items.value.length > 0
}

async function loadNames(ids: string[]): Promise<void> {
  const missing = ids.filter((i) => !(i in names.value))
  if (missing.length === 0) return
  try {
    names.value = { ...names.value, ...(await fetchNames(missing)) }
  } catch (e) {
    console.info('[重播] 讀不到人名', e)
  }
}

async function loadAll(my: number): Promise<void> {
  const r = await fetchWindow()
  if (my !== seq) return
  reset({ by: 'all' }, r, '全站近 4 小時')
  void loadNames(topActive(items.value, 10).filter((a) => a.kind === 'person').map((a) => a.id))
  void loadNames(topActive(items.value, 10).filter((a) => a.kind === 'task').map((a) => personFromTaskId(a.id)).filter((x): x is string => !!x))
}

const SCOPE_LABEL = { task: '任務', contribution: '交件', person: '人物' } as const

async function loadScope(s: Exclude<Scope, { by: 'all' }>, my: number): Promise<void> {
  const r = await fetchScoped(s)
  if (my !== seq) return
  let label: string = SCOPE_LABEL[s.by]
  if (s.by === 'person') {
    await loadNames([s.id])
    label = `人物：${names.value[s.id] ?? '（未知）'}`
  } else if (s.by === 'task') {
    await loadNames([personFromTaskId(s.id) ?? ''].filter(Boolean))
    label = `任務：${taskLabel(s.id)}`
  } else {
    label = '交件'
  }
  if (my !== seq) return
  reset(s, r, label)
  if (!r.unavailable && r.rows.length === 0) notice.value = '近 14 天沒有這個對象的事件。認領紀錄從 11 月 11 日才開始記，驗證票的派出只留最近 7 天。'
}

async function run(idParam: string | undefined): Promise<void> {
  const my = ++seq
  loading.value = true
  failed.value = false
  notice.value = ''
  candidates.value = []
  try {
    const raw = idParam ? decodeURIComponent(idParam) : ''
    input.value = raw
    const t = parseTarget(raw)
    if (t.type === 'none') await loadAll(my)
    else if (t.type === 'task') await loadScope({ by: 'task', id: t.id }, my)
    else if (t.type === 'uuid') {
      const s = await probeUuid(t.id)
      if (my !== seq) return
      if (!s) {
        await loadAll(my)
        if (my === seq) notice.value = '近 14 天沒有這個編號的事件，請確認編號是任務、交件或人物；下面先顯示全站近 4 小時。'
      } else await loadScope(s, my)
    } else {
      await submitName(t.text, my)
    }
  } catch (e) {
    if (my === seq) {
      console.info('[重播] 讀取失敗', e)
      failed.value = true
    }
  } finally {
    if (my === seq) loading.value = false
  }
}

async function submitName(text: string, my: number): Promise<void> {
  const hits = await searchPeople(text)
  if (my !== seq) return
  if (hits.length === 0) {
    notice.value = `找不到叫「${text}」的人。`
    return
  }
  if (hits.length === 1) {
    go(hits[0].id)
    return
  }
  candidates.value = hits
  notice.value = `有 ${hits.length} 位符合，請選一位。`
}

function go(id: string | null): void {
  const target = id ? `/trace/${encodeURIComponent(id)}` : '/trace'
  if (router.resolve(target).fullPath === route.fullPath) void run(id ?? undefined)
  else void router.push(target)
}

function onSubmit(): void {
  const t = parseTarget(input.value)
  if (t.type === 'none') go(null)
  else if (t.type === 'name') void run(encodeURIComponent(t.text))
  else go(t.id)
}

function onPick(a: Active): void {
  go(a.id)
}

// ---- 播放控制 ----
function toggle(): void {
  if (!playing.value && position.value >= (mode.value === 'window' ? windowMs.value : items.value.length)) position.value = 0
  playing.value = !playing.value
}
function restart(): void {
  position.value = 0
  playing.value = !reduced.value && items.value.length > 0
}
function seek(v: number): void {
  position.value = v
}
function stepEvent(d: number): void {
  if (mode.value === 'events') position.value = Math.max(0, Math.min(items.value.length - 1, Math.floor(position.value) + d))
  else position.value = Math.max(0, Math.min(windowMs.value, position.value + d * 60_000))
}
function onEnd(): void {
  playing.value = false
}
function onSpeed(s: number): void {
  speed.value = s
}

watch(() => route.params.id, (id) => {
  void run(Array.isArray(id) ? id[0] : id)
})
onMounted(() => {
  mql = window.matchMedia('(prefers-reduced-motion: reduce)')
  reduced.value = mql.matches
  mql.addEventListener('change', onMql)
  const id = route.params.id
  void run(Array.isArray(id) ? id[0] : id)
})
onBeforeUnmount(() => mql?.removeEventListener('change', onMql))
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20">
    <Hero>
      <template #title>重播派工流動</template>
      <template #description>看任務怎麼從缺口、佇列、派工、交件走到驗證、落庫或退件</template>
      <template #icon><Waypoints :size="400" class="text-blue-500" /></template>
    </Hero>
    <main class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 mt-8 text-sm text-slate-700 space-y-6">
      <form class="flex flex-col gap-2 sm:flex-row" role="search" @submit.prevent="onSubmit">
        <label class="sr-only" for="trace-input">任務編號、交件編號、人物編號或人名</label>
        <input
          id="trace-input"
          v-model="input"
          type="text"
          inputmode="search"
          autocomplete="off"
          placeholder="貼任務編號、交件編號、人物編號，或輸入人名（留白＝全站近 4 小時）"
          class="min-h-[44px] flex-1 rounded border border-slate-300 bg-white px-3 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-sky-400"
        />
        <div class="flex gap-2">
          <button type="submit" class="inline-flex min-h-[44px] items-center gap-1 rounded bg-slate-800 px-4 text-white hover:bg-slate-700 disabled:opacity-50" :disabled="loading">
            <Search :size="16" /> 重播
          </button>
          <button v-if="mode === 'events' || input" type="button" class="min-h-[44px] rounded border border-slate-300 bg-white px-3 hover:bg-slate-50" @click="go(null)">全站近 4 小時</button>
        </div>
      </form>

      <ul v-if="candidates.length" class="divide-y divide-slate-100 rounded border border-slate-200 bg-white" aria-label="符合的人物">
        <li v-for="p in candidates" :key="p.id">
          <button type="button" class="flex min-h-[44px] w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-left hover:bg-slate-50" @click="go(p.id)">
            <span class="font-medium text-slate-900">{{ p.name }}</span>
            <span class="text-xs text-slate-500">{{ [p.party, p.region, p.current_position].filter(Boolean).join('・') }}</span>
          </button>
        </li>
      </ul>

      <p v-if="notice" class="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800" role="status">{{ notice }}</p>
      <p v-if="unavailable" class="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800" role="status">重播功能正在更新，請幾分鐘後再試。</p>
      <LoadError v-if="failed" inline message="暫時讀不到資料，請稍後重試" @retry="run(route.params.id as string | undefined)" />

      <section class="rounded-lg border border-slate-200 bg-white p-3 sm:p-4 space-y-3" aria-live="polite">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-base font-semibold text-slate-900">{{ mode === 'window' ? '全站即時流動' : subject }}</h2>
          <p class="text-xs text-slate-500">{{ loading ? '讀取中…' : spanText }}</p>
        </div>
        <TraceCanvas
          :items="items"
          :mode="mode"
          :window-start="windowStart"
          :window-ms="windowMs"
          :position="position"
          :playing="playing"
          :speed="speed"
          :reduced="reduced"
          :label="canvasLabel"
          @update:position="position = $event"
          @end="onEnd"
        />
        <TraceControls
          :mode="mode"
          :playing="playing"
          :speed="speed"
          :speeds="speeds"
          :position="position"
          :window-start="windowStart"
          :window-ms="windowMs"
          :count="items.length"
          :reduced="reduced"
          @toggle="toggle"
          @restart="restart"
          @seek="seek"
          @speed="onSpeed"
          @prev="stepEvent(-1)"
          @next="stepEvent(1)"
        />
        <p class="text-xs text-slate-500">虛線是回流：交件後驗證票回到佇列、查無冷卻完再派、代理順手提議的新缺口。</p>
        <ul class="flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-100 pt-2 text-xs text-slate-600" aria-label="這段時間各節點的事件數">
          <li v-for="c in totalChips" :key="c.key" class="tabular-nums">{{ c.label }} <b class="text-slate-900">{{ c.n.toLocaleString('zh-TW') }}</b></li>
        </ul>
      </section>

      <section v-if="mode === 'events' && items.length" class="space-y-2">
        <h2 class="text-base font-semibold text-slate-900">事件時間軸</h2>
        <p class="text-xs text-slate-500">每一列是一件真實發生的事；紅色標記是跟上一件事隔最久的幾段，通常就是卡住的地方。點一列可跳到那裡。</p>
        <TraceTimeline :items="items" :current="currentIndex" @select="seek" />
      </section>

      <section v-if="mode === 'window' && top.length" class="space-y-2">
        <h2 class="text-base font-semibold text-slate-900">這 4 小時最活躍的任務與人</h2>
        <TraceTop :rows="top" :label-of="labelOf" @pick="onPick" />
      </section>

      <p class="text-xs text-slate-400">
        <router-link to="/queue" class="inline-flex items-center gap-1 text-sky-700 hover:underline"><ListOrdered :size="14" /> 回派工隊列</router-link>
        <span class="ml-3">時間皆為台北時間。</span>
      </p>
    </main>
  </div>
</template>
