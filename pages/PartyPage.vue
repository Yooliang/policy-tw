<script setup lang="ts">
/**
 * 各黨頁（#346 第一階段，/party/:partyId，id＝內政部政黨編號）：現職首長、現職民代、歷屆參選人。
 * **不排名**：同一塊依職位、地區、姓名筆畫排，不依當選與否、人數或政見數排；不做勝率、席次排行（日本站同一個原則）。
 * 第一階段依人物目前登記的政黨歸到各黨（跟選舉頁卡片上的政黨同一個依據），參選當時的政黨第二階段補齊後改用。
 * 一組人很多時預設收合（<details>）：內容照樣在預渲染的 HTML 裡、連結照樣是真的 <a href>。
 */
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ExternalLink, Flag, Landmark, Users, Vote } from 'lucide-vue-next'
import Hero from '../components/Hero.vue'
import Breadcrumbs from '../components/Breadcrumbs.vue'
import PartyBadge from '../components/PartyBadge.vue'
import { useSupabase } from '../composables/useSupabase'
import { usePageHead, PUBLISHER_LD, SITE_URL, type BreadcrumbItem } from '../composables/usePageHead'
import { partyStatusText } from '../lib/parties'
import { partyEmblem } from '../lib/party'
import { OPEN_GROUP_MAX, type PartyGroup } from '../lib/party-pages'
import { reloadForPrerendered } from '../lib/full-load'

const MOI_REGISTRY = 'https://party.moi.gov.tw/PartyMain.aspx?n=16100&sms=13073'

const route = useRoute()
const { partyPage } = useSupabase()
const partyId = computed(() => Number(route.params.partyId))
const page = computed(() => (partyPage.value && partyPage.value.party.id === partyId.value ? partyPage.value : null))
const party = computed(() => page.value?.party ?? null)
const reloading = ref(false)
onMounted(() => {
  if (!page.value && Number.isInteger(partyId.value)) reloading.value = reloadForPrerendered(route.fullPath)
})

const fmt = (n: number) => n.toLocaleString('zh-TW')
const count = (groups: PartyGroup[]) => groups.reduce((n, g) => n + g.people.length, 0)
const statusText = computed(() => (party.value ? partyStatusText({ moi_no: party.value.moiNo, moi_status: party.value.moiStatus }) : null))
const emblem = computed(() => (party.value ? partyEmblem(party.value.name) : null))
const headCount = computed(() => (page.value ? count(page.value.heads) : 0))
const councilCount = computed(() => (page.value ? count(page.value.councils) : 0))

const breadcrumbs = computed<BreadcrumbItem[]>(() => [
  { name: '首頁', path: '/' },
  { name: '政黨一覽', path: '/parties' },
  { name: party.value?.name ?? '政黨' },
])

