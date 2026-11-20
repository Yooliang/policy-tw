<script setup lang="ts">
/**
 * 政策脈絡主頁（#349、#675 第三期，/lineage/:lineageId）：一件事在某一層級、某一地方的來龍去脈。
 *   四區塊：現況（最新一筆，含截至日與出處）、這件事（摘要與出處）、各方立場（每人最新一筆）、大事記（事件與交接，新到舊）
 *   其後：筆數列、脈絡裡的政見（只有當選後的政見，承諾不在這裡）、參與者與角色、上下級脈絡
 * 版面上的字全部取自 lib/lineage-page-labels.ts 的白名單，模板裡不放任何靜態中文（lib/lineage-page.test.ts 守）；沒有資料寫標籤「尚無現況紀錄」「尚無立場紀錄」「尚無」。
 * 資料全在 lineages_full 那一列，邊緣渲染（cloudflare/ssr-worker.js）與預渲染拿到同一份；連結都是真的 <a href>，canonical 指正見.tw。
 * 這一期不放指向關係圖的連結（路由第四期才有）。顯示規則在 lib/lineage.ts 與 lib/lineage-page.ts。
 */
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { Activity, ArrowRight, CalendarClock, ChevronLeft, FileText, GitFork, Loader2, Scale, Users, Waypoints } from 'lucide-vue-next'
import { useSupabase } from '../composables/useSupabase'
import Hero from '../components/Hero.vue'
import Avatar from '../components/Avatar.vue'
import Breadcrumbs from '../components/Breadcrumbs.vue'
import LoadError from '../components/LoadError.vue'
import LineageSourceLink from '../components/LineageSourceLink.vue'
import { usePageHead, DATA_LICENSE_URL, PUBLISHER_LD, SITE_URL, type BreadcrumbItem } from '../composables/usePageHead'
import { policyStatusLabel } from '../composables/usePageHead'
import {
  BASIS_LABEL, buildTimeline, EVENT_TYPE_LABEL, HANDOVER_BADGE, HANDOVER_LABEL, hasBeenRepresentative, isLineageListed, LEVEL_LABEL, LINEAGE_NAME,
  lineagePath, lineagePlace, LINK_LABEL, needsHandoverRecord, participantRows, policyMeta, ROLE_LABEL, STANCE_LABEL, termRoleLabel,
} from '../lib/lineage'
import { PAGE_LABELS as T } from '../lib/lineage-page-labels'
import {
  buildChronicle, buildStanceRows, CHRONICLE_HEAD, coveragePlaces, formatStatedDate, pageCounts, statusHeadline, statusPhaseLabel,
} from '../lib/lineage-page'
import { stageOfPolicy, stageWord, taipeiToday } from '../lib/policy-stage'
import type { Policy } from '../types'

const route = useRoute()
const router = useRouter()
const { lineages, policies, politicians, elections, loading, error, loadLineageById, loadPoliciesByLineage, loadPoliticiansByIds } = useSupabase()

const lineageId = computed(() => String(route.params.lineageId ?? ''))
const lineage = computed(() => lineages.value.find((l) => l.id === lineageId.value))
const lineageLoading = ref(false)

// 直接開這一頁、或從政見頁點進來：快照裡沒有這一條就單獨撈（預渲染與邊緣渲染的快照已經帶了，不會重撈）
watch(lineageId, async (id) => {
  if (!id || lineage.value) return
  lineageLoading.value = true
  try { await loadLineageById(id) } finally { lineageLoading.value = false }
}, { immediate: true })

/** 這條脈絡的政見，照視圖給的順序（投票日） */
const lineagePolicies = computed<Policy[]>(() => {
  const l = lineage.value
  if (!l) return []
  const byId = new Map(policies.value.map((p) => [String(p.id), p]))
  return l.policyIds.map((id) => byId.get(id)).filter((p): p is Policy => !!p)
})

