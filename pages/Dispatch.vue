<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { supabasePublic } from '../lib/supabase'
import { withTimeoutAndRetry } from '../lib/retry'
import { usePageHead } from '../composables/usePageHead'
import Hero from '../components/Hero.vue'
import MechanismNav from '../components/MechanismNav.vue'
import BoardNav from '../components/contributions/BoardNav.vue'
import { CalendarRange } from 'lucide-vue-next'
import {
  DAILY_GROUPS, STAGE_META, armGroup, armLabel, fromDay, makeScale, milestoneLabel, toDay,
  type Passive, type RuleFlags, type Timeline, type TimelineArm, type TimelineElection, type TimelineWindow,
} from '../lib/dispatch-schedule'

// 派工日程（2026-10-20，#703）：站務主控台「派工」頁的公開版。讀三支 anon 可執行的唯讀函式
// console_timeline_elections()、console_timeline()、console_passive()（20261010110000 起），資料與主控台同一份。
// 拿掉主控台的下載、臨時開關／覆寫、段落編號與「開」標籤；長條圖自帶刻度、圖例與滑過提示。維護者：正式頁不自動重新整理。

usePageHead({ title: '派工日程', description: '各類任務在一場選舉前後的哪一段時間開放派工', noindex: true })

const elections = ref<TimelineElection[]>([])
const electionId = ref('')
const timeline = ref<Timeline | null>(null)
const passive = ref<Passive | null>(null)
const ruleFlags = ref<Record<number, RuleFlags>>({})
const failed = ref(false)
const loading = ref(false)
const refreshedAt = ref<Date | null>(null)

const todayTaipei = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
/** 預設選「今天以後最近的一場」，沒有就選最近過去的一場 */
function defaultElection(list: TimelineElection[]): string {
  const today = todayTaipei()
  const upcoming = list.filter((e) => e.election_date >= today).sort((a, b) => a.election_date.localeCompare(b.election_date))
  return (upcoming[0] ?? list[0])?.election_id ?? ''
}
const electionLabel = (e: TimelineElection) => `${e.election_date} ${e.name ?? (e.election_types ?? []).join('、')}`