usePageHead({
  title: () => (party.value ? `${party.value.name}｜政黨` : '政黨'),
  description: () => {
    if (!page.value || !party.value) return '政黨：現職首長、民意代表與歷屆參選人。'
    const years = page.value.elections.map((e) => e.shortName).join('、')
    return `${party.value.name}${party.value.shortName ? `（${party.value.shortName}）` : ''}在正見收錄的人物：現職首長 ${headCount.value} 位、現職民意代表 ${councilCount.value} 位，${years}的參選人。`
  },
  noindex: () => !page.value && !reloading.value,
  breadcrumbs: () => breadcrumbs.value,
  jsonLd: () => (party.value
    ? {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        additionalType: 'https://schema.org/PoliticalParty',
        name: party.value.name,
        ...(party.value.shortName ? { alternateName: party.value.shortName } : {}),
        ...(party.value.validFrom ? { foundingDate: party.value.validFrom } : {}),
        url: `${SITE_URL}/party/${party.value.id}`,
        subjectOf: { '@type': 'WebPage', url: `${SITE_URL}/party/${party.value.id}`, publisher: PUBLISHER_LD },
      }
    : undefined),
})
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20" data-testid="party-page">
    <Hero>
      <template #title>{{ party?.name ?? '政黨' }}</template>
      <template #description>
        <template v-if="page">這個政黨在正見收錄的人物：現職首長、現職民意代表與歷屆參選人。</template>
        <template v-else>政黨：現職首長、民意代表與歷屆參選人。</template>
      </template>
      <template v-if="emblem && party" #logo>
        <!-- 黨徽放在白底方塊上：頁首是深色底，有些黨徽是深色或透明底，直接放會看不清楚 -->
        <span class="inline-flex items-center justify-center w-20 h-20 md:w-24 md:h-24 rounded-2xl bg-white p-2 shadow-lg" data-testid="party-emblem">
          <img :src="emblem" :alt="`${party.name}黨徽`" class="w-full h-full object-contain" />
        </span>
      </template>
      <template #icon><Flag :size="400" class="text-blue-500" /></template>
    </Hero>
    <Breadcrumbs :items="breadcrumbs" />

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 text-left">
      <div v-if="!page" class="text-slate-500 text-center py-20">
        <template v-if="reloading">載入中…</template>
        <template v-else>這個政黨的頁面還沒產生（政黨頁在建置網站時產生）。<a href="/parties" class="text-blue-700 hover:underline">回政黨一覽</a></template>
      </div>

      <template v-else-if="party">
        <!-- 基本資料 -->
        <section class="bg-white rounded-xl border border-slate-200 shadow-sm p-6 mb-8" aria-labelledby="party-facts-h">
          <h2 id="party-facts-h" class="sr-only">基本資料</h2>
          <div class="flex items-start gap-4">
            <PartyBadge :party="party.name" :size="8" class="shrink-0 mt-1" />
            <dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-sm flex-1">
              <div v-if="party.shortName"><dt class="inline text-slate-500">簡稱：</dt><dd class="inline text-slate-800 font-semibold">{{ party.shortName }}</dd></div>
              <div v-if="party.moiNo !== null"><dt class="inline text-slate-500">內政部政黨編號：</dt><dd class="inline text-slate-800 font-semibold">{{ party.moiNo }}</dd></div>
              <div v-if="party.moiStatus"><dt class="inline text-slate-500">名冊上的狀態：</dt><dd class="inline text-slate-800 font-semibold">{{ party.moiStatus }}</dd></div>
              <div v-if="party.validFrom"><dt class="inline text-slate-500">成立日期（名冊）：</dt><dd class="inline text-slate-800 font-semibold">{{ party.validFrom }}</dd></div>
              <div v-if="party.predecessor">
                <dt class="inline text-slate-500">前身：</dt>
                <dd class="inline"><a :href="`/party/${party.predecessor.id}`" class="text-blue-700 hover:underline font-semibold">{{ party.predecessor.name }}</a></dd>
              </div>
              <div v-if="party.successor">
                <dt class="inline text-slate-500">改名為：</dt>
                <dd class="inline"><a :href="`/party/${party.successor.id}`" class="text-blue-700 hover:underline font-semibold">{{ party.successor.name }}</a></dd>
              </div>
            </dl>
          </div>
          <p v-if="statusText && party.moiNo === null" class="mt-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{{ statusText }}。{{ party.note }}</p>
          <p v-else-if="party.note" class="mt-4 text-sm text-slate-600">{{ party.note }}</p>
          <p class="mt-4 text-xs text-slate-500 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>出處：</span>
            <a :href="MOI_REGISTRY" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-blue-700 hover:underline">內政部政黨資訊網 政黨名冊<ExternalLink :size="12" /></a>
            <a v-if="party.evidenceUrl" :href="party.evidenceUrl" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-blue-700 hover:underline">內政部政黨資訊網 該政黨頁<ExternalLink :size="12" /></a>
          </p>
        </section>

        <!-- 現職首長、現職民代 -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
          <section v-for="block in [{ key: 'heads', title: '現職首長', icon: Landmark, groups: page.heads, n: headCount }, { key: 'councils', title: '現職民意代表', icon: Users, groups: page.councils, n: councilCount }]"
                   :key="block.key" class="bg-white rounded-xl border border-slate-200 shadow-sm p-6" :aria-labelledby="`${block.key}-h`">
            <h2 :id="`${block.key}-h`" class="text-xl font-black text-navy-900 mb-4 flex items-center gap-2">
              <component :is="block.icon" :size="20" class="text-slate-400" />{{ block.title }}<span class="text-sm font-semibold text-slate-500">{{ fmt(block.n) }} 位</span>
            </h2>
            <p v-if="block.groups.length === 0" class="text-sm text-slate-500">目前沒有。</p>
            <details v-for="g in block.groups" :key="g.type" :open="g.people.length <= OPEN_GROUP_MAX" class="mb-3 group">
              <summary class="cursor-pointer select-none font-bold text-slate-800 py-1">{{ g.label }}<span class="ml-1 text-sm font-normal text-slate-500">（{{ fmt(g.people.length) }} 位）</span></summary>
              <ul class="dir-list mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                <li v-for="p in g.people" :key="p.id"><RouterLink :to="`/politician/${p.id}`" class="dn">{{ p.name }}</RouterLink><span class="dl">{{ p.what }}</span></li>
              </ul>
            </details>
          </section>
        </div>

        <!-- 歷屆參選人 -->
        <section aria-labelledby="candidates-h">
          <h2 id="candidates-h" class="text-2xl font-black text-navy-900 mb-4 flex items-center gap-2"><Vote :size="22" class="text-slate-400" />歷屆參選人</h2>
          <p v-if="page.elections.length === 0" class="text-sm text-slate-500">沒有參選紀錄。</p>
          <section v-for="e in page.elections" :key="e.electionId" class="bg-white rounded-xl border border-slate-200 shadow-sm p-6 mb-6" :aria-labelledby="`election-${e.electionId}-h`">
            <h3 :id="`election-${e.electionId}-h`" class="text-lg font-black text-navy-900 mb-3">
              <RouterLink :to="`/election/${e.electionId}`" class="hover:text-blue-700">{{ e.name }}</RouterLink>
              <span class="ml-2 text-sm font-semibold text-slate-500">投票日 {{ e.electionDate }}・{{ fmt(e.count) }} 位</span>
            </h3>
            <details v-for="g in e.groups" :key="g.type" :open="g.people.length <= OPEN_GROUP_MAX" class="mb-3">
              <summary class="cursor-pointer select-none font-bold text-slate-800 py-1">{{ g.label }}<span class="ml-1 text-sm font-normal text-slate-500">（{{ fmt(g.people.length) }} 位）</span></summary>
              <ul class="dir-list mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1">
                <li v-for="p in g.people" :key="p.id"><RouterLink :to="`/politician/${p.id}`" class="dn">{{ p.name }}</RouterLink><span class="dl">{{ p.status ? `${p.what}・${p.status}` : p.what }}</span></li>
              </ul>
            </details>
          </section>
        </section>
      </template>
    </div>
  </div>
</template>
