<script setup lang="ts">
/**
 * 政策脈絡頁（#349，/lineage/:lineageId）：一件事在某一層級、某一地方的來龍去脈。
 *   前後任：時間軸（一任一任的政見，交接放在後任前面）
 *   同級多人：參與者與角色（官方紀錄為準；本人宣稱另外標）
 *   上下級：這條脈絡的上級、下級脈絡
 * 正見.tw 由 Worker 邊緣渲染（cloudflare/ssr-worker.js），內容在 HTML 裡、連結都是真的 <a href>，canonical 指正見.tw。
 * 顯示規則在 lib/lineage.ts。
 */
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ArrowRight, ChevronLeft, FileText, GitFork, Landmark, Loader2, Users, Waypoints } from 'lucide-vue-next'
import { useSupabase } from '../composables/useSupabase'
import Hero from '../components/Hero.vue'
import Avatar from '../components/Avatar.vue'
import Breadcrumbs from '../components/Breadcrumbs.vue'
import LoadError from '../components/LoadError.vue'
import { usePageHead, DATA_LICENSE_URL, PUBLISHER_LD, SITE_URL, type BreadcrumbItem } from '../composables/usePageHead'
import { policyStatusLabel } from '../composables/usePageHead'
import {
  BASIS_LABEL, buildTimeline, HANDOVER_BADGE, HANDOVER_HINT, HANDOVER_LABEL, LEVEL_LABEL, LINEAGE_EXPLAINER, LINEAGE_NAME,
  lineagePath, lineagePlace, LINK_LABEL, participantRows, policyMeta, ROLE_LABEL, sourceLabel, termRoleLabel,
} from '../lib/lineage'
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
  ]
  await loadPoliticiansByIds(people)
}, { immediate: true })

const personById = computed(() => new Map(politicians.value.map((p) => [String(p.id), p])))
const nameOf = (id: string) => personById.value.get(id)?.name
const electionDates = computed(() => new Map(elections.value.map((e) => [e.id, e.electionDate])))
const electionShortName = (id: number | null) => (id === null ? null : elections.value.find((e) => e.id === id)?.shortName ?? null)

const timeline = computed(() => (lineage.value ? buildTimeline(lineagePolicies.value, lineage.value.handovers, electionDates.value) : []))
const people = computed(() => (lineage.value ? participantRows(lineage.value.participants, lineagePolicies.value, nameOf) : []))
const uppers = computed(() => lineage.value?.links.filter((k) => k.direction === 'upper') ?? [])
const lowers = computed(() => lineage.value?.links.filter((k) => k.direction === 'lower') ?? [])

/** 那一任的職位：當選寫職位、沒當選或還沒投票寫「…參選人」（lib/lineage.ts 的 termRoleLabel） */
function officeOf(politicianId: string, electionId: number | null): string {
  return termRoleLabel(personById.value.get(politicianId), electionId)
}

const place = computed(() => (lineage.value ? lineagePlace(lineage.value) : ''))
const breadcrumbs = computed<BreadcrumbItem[]>(() => (lineage.value
  ? [{ name: LINEAGE_NAME, path: '/analysis' }, ...(lineage.value.region ? [{ name: lineage.value.region }] : []), { name: lineage.value.title }]
  : []))