async function loadTimeline() {
  const id = electionId.value
  if (!id) return
  const { data } = await withTimeoutAndRetry('console timeline', (signal) =>
    supabasePublic.rpc('console_timeline', { p_election_id: id }).abortSignal(signal).throwOnError())
  if (id === electionId.value) timeline.value = (data ?? null) as Timeline | null
}
async function load() {
  if (loading.value) return
  loading.value = true
  failed.value = false
  try {
    const { data } = await withTimeoutAndRetry('console timeline elections', (signal) =>
      supabasePublic.rpc('console_timeline_elections').abortSignal(signal).throwOnError())
    elections.value = (data ?? []) as TimelineElection[]
    if (!elections.value.some((e) => e.election_id === electionId.value)) electionId.value = defaultElection(elections.value)
    await loadTimeline()
    refreshedAt.value = new Date()
    // 被動段與規則旗標讀不到不影響主圖
    try {
      const { data: p } = await withTimeoutAndRetry('console passive', (signal) =>
        supabasePublic.rpc('console_passive').abortSignal(signal).throwOnError())
      passive.value = (p ?? null) as Passive | null
    } catch { passive.value = null }
    try {
      const { data: rules } = await withTimeoutAndRetry('activity rules flags', (signal) =>
        supabasePublic.from('activity_rules').select('id,except_election_types,requires_traffic').is('priority', null).order('id').limit(500).abortSignal(signal).throwOnError())
      const out: Record<number, RuleFlags> = {}
      for (const r of (rules ?? []) as { id: number; except_election_types: string[] | null; requires_traffic: boolean | null }[]) {
        const except = r.except_election_types ?? []
        if (except.length || r.requires_traffic) out[r.id] = { except, traffic: !!r.requires_traffic }
      }
      ruleFlags.value = out
    } catch { ruleFlags.value = {} }
  } catch (e) {
    console.info('[派工日程] 讀取失敗', e)
    failed.value = true
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(electionId, () => {
  timeline.value = null
  expanded.value = new Set()
  loadTimeline().catch((e) => { console.info('[派工日程] 讀取失敗', e); failed.value = true })
})

const fmt = (n: number) => n.toLocaleString('zh-TW')
const hms = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`

// 顏色一律 inline hex（不靠 Tailwind 動態 class）
const C = { open: '#22c55e', openSoft: '#bbf7d0', closed: '#cbd5e1', today: '#ef4444', axis: '#e2e8f0', stale: '#b91c1c' }

// ---- 時間軸 ----
const tl = computed(() => timeline.value)
/** 軸上的里程碑：同一種取最早的一天，同一天的併成一個刻度 */
const ticks = computed(() => {
  const t = tl.value
  if (!t) return []
  const by = new Map<string, { kind: string; day: number; dates: string[] }>()
  for (const m of t.milestones) {
    const d = toDay(m.on_date)
    const tag = m.election_type ? `${m.on_date}（${m.election_type}）` : m.on_date
    const cur = by.get(m.kind)
    if (!cur) by.set(m.kind, { kind: m.kind, day: d, dates: [tag] })
    else {
      cur.day = Math.min(cur.day, d)
      if (!cur.dates.includes(tag)) cur.dates.push(tag)
    }
  }
  const out: { day: number; label: string; title: string }[] = []
  for (const m of [...by.values()].sort((a, b) => a.day - b.day)) {
    const name = milestoneLabel(m.kind)
    const title = `${name}：${m.dates.join('、')}`
    const same = out.find((o) => o.day === m.day)
    if (same) { same.label += `・${name}`; same.title += `\n${title}` }
    else out.push({ day: m.day, label: name, title })
  }
  return out
})
const scale = computed(() => {
  const t = tl.value
  if (!t) return (_: number) => 0
  return makeScale([toDay(t.today), ...ticks.value.map((k) => k.day)])
})
const x = (day: number) => scale.value(day)
const todayX = computed(() => (tl.value ? x(toDay(tl.value.today)) : 0))

const spanText = (w: TimelineWindow) =>
  w.window_kind === 'always' ? '全程開放' : `${w.from ?? '不限起'} ～ ${w.until ?? '不限止'}`
const edgeText = (w: TimelineWindow) => {
  if (w.window_kind === 'always') return ''
  const a = w.from_kind ? `${milestoneLabel(w.from_kind)}起` : '不限起'
  const b = w.until_kind ? `${milestoneLabel(w.until_kind)}止` : '不限止'
  return `（${a}～${b}）`
}
/** 一支任務的一條開放區間（長條）：位置、寬度、滑過提示 */
function bars(a: TimelineArm) {
  return a.windows.map((w) => {
    const left = w.window_kind === 'always' || !w.from ? 0 : x(toDay(w.from))
    const right = w.window_kind === 'always' || !w.until ? 100 : x(toDay(w.until))
    const f = ruleFlags.value[w.rule_id]
    const lines = [
      armLabel(a.arm),
      `開放期間：${spanText(w)}${edgeText(w)}`,
      w.election_types?.length ? `適用職位：${w.election_types.join('、')}` : '',
      f?.except.length ? `不含：${f.except.join('、')}` : '',
      f?.traffic ? '頁面有流量才派' : '',
      w.missing_milestone ? '這場選舉還沒有這條規則要的日期' : '',
      `今天：${a.is_open ? '開放派工' : '沒有開放'}`,
      a.queue_count == null ? '' : `全站件數：${fmt(a.queue_count)}`,
    ].filter(Boolean)
    return {
      key: w.rule_id, left, width: Math.max(right - left, 0.8), always: w.window_kind === 'always',
      missing: w.missing_milestone, traffic: !!f?.traffic, title: lines.join('\n'),
    }
  })
}
const spansOf = (a: TimelineArm) => a.windows.map(spanText).join('、')

/** 展開某支任務看各職位：規則的起訖在後端照整場最早／最晚的里程碑算，這裡反推偏移再套到該職位自己的里程碑 */
const expanded = ref(new Set<string>())
function toggle(arm: string) {
  const next = new Set(expanded.value)
  if (next.has(arm)) next.delete(arm)
  else next.add(arm)
  expanded.value = next
}
function typeBars(a: TimelineArm, type: string | null) {
  const ms = tl.value?.milestones ?? []
  const dayOf = (kind: string | null, pick: 'min' | 'max', types: string[] | null): number | null => {
    if (!kind) return null
    const ds = ms.filter((m) => m.kind === kind && (types == null || m.election_type == null || types.includes(m.election_type))).map((m) => toDay(m.on_date))
    return ds.length ? (pick === 'min' ? Math.min(...ds) : Math.max(...ds)) : null
  }
  const typeDay = (kind: string | null): number | null => {
    if (!kind) return null
    const own = ms.find((m) => m.kind === kind && m.election_type === type) ?? ms.find((m) => m.kind === kind && m.election_type == null)
    return own ? toDay(own.on_date) : null
  }
  const open = a.by_type?.find((b) => b.election_type === type)?.is_open ?? a.is_open
  return a.windows
    .filter((w) => !w.election_types?.length || (type != null && w.election_types.includes(type)))
    .filter((w) => !(type != null && ruleFlags.value[w.rule_id]?.except.includes(type)))
    .map((w) => {
      const traffic = !!ruleFlags.value[w.rule_id]?.traffic
      const name = type ?? '不分職位'
      if (w.window_kind === 'always') return { key: w.rule_id, left: 0, width: 100, always: true, missing: false, traffic, open, title: `${armLabel(a.arm)}・${name}\n開放期間：全程開放` }
      const baseFrom = dayOf(w.from_kind, 'min', w.election_types)
      const baseUntil = dayOf(w.until_kind, 'max', w.election_types)
      const fromOff = w.from && baseFrom != null ? toDay(w.from) - baseFrom : 0
      const untilOff = w.until && baseUntil != null ? toDay(w.until) - baseUntil : 0
      const f = typeDay(w.from_kind)
      const u = typeDay(w.until_kind)
      const missing = (w.from_kind != null && f == null) || (w.until_kind != null && u == null)
      const left = w.from_kind == null || f == null ? 0 : x(f + fromOff)
      const right = w.until_kind == null || u == null ? 100 : x(u + untilOff)
      const fromS = w.from_kind == null ? '不限起' : f == null ? '缺日期' : fromDay(f + fromOff)
      const untilS = w.until_kind == null ? '不限止' : u == null ? '缺日期' : fromDay(u + untilOff)
      return { key: w.rule_id, left, width: Math.max(right - left, 0.8), always: false, missing, traffic, open, title: `${armLabel(a.arm)}・${name}\n開放期間：${fromS} ～ ${untilS}${edgeText(w)}` }
    })
}

// ---- 分組：當屆選舉（依段）、日常（依小組） ----
const electionArms = computed(() => (tl.value?.arms ?? []).filter((a) => armGroup(a.arm) === 'election'))
const stageGroups = computed(() => {
  const out: { stage: number; label: string; hint: string; arms: TimelineArm[] }[] = []
  for (const a of electionArms.value) {
    let g = out.find((o) => o.stage === a.stage)
    if (!g) {
      const meta = STAGE_META[a.stage] ?? { label: `其他`, hint: '' }
      g = { stage: a.stage, label: meta.label, hint: meta.hint, arms: [] }
      out.push(g)
    }
    g.arms.push(a)
  }
  return out.sort((p, q) => p.stage - q.stage)
})
const newsQueued = computed(() => passive.value?.news_queued ?? 0)
const dailyCount = (a: TimelineArm) => Math.max(0, (a.queue_count ?? 0) - (a.arm === 'manual_open' ? newsQueued.value : 0))
const dailyGroups = computed(() =>
  DAILY_GROUPS.map((g) => ({ ...g, arms: (tl.value?.arms ?? []).filter((a) => armGroup(a.arm) === g.key) })).filter((g) => g.arms.length > 0))
const dailyTotal = computed(() => dailyGroups.value.reduce((n, g) => n + g.arms.reduce((m, a) => m + dailyCount(a), 0), 0))
const staleCount = computed(() => electionArms.value.filter((a) => a.stale).reduce((n, a) => n + (a.election_count ?? 0), 0))
const countTitle = (a: TimelineArm) =>
  a.stale
    ? `這一段 ${a.stage_end} 已經結束，這一屆還有 ${fmt(a.election_count ?? 0)} 件在派`
    : `這一屆的件數${a.stage_end ? `（這一段到 ${a.stage_end}）` : ''}${a.queue_count == null ? '' : `；全站 ${fmt(a.queue_count)} 件`}`

// ---- 被動、驗證佇列 ----
const SOURCE_LABEL: Record<string, string> = { news: '新聞收錄', web_request: '網站請求', question: '公民提問', adjudication: '裁決', agent: '一般代理交件' }
const SOURCE_ORDER = ['news', 'web_request', 'question', 'adjudication', 'agent']
const pending = computed(() => SOURCE_ORDER.map((k) => ({ key: k, label: SOURCE_LABEL[k], n: passive.value?.verify_pending[k] ?? 0 })))
const pendingTotal = computed(() => Object.values(passive.value?.verify_pending ?? {}).reduce((a, b) => a + b, 0))
const SUGGESTION_LABEL: Record<string, string> = { new_pledge: '新承諾', progress: '政見進度' }
const newsTasks = computed(() => Object.entries(passive.value?.news_tasks ?? {}).map(([k, v]) => ({ key: k, label: SUGGESTION_LABEL[k] ?? '其他', ...v })))
const visitorCount = computed(() => tl.value?.arms.find((a) => a.arm === 'manual_visitor')?.queue_count ?? null)
const FUNNEL: [string, string][] = [
  ['received', '收進'], ['no_name', '沒有人名'], ['unrelated', '判無關'], ['low_confidence', '把握不夠'],
  ['new_pledge', '新承諾'], ['progress', '政見進度'], ['opened', '開了任務'], ['appended', '併進已開的任務'], ['deferred', '超過每日上限延後'],
]
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20">
    <Hero>
      <template #title>派工日程</template>
      <template #description>
        每一類任務在選舉前後的哪一段時間開放派工，選一場選舉就看得到它的日程，也看得到現在還排了多少件。
      </template>
      <template #icon><CalendarRange :size="400" class="text-blue-500" /></template>
      <template #actions>
        <MechanismNav current="contributions" />
      </template>
      <BoardNav current="dispatch" />
    </Hero>
    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-8 text-sm text-slate-700 space-y-6">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <label class="text-xs text-slate-500" for="dispatch-election">選舉</label>
          <select id="dispatch-election" v-model="electionId" class="max-w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm" :disabled="!elections.length" data-testid="dispatch-election">
            <option v-for="e in elections" :key="e.election_id" :value="e.election_id">{{ electionLabel(e) }}</option>
          </select>
        </div>
        <div class="flex items-center gap-2">
          <p class="text-slate-400 tabular-nums">{{ refreshedAt ? `更新於 ${hms(refreshedAt)}` : '' }}</p>
          <button type="button" class="rounded border border-slate-300 px-2.5 py-1 hover:bg-slate-50 disabled:opacity-50" :disabled="loading" @click="load">
            {{ loading ? '更新中…' : '重新整理' }}
          </button>
        </div>
      </div>
      <p v-if="failed" class="text-red-600">日程讀不到，<button class="underline" @click="load">重試</button>。</p>
      <p v-else-if="!tl" class="text-slate-400">載入中…</p>

      <template v-if="tl && !failed">
        <!-- 圖例：每種長條、線與框代表什麼 -->
        <section class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5" data-testid="dispatch-legend">
          <h3 class="font-black text-navy-900 mb-3">怎麼看這張圖</h3>
          <div class="flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-600">
            <span class="inline-flex items-center gap-1.5"><i class="inline-block h-3 w-6 rounded-sm" :style="{ background: C.open }"></i>這類任務開放派工的期間，今天開放中</span>
            <span class="inline-flex items-center gap-1.5"><i class="inline-block h-3 w-6 rounded-sm" :style="{ background: C.closed }"></i>開放期間，但今天沒有開放</span>
            <span class="inline-flex items-center gap-1.5"><i class="inline-block h-3 w-6 rounded-sm" :style="{ background: C.openSoft }"></i>不分時期，全程開放</span>
            <span class="inline-flex items-center gap-1.5"><i class="inline-block h-3 w-6 rounded-sm border border-dashed border-slate-400"></i>這場選舉還沒有規則要的日期</span>
            <span class="inline-flex items-center gap-1.5"><i class="inline-block h-3 w-6 rounded-sm border border-dotted" :style="{ borderColor: C.open }"></i>頁面有流量才派</span>
            <span class="inline-flex items-center gap-1.5"><i class="inline-block h-3.5 w-0.5" :style="{ background: C.today }"></i>今天（{{ tl.today }}）</span>
          </div>
          <p class="mt-2 text-xs text-slate-500">上方直線是這場選舉的各個日期（登記、公告、投票等）。把滑鼠移到長條上，看開始與結束日期、適用職位與件數；點任務名稱左邊的三角形，展開看各職位。橫軸的日期間距有壓縮，不是等比例。</p>
        </section>

        <!-- 當屆選舉 -->
        <div class="overflow-x-auto">
          <div class="min-w-[760px] space-y-6">
            <section class="bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden" data-testid="dispatch-election-section">
              <div class="flex border-b border-slate-200">
                <div class="w-56 shrink-0 px-4 py-2 text-xs text-slate-500 self-end">任務</div>
                <div class="relative h-28 flex-1">
                  <div v-for="t in ticks" :key="t.day" class="absolute bottom-0 top-0 border-l" :style="{ left: `${x(t.day)}%`, borderColor: C.axis }" :title="t.title">
                    <div class="absolute bottom-1 left-1 origin-bottom-left -rotate-[60deg] whitespace-nowrap text-[11px] text-slate-500">
                      {{ t.label }} <span class="tabular-nums">{{ fromDay(t.day).slice(5) }}</span>
                    </div>
                  </div>
                  <div class="absolute bottom-0 top-0 border-l-2" :style="{ left: `${todayX}%`, borderColor: C.today }" :title="`今天 ${tl.today}`">
                    <span class="absolute left-1 top-0.5 whitespace-nowrap rounded px-1 text-[10px] font-medium text-white" :style="{ background: C.today }">今天 {{ tl.today.slice(5) }}</span>
                  </div>
                </div>
                <div class="w-20 shrink-0 px-3 py-2 text-right text-xs text-slate-500 self-end">件數</div>
              </div>
              <div class="flex flex-wrap items-baseline gap-x-3 border-b border-slate-200 bg-slate-50 px-4 py-2">
                <span class="font-black text-navy-900">當屆選舉</span>
                <span class="text-xs text-slate-500">只算這一屆：<span class="tabular-nums">{{ fmt(tl.election_total ?? 0) }}</span> 件</span>
                <span v-if="staleCount" class="text-xs" :style="{ color: C.stale }">其中 <span class="tabular-nums">{{ fmt(staleCount) }}</span> 件落在已經結束的段</span>
              </div>
              <template v-for="g in stageGroups" :key="g.stage">
                <div class="border-b border-slate-200 bg-slate-50/60 px-4 py-1.5 text-xs">
                  <span class="font-medium text-slate-800">{{ g.label }}</span>
                  <span class="ml-1 text-slate-400">（{{ g.arms.length }}）</span>
                  <span class="ml-2 text-slate-500">{{ g.hint }}</span>
                </div>
                <template v-for="a in g.arms" :key="a.arm">
                  <div class="flex items-center border-b border-slate-100">
                    <div class="w-56 shrink-0 px-4 py-2">
                      <button v-if="a.by_type?.length" type="button" class="-ml-1 rounded px-1 text-left hover:bg-slate-100" :aria-expanded="expanded.has(a.arm)" :title="expanded.has(a.arm) ? '收起各職位' : '展開看各職位的件數與日程'" @click="toggle(a.arm)">
                        <span class="mr-0.5 inline-block w-3 text-[10px] text-slate-400">{{ expanded.has(a.arm) ? '▾' : '▸' }}</span>{{ armLabel(a.arm) }}
                      </button>
                      <span v-else>{{ armLabel(a.arm) }}</span>
                      <div class="text-[11px] text-slate-400 tabular-nums">{{ spansOf(a) }}</div>
                    </div>
                    <div class="relative h-7 flex-1">
                      <div class="absolute bottom-0 top-0 border-l-2" :style="{ left: `${todayX}%`, borderColor: C.today, opacity: 0.4 }"></div>
                      <div
                        v-for="b in bars(a)" :key="b.key" class="absolute top-1.5 h-4 rounded-sm"
                        :style="{
                          left: `${b.left}%`, width: `${b.width}%`,
                          background: b.missing || b.traffic ? 'transparent' : a.is_open ? (b.always ? C.openSoft : C.open) : C.closed,
                          border: b.missing ? '1px dashed #94a3b8' : b.traffic ? `1px dotted ${C.open}` : 'none',
                        }"
                        :title="b.title"
                      ></div>
                    </div>
                    <div class="w-20 shrink-0 px-3 py-2 text-right text-xs tabular-nums" :style="{ color: a.stale ? C.stale : '#64748b', fontWeight: a.stale ? 700 : 400 }" :title="countTitle(a)">{{ fmt(a.election_count ?? 0) }}</div>
                  </div>
                  <div v-if="expanded.has(a.arm) && a.by_type?.length" class="border-b border-slate-100 bg-slate-50/50 py-1">
                    <div v-for="b in a.by_type" :key="b.election_type ?? ''" class="flex items-center">
                      <div class="w-56 shrink-0 py-1 pl-10 pr-4 text-xs">{{ b.election_type ?? '不分職位' }}</div>
                      <div class="relative h-5 flex-1">
                        <div class="absolute bottom-0 top-0 border-l-2" :style="{ left: `${todayX}%`, borderColor: C.today, opacity: 0.4 }"></div>
                        <div
                          v-for="t in typeBars(a, b.election_type)" :key="t.key" class="absolute top-1 h-3 rounded-sm"
                          :style="{
                            left: `${t.left}%`, width: `${t.width}%`,
                            background: t.missing || t.traffic ? 'transparent' : t.open ? (t.always ? C.openSoft : C.open) : C.closed,
                            border: t.missing ? '1px dashed #94a3b8' : t.traffic ? `1px dotted ${C.open}` : 'none',
                          }"
                          :title="t.title"
                        ></div>
                      </div>
                      <div class="w-20 shrink-0 px-3 py-0.5 text-right text-xs tabular-nums text-slate-500" title="這一屆這個職位的件數">{{ fmt(b.n) }}</div>
                    </div>
                  </div>
                </template>
              </template>
            </section>

            <!-- 日常：不跟選舉日曆走，沿用同一條軸好對照今天 -->
            <section v-if="dailyGroups.length" class="bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden" data-testid="dispatch-daily-section">
              <div class="flex flex-wrap items-baseline gap-x-3 border-b border-slate-200 bg-slate-50 px-4 py-2">
                <span class="font-black text-navy-900">日常</span>
                <span class="text-xs text-slate-500">不跟選舉日曆走，不隨上面選的選舉變：<span class="tabular-nums">{{ fmt(dailyTotal) }}</span> 件<template v-if="newsQueued">（新聞任務 <span class="tabular-nums">{{ fmt(newsQueued) }}</span> 件列在下面的被動）</template></span>
              </div>
              <template v-for="g in dailyGroups" :key="g.key">
                <div class="border-b border-slate-200 bg-slate-50/60 px-4 py-1.5 text-xs">
                  <span class="font-medium text-slate-800">{{ g.label }}</span>
                  <span class="ml-1 text-slate-400">（{{ g.arms.length }}）</span>
                  <span class="ml-2 text-slate-500">{{ g.hint }}</span>
                </div>
                <div v-for="a in g.arms" :key="a.arm" class="flex items-center border-b border-slate-100">
                  <div class="w-56 shrink-0 px-4 py-2">
                    {{ armLabel(a.arm) }}
                    <div class="text-[11px] text-slate-400 tabular-nums">{{ spansOf(a) }}</div>
                  </div>
                  <div class="relative h-7 flex-1">
                    <div class="absolute bottom-0 top-0 border-l-2" :style="{ left: `${todayX}%`, borderColor: C.today, opacity: 0.4 }"></div>
                    <div
                      v-for="b in bars(a)" :key="b.key" class="absolute top-1.5 h-4 rounded-sm"
                      :style="{
                        left: `${b.left}%`, width: `${b.width}%`,
                        background: b.missing || b.traffic ? 'transparent' : a.is_open ? (b.always ? C.openSoft : C.open) : C.closed,
                        border: b.missing ? '1px dashed #94a3b8' : b.traffic ? `1px dotted ${C.open}` : 'none',
                      }"
                      :title="b.title"
                    ></div>
                  </div>
                  <div class="w-20 shrink-0 px-3 py-2 text-right text-xs tabular-nums text-slate-500" title="這類任務的全站件數">{{ fmt(dailyCount(a)) }}</div>
                </div>
              </template>
            </section>
          </div>
        </div>

        <!-- 被動：外面進來的，有東西進來就處理 -->
        <section v-if="passive" class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5" data-testid="dispatch-passive">
          <h3 class="font-black text-navy-900 mb-1">被動</h3>
          <p class="mb-3 text-xs text-slate-500">外面進來的（新聞、網站訪客），有東西進來就處理，只列件數。</p>
          <div class="grid gap-4 md:grid-cols-2">
            <div>
              <div class="mb-1.5 text-xs text-slate-500">新聞初篩開出的任務</div>
              <div v-for="t in newsTasks" :key="t.key" class="flex items-center justify-between border-b border-slate-100 py-1 last:border-0">
                <span>{{ t.label }}</span>
                <span class="tabular-nums text-slate-500">開著 {{ fmt(t.open) }}・近 7 天完成 {{ fmt(t.closed_7d) }}</span>
              </div>
              <div v-if="!newsTasks.length" class="py-1 text-slate-400">目前沒有</div>
            </div>
            <div>
              <div class="mb-1.5 text-xs text-slate-500">網站請求</div>
              <div class="flex items-center justify-between py-1">
                <span>網站請求／公民提問</span>
                <span class="tabular-nums text-slate-500">{{ visitorCount == null ? '—' : fmt(visitorCount) }}</span>
              </div>
            </div>
          </div>
          <div v-if="passive.news_7d" class="mt-3 border-t border-slate-100 pt-3">
            <div class="mb-1.5 text-xs text-slate-500">近 7 天新聞收錄</div>
            <div class="flex flex-wrap gap-x-4 gap-y-1">
              <span v-for="[k, label] in FUNNEL" :key="k">{{ label }} <span class="tabular-nums text-slate-500">{{ fmt(passive.news_7d[k] ?? 0) }}</span></span>
            </div>
          </div>
        </section>

        <section v-if="passive" class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5" data-testid="dispatch-verify-queue">
          <h3 class="font-black text-navy-900 mb-1">驗證佇列</h3>
          <p class="mb-3 text-xs text-slate-500">交件後等投票的，共 <span class="tabular-nums">{{ fmt(pendingTotal) }}</span> 筆。</p>
          <div class="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
            <div v-for="r in pending" :key="r.key" class="flex items-center justify-between border-b border-slate-100 py-1">
              <span>{{ r.label }}</span>
              <span class="tabular-nums text-slate-500">{{ fmt(r.n) }}</span>
            </div>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>