// 政見、提到的人不在全域狀態的補撈（快照通常都帶齊了）
watch(lineage, async (l) => {
  if (!l) return
  if (l.policyIds.some((id) => !policies.value.some((p) => String(p.id) === id))) await loadPoliciesByLineage(l.id)
  const people = [
    ...lineagePolicies.value.map((p) => String(p.politicianId)),
    ...l.participants.map((p) => p.politicianId),
    ...l.handovers.flatMap((h) => [h.fromPoliticianId, h.toPoliticianId]),
    ...(l.stances ?? []).map((s) => s.politicianId),
    ...(l.events ?? []).flatMap((e) => (e.initiator ? [e.initiator.politicianId] : [])),
  ]
  await loadPoliticiansByIds(people)
}, { immediate: true })

const personById = computed(() => new Map(politicians.value.map((p) => [String(p.id), p])))
const nameOf = (id: string) => personById.value.get(id)?.name
const electionDates = computed(() => new Map(elections.value.map((e) => [e.id, e.electionDate])))
const electionShortName = (id: number | null) => (id === null ? null : elections.value.find((e) => e.id === id)?.shortName ?? null)

// 今天（台北日期，同資料庫 activity_today()）：判斷「那一任卸任了沒」「投票日過了沒」
const today = taipeiToday()

/**
 * 交接區什麼時候出現：已經有交接紀錄；或脈絡裡有首長那一任的政見、而那一任已卸任（跟派交接任務同一個條件，lib/lineage.ts）。
 * 兩者都沒有（例：選前同場對手的承諾、還在任的首長、民意代表的提案）整個交接區不出現，政見照列。
 */
const showHandovers = computed(() => !!lineage.value && (lineage.value.handovers.length > 0
  || needsHandoverRecord(lineagePolicies.value, (id) => personById.value.get(id), electionDates.value, today)))

// 政見清單：一任一任的政見（交接改放大事記）
const timeline = computed(() => (lineage.value ? buildTimeline(lineagePolicies.value, [], electionDates.value) : []))
const stanceRows = computed(() => (lineage.value
  ? buildStanceRows({ stances: lineage.value.stances ?? [], policies: lineagePolicies.value, personOf: (id) => personById.value.get(id), nameOf, electionDates: electionDates.value })
  : []))
const chronicle = computed(() => (lineage.value ? buildChronicle(lineage.value.events ?? [], lineage.value.handovers, electionDates.value) : []))
const chronicleHead = computed(() => chronicle.value.slice(0, CHRONICLE_HEAD))
const chronicleRest = computed(() => chronicle.value.slice(CHRONICLE_HEAD))
const counts = computed(() => (lineage.value ? pageCounts(lineage.value) : { policies: 0, handovers: 0, events: 0, stances: 0 }))
const coverage = computed(() => coveragePlaces(lineage.value?.coverage))
const COVERAGE_SHOWN = 6
const STANCE_BADGE = { support: 'bg-emerald-50 text-emerald-700 border border-emerald-200', oppose: 'bg-red-50 text-red-700 border border-red-200', conditional: 'bg-amber-50 text-amber-800 border border-amber-200' } as const
const people = computed(() => (lineage.value
  ? participantRows(lineage.value.participants, lineagePolicies.value, nameOf, (id) => hasBeenRepresentative(personById.value.get(id), electionDates.value, today))
  : []))
const uppers = computed(() => lineage.value?.links.filter((k) => k.direction === 'upper') ?? [])
const lowers = computed(() => lineage.value?.links.filter((k) => k.direction === 'lower') ?? [])

/** 那一任的職位：當選寫職位、沒當選或還沒投票寫「…參選人」（lib/lineage.ts 的 termRoleLabel） */
function officeOf(politicianId: string, electionId: number | null): string {
  return termRoleLabel(personById.value.get(politicianId), electionId, electionDates.value, today)
}