usePageHead({
  title: () => (lineage.value ? `${lineage.value.title}｜${LINEAGE_NAME}` : LINEAGE_NAME),
  description: () => (lineage.value
    ? `${place.value}「${lineage.value.title}」的政策脈絡：${lineage.value.summary ? `${lineage.value.summary}。` : ''}${lineagePolicies.value.length} 條政見、${lineage.value.handovers.length} 筆前後任交接、${lineage.value.links.length} 條上下級關聯，每一筆附出處。`
    : LINEAGE_EXPLAINER),
  type: 'article',
  // firebase.json 把 /lineage/** rewrite 到殼檔回 200，不存在的 id 也是 200；確定沒資料就標 noindex，免得被當 soft 404 收錄
  noindex: () => !loading.value && !lineageLoading.value && !lineage.value,
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
      <template #description>{{ lineage.summary || LINEAGE_EXPLAINER }}</template>
      <template #actions>
        <button @click="router.go(-1)" class="group inline-flex items-center justify-center w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white" aria-label="返回">
          <ChevronLeft :size="20" class="group-hover:-translate-x-1 transition-transform" />
        </button>
        <span class="bg-white/15 px-3 py-1 rounded-full text-sm font-bold">{{ LEVEL_LABEL[lineage.level] }}</span>
        <span class="bg-white/15 px-3 py-1 rounded-full text-sm font-bold">{{ place }}</span>
        <span v-if="lineage.category" class="bg-white/15 px-3 py-1 rounded-full text-sm font-bold">{{ lineage.category }}</span>
      </template>
    </Hero>
    <Breadcrumbs :items="breadcrumbs" />

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-8 text-left">
        <div class="lg:col-span-2 space-y-6">
          <!-- 前後任：時間軸 -->
          <section class="bg-white p-6 sm:p-8 rounded-xl border border-slate-200 shadow-sm" data-testid="lineage-timeline">
            <h2 class="text-xl font-bold text-navy-900 mb-5 flex items-center gap-2"><Waypoints class="text-slate-400" :size="22" />時間軸：前後任怎麼交接</h2>
            <ol class="relative border-l-2 border-slate-200 ml-2 space-y-6">
              <li v-for="item in timeline" :key="item.key" class="pl-6 relative">
                <template v-if="item.kind === 'term'">
                  <span class="absolute -left-[9px] top-1.5 w-4 h-4 rounded-full bg-white border-4 border-blue-500"></span>
                  <div class="flex flex-wrap items-center gap-2 mb-2">
                    <span v-if="item.year" class="text-xs font-black text-slate-500 tabular-nums">{{ electionShortName(item.electionId) ?? item.year }}</span>
                    <RouterLink :to="`/politician/${item.politicianId}`" class="inline-flex items-center gap-2 font-bold text-navy-900 hover:text-blue-700 hover:underline">
                      <Avatar :src="personById.get(item.politicianId)?.avatarUrl" :name="nameOf(item.politicianId) || ''" size="xs" />
                      {{ nameOf(item.politicianId) || '（姓名待查）' }}
                    </RouterLink>
                    <span v-if="officeOf(item.politicianId, item.electionId)" class="text-xs text-slate-500">{{ officeOf(item.politicianId, item.electionId) }}</span>
                  </div>
                  <ul class="space-y-2">
                    <li v-for="p in item.policies" :key="p.id" class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <RouterLink :to="`/policy/${p.id}`" class="font-bold text-blue-700 hover:underline break-words">{{ p.title }}</RouterLink>
                      <span class="ml-2 text-xs text-slate-500 whitespace-nowrap">{{ policyMeta(p, policyStatusLabel) }}</span>
                    </li>
                  </ul>
                </template>
                <template v-else>
                  <span class="absolute -left-[7px] top-2 w-3 h-3 rounded-full bg-slate-400"></span>
                  <div class="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-3" data-testid="lineage-handover" :data-type="item.handover.handoverType">
                    <div class="flex flex-wrap items-center gap-2 mb-1">
                      <span :class="['px-2 py-0.5 rounded text-xs font-bold', HANDOVER_BADGE[item.handover.handoverType]]">{{ HANDOVER_LABEL[item.handover.handoverType] }}</span>
                      <span class="text-sm text-slate-700">
                        <RouterLink :to="`/politician/${item.handover.fromPoliticianId}`" class="font-bold hover:underline">{{ item.handover.fromName || nameOf(item.handover.fromPoliticianId) }}</RouterLink>
                        <ArrowRight :size="14" class="inline mx-1 text-slate-400" />
                        <RouterLink :to="`/politician/${item.handover.toPoliticianId}`" class="font-bold hover:underline">{{ item.handover.toName || nameOf(item.handover.toPoliticianId) }}</RouterLink>
                      </span>
                      <span class="text-xs text-slate-500">{{ HANDOVER_HINT[item.handover.handoverType] }}</span>
                    </div>
                    <p class="text-sm text-slate-700 leading-relaxed break-words">{{ item.handover.note }}</p>
                    <p class="mt-1 text-xs text-slate-500 break-words">
                      <template v-if="item.handover.decidedOn">判定日期：{{ item.handover.decidedOn }}<span class="text-slate-300">｜</span></template>
                      <template v-if="item.handover.sourceLocator">依據：{{ item.handover.sourceLocator }}<span class="text-slate-300">｜</span></template>
                      出處：<a :href="item.handover.sourceUrl" target="_blank" rel="noopener noreferrer" class="text-blue-700 underline underline-offset-2 break-all">{{ sourceLabel(item.handover.source) || item.handover.sourceUrl }}</a>
                      <template v-if="item.handover.source?.archiveUrl">（<a :href="item.handover.source.archiveUrl" target="_blank" rel="noopener noreferrer" class="text-blue-700 underline underline-offset-2">存檔</a>）</template>
                    </p>
                  </div>
                </template>
              </li>
            </ol>
            <p v-if="lineage.handovers.length === 0" class="mt-5 text-sm text-slate-500 border-t border-slate-100 pt-4">
              還沒有交接紀錄。這個職位換人、前一任卸任之後，系統會派任務請 AI 代理查後任怎麼處理這件事，附出處、其他代理查證後才會出現在這裡。
            </p>
          </section>

          <!-- 同級多人：參與者與角色 -->
          <section class="bg-white p-6 sm:p-8 rounded-xl border border-slate-200 shadow-sm" data-testid="lineage-participants">
            <h2 class="text-xl font-bold text-navy-900 mb-5 flex items-center gap-2"><Users class="text-slate-400" :size="22" />參與者與角色</h2>
            <ul class="divide-y divide-slate-100">
              <li v-for="row in people" :key="row.politicianId" class="py-3 first:pt-0 last:pb-0 sm:grid sm:grid-cols-[11rem_1fr] sm:gap-4" data-testid="lineage-participant">
                <RouterLink :to="`/politician/${row.politicianId}`" class="flex items-center gap-2 font-bold text-navy-900 hover:text-blue-700 hover:underline mb-1 sm:mb-0">
                  <Avatar :src="personById.get(row.politicianId)?.avatarUrl" :name="row.name" size="xs" />{{ row.name }}
                </RouterLink>
                <div class="min-w-0 space-y-1 text-sm">
                  <p v-if="row.official" class="break-words">
                    <span class="inline-block px-2 py-0.5 rounded text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200">{{ ROLE_LABEL[row.official.role] }}</span>
                    <span class="ml-1 text-xs text-slate-500">{{ BASIS_LABEL.official_record }}：{{ row.official.sourceLocator }}｜<a :href="row.official.sourceUrl" target="_blank" rel="noopener noreferrer" class="text-blue-700 underline underline-offset-2 break-all">{{ sourceLabel(row.official.source) || row.official.sourceUrl }}</a></span>
                  </p>
                  <p v-if="row.claim" class="break-words">
                    <span class="inline-block px-2 py-0.5 rounded text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200">{{ BASIS_LABEL.self_claim }}：{{ ROLE_LABEL[row.claim.role] }}</span>
                    <span class="ml-1 text-xs text-slate-500">{{ row.claim.sourceLocator }}｜<a :href="row.claim.sourceUrl" target="_blank" rel="noopener noreferrer" class="text-blue-700 underline underline-offset-2 break-all">{{ sourceLabel(row.claim.source) || row.claim.sourceUrl }}</a></span>
                  </p>
                  <p v-if="!row.official && !row.claim" class="text-xs text-slate-500">
                    <span class="inline-block px-2 py-0.5 rounded font-bold bg-slate-50 text-slate-500 border border-dashed border-slate-300">政見提出者</span>
                    <span class="ml-1">還沒有官方紀錄的角色</span>
                  </p>
                  <p v-if="row.policyCount > 0" class="text-xs text-slate-500">在這條脈絡裡有 {{ row.policyCount }} 條政見</p>
                  <p v-if="row.official?.note || row.claim?.note" class="text-xs text-slate-500 break-words">{{ row.official?.note || row.claim?.note }}</p>
                </div>
              </li>
            </ul>
            <p v-if="people.length === 0" class="text-sm text-slate-500">還沒有參與者的紀錄。</p>
          </section>
        </div>

        <aside class="lg:col-span-1 space-y-6">
          <!-- 上下級 -->
          <section class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm" data-testid="lineage-links">
            <h2 class="text-lg font-bold text-navy-900 mb-1 flex items-center gap-2"><GitFork class="text-slate-400" :size="20" />上下級脈絡</h2>
            <p class="text-xs text-slate-500 mb-4">上級立法或補助、下級執行；或下級先爭取、上級後來採納。上下級是不同的脈絡，各有自己的來龍去脈。</p>
            <template v-for="group in [{ key: 'upper', label: '上級', list: uppers }, { key: 'lower', label: '下級', list: lowers }]" :key="group.key">
              <div v-if="group.list.length > 0" class="mb-4 last:mb-0">
                <h3 class="text-sm font-bold text-slate-600 mb-2">{{ group.label }}</h3>
                <ul class="space-y-3">
                  <li v-for="k in group.list" :key="k.id" class="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <RouterLink :to="lineagePath(k.lineageId)" class="font-bold text-blue-700 hover:underline break-words">{{ k.title }}</RouterLink>
                    <p class="text-xs text-slate-500 mt-0.5">{{ LEVEL_LABEL[k.level] }}・{{ lineagePlace(k) }}・{{ LINK_LABEL[k.linkType] }}</p>
                    <p class="text-sm text-slate-700 mt-1 break-words">{{ k.note }}</p>
                    <p class="text-xs text-slate-500 mt-1 break-words">
                      <template v-if="k.sourceLocator">{{ k.sourceLocator }}｜</template>
                      <a :href="k.sourceUrl" target="_blank" rel="noopener noreferrer" class="text-blue-700 underline underline-offset-2 break-all">{{ sourceLabel(k.source) || k.sourceUrl }}</a>
                    </p>
                  </li>
                </ul>
              </div>
            </template>
            <p v-if="uppers.length === 0 && lowers.length === 0" class="text-sm text-slate-500">還沒有上下級關聯。</p>
          </section>

          <section class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h2 class="text-lg font-bold text-navy-900 mb-2 flex items-center gap-2"><Landmark class="text-slate-400" :size="20" />什麼是政策脈絡</h2>
            <p class="text-sm text-slate-600 leading-relaxed">{{ LINEAGE_EXPLAINER }}</p>
            <RouterLink to="/analysis" class="mt-3 inline-flex items-center gap-1 text-sm font-bold text-blue-700 hover:underline">所有政策脈絡 <ArrowRight :size="14" /></RouterLink>
          </section>
        </aside>
      </div>
    </div>
  </div>

  <div v-else-if="loading || lineageLoading" class="bg-slate-50 min-h-screen flex items-center justify-center">
    <div class="text-center">
      <Loader2 :size="48" class="mx-auto mb-4 text-blue-500 animate-spin" />
      <p class="text-slate-500">載入中...</p>
    </div>
  </div>

  <LoadError v-else-if="error" />

  <div v-else class="min-h-screen flex items-center justify-center bg-slate-50">
    <div class="text-center px-4">
      <FileText :size="64" class="mx-auto mb-4 text-slate-300" />
      <h2 class="text-2xl font-bold text-navy-900 mb-2">找不到這條政策脈絡</h2>
      <p class="text-slate-500 mb-6">它可能已被移除或連結錯誤。</p>
      <RouterLink to="/analysis" class="px-6 py-2 bg-blue-600 text-white rounded-lg font-bold shadow-lg shadow-blue-500/20 hover:bg-blue-700 transition-all">所有政策脈絡</RouterLink>
    </div>
  </div>
</template>