/** 參與者徽章：這個人在脈絡裡的條目全是承諾寫「承諾提出者」、全是政見寫「政見提出者」、兩種都有寫「承諾與政見提出者」（#672） */
function proposerBadge(politicianId: string): string {
  const person = personById.value.get(politicianId)
  const words = new Set(lineagePolicies.value
    .filter((p) => String(p.politicianId) === politicianId)
    .map((p) => stageWord(stageOfPolicy(p, person, (id) => electionDates.value.get(id), today))))
  // 固定順序：承諾、政見、施政；一種＝「X提出者」，兩種以上＝「X與Y提出者」（三種＝「X、Y與Z提出者」）
  const ordered = (['承諾', '政見', '施政'] as const).filter((w) => words.has(w))
  if (ordered.length === 0) return '政見提出者'
  if (ordered.length === 1) return `${ordered[0]}提出者`
  return `${ordered.slice(0, -1).join('、')}與${ordered[ordered.length - 1]}提出者`
}

const place = computed(() => (lineage.value ? lineagePlace(lineage.value) : ''))
const breadcrumbs = computed<BreadcrumbItem[]>(() => (lineage.value
  ? [{ name: LINEAGE_NAME, path: '/analysis' }, ...(lineage.value.region ? [{ name: lineage.value.region }] : []), { name: lineage.value.title }]
  : []))

usePageHead({
  title: () => (lineage.value ? `${lineage.value.title}｜${LINEAGE_NAME}` : LINEAGE_NAME),
  description: () => (lineage.value
    ? `${place.value}「${lineage.value.title}」的政策脈絡：${statusHeadline(lineage.value) || (lineage.value.summary ? `${lineage.value.summary}。` : '')}${lineagePolicies.value.length} 條政見、${lineage.value.handovers.length > 0 ? `${lineage.value.handovers.length} 筆前後任交接、` : ''}${(lineage.value.events ?? []).length > 0 ? `${(lineage.value.events ?? []).length} 筆事件、` : ''}${(lineage.value.stances ?? []).length > 0 ? `${(lineage.value.stances ?? []).length} 筆立場、` : ''}${lineage.value.links.length} 條上下級關聯，每一筆附出處。`
    : '一件事在某一層級、某一地方的來龍去脈。'),
  type: 'article',
  // firebase.json 把 /lineage/** rewrite 到殼檔回 200，不存在的 id 也是 200；確定沒資料就標 noindex，免得被當 soft 404 收錄
  // 空脈絡（政見都被拿掉了）也標 noindex：頁面照常 200、舊網址不 404，只是不收錄（lib/lineage.ts 的 isLineageListed）
  noindex: () => !loading.value && !lineageLoading.value && (!lineage.value || !isLineageListed(lineage.value)),
  jsonLd: () => lineage.value ? {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: lineage.value.title,
    ...(lineage.value.summary ? { description: lineage.value.summary } : {}),
    url: `${SITE_URL}${lineagePath(lineage.value.id)}`,
    inLanguage: 'zh-TW',
    ...(lineage.value.category ? { genre: lineage.value.category } : {}),
    spatialCoverage: place.value,
    hasPart: lineagePolicies.value.map((p) => ({ '@type': 'CreativeWork', name: p.title, url: `${SITE_URL}/policy/${p.id}` })),
    ...(lineage.value.updatedAt ? { dateModified: lineage.value.updatedAt } : {}),
    publisher: PUBLISHER_LD,
    license: DATA_LICENSE_URL,
    isAccessibleForFree: true,
  } : undefined,
  breadcrumbs: () => breadcrumbs.value,
})
</script>

<template>
  <div v-if="lineage" class="bg-slate-50 min-h-screen" data-testid="lineage-page">
    <Hero>
      <template #icon><Waypoints :size="400" class="text-blue-500" /></template>
      <template #title>
        <span class="block text-base md:text-lg font-bold text-blue-300 tracking-normal mb-2">{{ LINEAGE_NAME }}</span>
        {{ lineage.title }}
      </template>
      <template #actions>
        <button @click="router.go(-1)" class="group inline-flex items-center justify-center w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white" :aria-label="T.back">
          <ChevronLeft :size="20" class="group-hover:-translate-x-1 transition-transform" />
        </button>
        <span class="bg-white/15 px-3 py-1 rounded-full text-sm font-bold" data-testid="lineage-host">{{ T.hosted }}　{{ LEVEL_LABEL[lineage.level] }}　{{ place }}</span>
        <span v-if="coverage.length > 0" class="bg-white/15 px-3 py-1 rounded-full text-sm font-bold" data-testid="lineage-coverage">{{ T.coverage }}　{{ coverage.slice(0, COVERAGE_SHOWN).join('、') }}<template v-if="coverage.length > COVERAGE_SHOWN">　{{ T.coverageMore }} {{ coverage.length - COVERAGE_SHOWN }} {{ T.coverageUnit }}</template></span>
        <span v-if="lineage.category" class="bg-white/15 px-3 py-1 rounded-full text-sm font-bold">{{ lineage.category }}</span>
        <RouterLink v-for="k in uppers" :key="k.id" :to="lineagePath(k.lineageId)" class="bg-white/15 hover:bg-white/25 px-3 py-1 rounded-full text-sm font-bold" data-testid="lineage-belongs-to">{{ T.belongsTo }}　{{ k.title }}</RouterLink>
      </template>
      <template #default>
        <Breadcrumbs :items="breadcrumbs" />
      </template>
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-8 text-left">
        <div class="lg:col-span-2 space-y-6">
          <!-- 現況：階段、一句、截至日、出處；還沒有就寫「尚無現況紀錄」 -->
          <section class="bg-white p-6 sm:p-8 rounded-xl border border-slate-200 shadow-sm" data-testid="lineage-status">
            <h2 class="text-xl font-bold text-navy-900 mb-3 flex items-center gap-2"><Activity class="text-slate-400" :size="22" />{{ T.status }}</h2>
            <template v-if="lineage.status">
              <p class="text-slate-800 leading-relaxed break-words">
                <span v-if="statusPhaseLabel(lineage.status.phase)" class="inline-block mr-2 px-2 py-0.5 rounded text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200">{{ statusPhaseLabel(lineage.status.phase) }}</span>{{ lineage.status.text }}
              </p>
              <p class="mt-2 text-xs text-slate-500 break-words">
                {{ T.asOf }} {{ lineage.status.asOf }}<span class="text-slate-300">｜</span>{{ T.source }}：<LineageSourceLink :source="lineage.status.source" :url="lineage.status.sourceUrl" />
              </p>
            </template>
            <p v-else class="text-sm text-slate-500">{{ T.statusEmpty }}</p>
          </section>

          <!-- 這件事：摘要與出處；沒有摘要就不印 -->
          <section v-if="lineage.summary" class="bg-white p-6 sm:p-8 rounded-xl border border-slate-200 shadow-sm" data-testid="lineage-summary">
            <h2 class="text-xl font-bold text-navy-900 mb-3 flex items-center gap-2"><FileText class="text-slate-400" :size="22" />{{ T.summary }}</h2>
            <p class="text-slate-800 leading-relaxed break-words">{{ lineage.summary }}</p>
            <ol v-if="(lineage.sources ?? []).length > 0" class="mt-3 space-y-1 text-xs text-slate-500 list-decimal list-inside">
              <li v-for="(src, i) in lineage.sources" :key="`${i}:${src.url}`" class="break-words">{{ T.source }}：<LineageSourceLink :source="src" :url="src.url" /></li>
            </ol>
          </section>

          <!-- 各方立場：每人最新一筆；只有政見沒有表態的人標「提出政見」 -->
          <section class="bg-white p-6 sm:p-8 rounded-xl border border-slate-200 shadow-sm" data-testid="lineage-stances">
            <h2 class="text-xl font-bold text-navy-900 mb-4 flex items-center gap-2"><Scale class="text-slate-400" :size="22" />{{ T.stances }}</h2>
            <ul v-if="stanceRows.length > 0" class="divide-y divide-slate-100">
              <li v-for="row in stanceRows" :key="row.key" class="py-3 first:pt-0 last:pb-0" data-testid="lineage-stance-row" :data-kind="row.kind">
                <div class="flex flex-wrap items-center gap-2">
                  <span v-if="row.level" class="text-xs text-slate-500">{{ LEVEL_LABEL[row.level] }}<template v-if="row.region">　{{ row.region }}</template></span>
                  <RouterLink :to="`/politician/${row.politicianId}`" class="inline-flex items-center gap-2 font-bold text-navy-900 hover:text-blue-700 hover:underline">
                    <Avatar :src="personById.get(row.politicianId)?.avatarUrl" :name="row.name" size="xs" />{{ row.name || T.unnamed }}
                  </RouterLink>
                  <span v-if="row.stance" :class="['px-2 py-0.5 rounded text-xs font-bold', STANCE_BADGE[row.stance]]">{{ STANCE_LABEL[row.stance] }}</span>
                  <span v-else class="px-2 py-0.5 rounded text-xs font-bold bg-slate-100 text-slate-500 border border-slate-200">{{ T.derivedStance }}</span>
                  <span v-if="row.changed" class="px-2 py-0.5 rounded text-xs font-bold bg-slate-50 text-slate-600 border border-slate-300">{{ T.changedStance }}</span>
                  <span v-if="row.disputed" class="px-2 py-0.5 rounded text-xs font-bold bg-red-50 text-red-700 border border-red-200" data-testid="lineage-disputed">{{ T.disputed }}</span>
                  <span v-if="row.date" class="text-xs text-slate-500 tabular-nums">{{ formatStatedDate(row.date, row.datePrecision) }}</span>
                </div>
                <p v-if="row.condition" class="mt-1 text-sm text-slate-700 break-words">{{ row.condition }}</p>
                <p class="mt-1 text-xs text-slate-500 break-words">
                  <template v-if="row.kind === 'recorded'">{{ T.source }}：<LineageSourceLink :source="row.source" :url="row.sourceUrl" /></template>
                  <template v-else-if="row.policyId">{{ T.source }}：<RouterLink :to="`/policy/${row.policyId}`" class="text-blue-700 underline underline-offset-2">{{ lineagePolicies.find((p) => String(p.id) === row.policyId)?.title ?? T.policies }}</RouterLink></template>
                </p>
              </li>
            </ul>
            <p v-else class="text-sm text-slate-500">{{ T.stancesEmpty }}</p>
          </section>

          <!-- 大事記：事件與交接，新到舊；最近幾筆先印，其餘收在「更多」 -->
          <section class="bg-white p-6 sm:p-8 rounded-xl border border-slate-200 shadow-sm" data-testid="lineage-chronicle">
            <h2 class="text-xl font-bold text-navy-900 mb-4 flex items-center gap-2"><CalendarClock class="text-slate-400" :size="22" />{{ T.chronicle }}</h2>
            <template v-for="(group, gi) in [{ key: 'head', items: chronicleHead }, { key: 'rest', items: chronicleRest }]" :key="group.key">
              <component :is="gi === 0 ? 'div' : 'details'" v-if="group.items.length > 0" :class="gi === 0 ? '' : 'mt-4'">
                <summary v-if="gi === 1" class="cursor-pointer text-sm font-bold text-blue-700">{{ T.chronicleMore }} {{ group.items.length }} {{ T.unitItem }}</summary>
                <ol :class="['space-y-4', gi === 1 ? 'mt-4' : '']">
                  <li v-for="item in group.items" :key="item.key" class="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3" :data-testid="item.kind === 'event' ? 'lineage-event' : 'lineage-handover'">
                    <template v-if="item.kind === 'event'">
                      <div class="flex flex-wrap items-center gap-2 mb-1">
                        <span class="px-2 py-0.5 rounded text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200">{{ EVENT_TYPE_LABEL[item.event.eventType] }}</span>
                        <span class="text-xs text-slate-500 tabular-nums">{{ formatStatedDate(item.date, item.precision) }}</span>
                        <span class="text-xs text-slate-500">{{ lineagePlace(item.event) }}　{{ item.event.decidedBy }}</span>
                        <span v-if="item.event.disputed" class="px-2 py-0.5 rounded text-xs font-bold bg-red-50 text-red-700 border border-red-200" data-testid="lineage-disputed">{{ T.disputed }}</span>
                      </div>
                      <p class="text-sm text-slate-800 leading-relaxed break-words">{{ item.event.description }}</p>
                      <p v-if="item.event.initiator" class="mt-1 text-xs text-slate-500 break-words">
                        <RouterLink :to="`/politician/${item.event.initiator.politicianId}`" class="font-bold hover:underline">{{ item.event.initiator.name || nameOf(item.event.initiator.politicianId) }}</RouterLink><template v-if="item.event.initiator.note">　{{ item.event.initiator.note }}</template>
                      </p>
                      <p class="mt-1 text-xs text-slate-500 break-words">{{ T.source }}：<LineageSourceLink :source="item.event.source" :url="item.event.sourceUrl" /></p>
                    </template>
                    <template v-else>
                      <div class="flex flex-wrap items-center gap-2 mb-1" :data-type="item.handover.handoverType">
                        <span :class="['px-2 py-0.5 rounded text-xs font-bold', HANDOVER_BADGE[item.handover.handoverType]]">{{ HANDOVER_LABEL[item.handover.handoverType] }}</span>
                        <span v-if="item.date" class="text-xs text-slate-500 tabular-nums">{{ item.date }}</span>
                        <span class="text-sm text-slate-700">
                          <RouterLink :to="`/politician/${item.handover.fromPoliticianId}`" class="font-bold hover:underline">{{ item.handover.fromName || nameOf(item.handover.fromPoliticianId) }}</RouterLink>
                          <ArrowRight :size="14" class="inline mx-1 text-slate-400" />
                          <RouterLink :to="`/politician/${item.handover.toPoliticianId}`" class="font-bold hover:underline">{{ item.handover.toName || nameOf(item.handover.toPoliticianId) }}</RouterLink>
                        </span>
                      </div>
                      <p class="text-sm text-slate-700 leading-relaxed break-words">{{ item.handover.note }}</p>
                      <p class="mt-1 text-xs text-slate-500 break-words">
                        <template v-if="item.handover.sourceLocator">{{ T.handoverBasis }}：{{ item.handover.sourceLocator }}<span class="text-slate-300">｜</span></template>
                        {{ T.source }}：<LineageSourceLink :source="item.handover.source" :url="item.handover.sourceUrl" />
                      </p>
                    </template>
                  </li>
                </ol>
              </component>
            </template>
            <p v-if="showHandovers && lineage.handovers.length === 0" class="mt-4 text-sm text-slate-500" data-testid="lineage-handover-missing">{{ T.handoverMissing }}</p>
            <p v-if="chronicle.length === 0 && !showHandovers" class="text-sm text-slate-500">{{ T.chronicleEmpty }}</p>
          </section>

          <!-- 筆數列：標籤，不是說明；0 也印 -->
          <section class="bg-white px-6 py-4 rounded-xl border border-slate-200 shadow-sm text-sm font-bold text-slate-700" data-testid="lineage-counts">
            {{ T.countPolicies }} {{ counts.policies }} {{ T.unitPolicy }}<span class="text-slate-300 mx-2">｜</span>{{ T.countHandovers }} {{ counts.handovers }} {{ T.unitItem }}<span class="text-slate-300 mx-2">｜</span>{{ T.countEvents }} {{ counts.events }} {{ T.unitItem }}<span class="text-slate-300 mx-2">｜</span>{{ T.countStances }} {{ counts.stances }} {{ T.unitItem }}
          </section>

          <!-- 脈絡裡的政見：只有當選後的政見（視圖只給這些），依人與屆別分組 -->
          <section class="bg-white p-6 sm:p-8 rounded-xl border border-slate-200 shadow-sm" data-testid="lineage-timeline">
            <h2 class="text-xl font-bold text-navy-900 mb-5 flex items-center gap-2"><FileText class="text-slate-400" :size="22" />{{ T.policies }}</h2>
            <ol v-if="timeline.length > 0" class="relative border-l-2 border-slate-200 ml-2 space-y-6">
              <li v-for="item in timeline" :key="item.key" class="pl-6 relative">
                <template v-if="item.kind === 'term'">
                  <span class="absolute -left-[9px] top-1.5 w-4 h-4 rounded-full bg-white border-4 border-blue-500"></span>
                  <div class="flex flex-wrap items-center gap-2 mb-2">
                    <span v-if="item.year" class="text-xs font-black text-slate-500 tabular-nums">{{ electionShortName(item.electionId) ?? item.year }}</span>
                    <RouterLink :to="`/politician/${item.politicianId}`" class="inline-flex items-center gap-2 font-bold text-navy-900 hover:text-blue-700 hover:underline">
                      <Avatar :src="personById.get(item.politicianId)?.avatarUrl" :name="nameOf(item.politicianId) || ''" size="xs" />
                      {{ nameOf(item.politicianId) || T.unnamed }}
                    </RouterLink>
                    <span v-if="officeOf(item.politicianId, item.electionId)" class="text-xs text-slate-500">{{ officeOf(item.politicianId, item.electionId) }}</span>
                  </div>
                  <ul class="space-y-2">
                    <li v-for="p in item.policies" :key="p.id" class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <RouterLink :to="`/policy/${p.id}`" class="font-bold text-blue-700 hover:underline break-words">{{ p.title }}</RouterLink>
                      <span class="ml-2 text-xs text-slate-500 whitespace-nowrap">{{ policyMeta(p, policyStatusLabel, stageOfPolicy(p, personById.get(item.politicianId), (id) => electionDates.get(id), today)) }}</span>
                    </li>
                  </ul>
                </template>
              </li>
            </ol>
            <p v-else class="text-sm text-slate-500">{{ T.policiesEmpty }}</p>
          </section>

          <!-- 同級多人：參與者與角色 -->
          <section class="bg-white p-6 sm:p-8 rounded-xl border border-slate-200 shadow-sm" data-testid="lineage-participants">
            <h2 class="text-xl font-bold text-navy-900 mb-5 flex items-center gap-2"><Users class="text-slate-400" :size="22" />{{ T.participants }}</h2>
            <ul class="divide-y divide-slate-100">
              <li v-for="row in people" :key="row.politicianId" class="py-3 first:pt-0 last:pb-0 sm:grid sm:grid-cols-[11rem_1fr] sm:gap-4" data-testid="lineage-participant">
                <RouterLink :to="`/politician/${row.politicianId}`" class="flex items-center gap-2 font-bold text-navy-900 hover:text-blue-700 hover:underline mb-1 sm:mb-0">
                  <Avatar :src="personById.get(row.politicianId)?.avatarUrl" :name="row.name" size="xs" />{{ row.name }}
                </RouterLink>
                <div class="min-w-0 space-y-1 text-sm">
                  <p v-if="row.official" class="break-words">
                    <span class="inline-block px-2 py-0.5 rounded text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200">{{ ROLE_LABEL[row.official.role] }}</span>
                    <span class="ml-1 text-xs text-slate-500">{{ BASIS_LABEL.official_record }}：{{ row.official.sourceLocator }}｜<LineageSourceLink :source="row.official.source" :url="row.official.sourceUrl" /></span>
                  </p>
                  <p v-if="row.claim" class="break-words">
                    <span class="inline-block px-2 py-0.5 rounded text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200">{{ BASIS_LABEL.self_claim }}：{{ ROLE_LABEL[row.claim.role] }}</span>
                    <span class="ml-1 text-xs text-slate-500">{{ row.claim.sourceLocator }}｜<LineageSourceLink :source="row.claim.source" :url="row.claim.sourceUrl" /></span>
                  </p>
                  <p v-if="!row.official && !row.claim" class="text-xs text-slate-500">
                    <span class="inline-block px-2 py-0.5 rounded font-bold bg-slate-50 text-slate-500 border border-dashed border-slate-300">{{ proposerBadge(row.politicianId) }}</span>
                    <span v-if="row.representative" class="ml-1">{{ T.noOfficialRole }}</span>
                  </p>
                  <p v-if="row.policyCount > 0" class="text-xs text-slate-500">{{ T.countPolicies }} {{ row.policyCount }} {{ T.unitPolicy }}</p>
                  <p v-if="row.official?.note || row.claim?.note" class="text-xs text-slate-500 break-words">{{ row.official?.note || row.claim?.note }}</p>
                </div>
              </li>
            </ul>
            <p v-if="people.length === 0" class="text-sm text-slate-500">{{ T.participantsEmpty }}</p>
          </section>
        </div>

        <aside class="lg:col-span-1 space-y-6">
          <!-- 上下級 -->
          <section class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm" data-testid="lineage-links">
            <h2 class="text-lg font-bold text-navy-900 mb-4 flex items-center gap-2"><GitFork class="text-slate-400" :size="20" />{{ T.links }}</h2>
            <template v-for="group in [{ key: 'upper', label: T.upper, list: uppers }, { key: 'lower', label: T.lower, list: lowers }]" :key="group.key">
              <div v-if="group.list.length > 0" class="mb-4 last:mb-0">
                <h3 class="text-sm font-bold text-slate-600 mb-2">{{ group.label }}</h3>
                <ul class="space-y-3">
                  <li v-for="k in group.list" :key="k.id" class="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <RouterLink :to="lineagePath(k.lineageId)" class="font-bold text-blue-700 hover:underline break-words">{{ k.title }}</RouterLink>
                    <p class="text-xs text-slate-500 mt-0.5">{{ LEVEL_LABEL[k.level] }}・{{ lineagePlace(k) }}・{{ LINK_LABEL[k.linkType] }}</p>
                    <p class="text-sm text-slate-700 mt-1 break-words">{{ k.note }}</p>
                    <p class="text-xs text-slate-500 mt-1 break-words">
                      <template v-if="k.sourceLocator">{{ k.sourceLocator }}｜</template>
                      <LineageSourceLink :source="k.source" :url="k.sourceUrl" />
                    </p>
                  </li>
                </ul>
              </div>
            </template>
            <p v-if="uppers.length === 0 && lowers.length === 0" class="text-sm text-slate-500">{{ T.linksEmpty }}</p>
          </section>
        </aside>
      </div>
    </div>
  </div>

  <div v-else-if="loading || lineageLoading" class="bg-slate-50 min-h-screen flex items-center justify-center">
    <div class="text-center">
      <Loader2 :size="48" class="mx-auto mb-4 text-blue-500 animate-spin" />
      <p class="text-slate-500">{{ T.loading }}</p>
    </div>
  </div>

  <LoadError v-else-if="error" />

  <div v-else class="min-h-screen flex items-center justify-center bg-slate-50">
    <div class="text-center px-4">
      <FileText :size="64" class="mx-auto mb-4 text-slate-300" />
      <h2 class="text-2xl font-bold text-navy-900 mb-6">{{ T.notFound }}</h2>
      <RouterLink to="/analysis" class="px-6 py-2 bg-blue-600 text-white rounded-lg font-bold shadow-lg shadow-blue-500/20 hover:bg-blue-700 transition-all">{{ T.allLineages }}</RouterLink>
    </div>
  </div>
</template>
