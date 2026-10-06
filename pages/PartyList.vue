<script setup lang="ts">
/**
 * 政黨一覽（#346 第一階段，/parties）：正見收錄的人物裡有人屬於它的政黨。
 * 依名稱筆畫排，**不依人數、席次排**；無黨籍不是政黨，不列（日本站同一個原則）。
 * 政黨資料是內政部政黨名冊（parties，id＝政黨編號）；名冊查無此名稱的另一段列。
 * 預渲染、進網站地圖、canonical 指正見.tw；從站內別頁換頁進來沒有快照就整頁載入（lib/full-load.ts）。
 */
import { computed, onMounted, ref } from 'vue'
import { Flag } from 'lucide-vue-next'
import Hero from '../components/Hero.vue'
import Breadcrumbs from '../components/Breadcrumbs.vue'
import PartyBadge from '../components/PartyBadge.vue'
import { useSupabase } from '../composables/useSupabase'
import { usePageHead, PUBLISHER_LD, SITE_URL, type BreadcrumbItem } from '../composables/usePageHead'
import { partyStatusText } from '../lib/parties'
import { reloadForPrerendered } from '../lib/full-load'
import type { PartySummary } from '../lib/party-pages'

const { partyList } = useSupabase()
const reloading = ref(false)
onMounted(() => {
  if (!partyList.value) reloading.value = reloadForPrerendered('/parties')
})

const registered = computed(() => (partyList.value ?? []).filter((p) => p.moiNo !== null))
const unregistered = computed(() => (partyList.value ?? []).filter((p) => p.moiNo === null))
const status = (p: PartySummary) => partyStatusText({ moi_no: p.moiNo, moi_status: p.moiStatus })

const breadcrumbs: BreadcrumbItem[] = [{ name: '首頁', path: '/' }, { name: '政黨一覽' }]
usePageHead({
  title: '政黨一覽',
  description: () => `正見收錄的人物所屬的 ${registered.value.length} 個政黨（內政部政黨名冊）：各黨的現職首長、民意代表與歷屆參選人。依名稱筆畫排列，不排名。`,
  breadcrumbs,
  jsonLd: () => ({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: '政黨一覽',
    url: `${SITE_URL}/parties`,
    publisher: PUBLISHER_LD,
    itemListElement: (partyList.value ?? []).map((p, i) => ({ '@type': 'ListItem', position: i + 1, name: p.name, url: `${SITE_URL}/party/${p.id}` })),
  }),
})
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20" data-testid="party-list">
    <Hero>
      <template #title>政黨一覽</template>
      <template #description>正見收錄的人物所屬的政黨。點進去看各黨的現職首長、民意代表與歷屆參選人；依名稱筆畫排列，不依人數或席次排名。</template>
      <template #icon><Flag :size="400" class="text-blue-500" /></template>
    </Hero>
    <Breadcrumbs :items="breadcrumbs" />

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 text-left">
      <div v-if="!partyList" class="text-slate-500 text-center py-20">{{ reloading ? '載入中…' : '這一頁在建置網站時產生，請重新整理。' }}</div>
      <template v-else>
        <p class="text-sm text-slate-600 bg-white border border-slate-200 rounded-xl p-4 mb-8 leading-relaxed">
          政黨名稱與狀態依<a href="https://party.moi.gov.tw/PartyMain.aspx?n=16100&amp;sms=13073" target="_blank" rel="noopener" class="text-blue-700 hover:underline">內政部政黨資訊網的政黨名冊</a>。
          人物照他目前登記的政黨歸到各黨；無黨籍（中選會名冊寫成「無黨籍及未經政黨推薦」）不是政黨，這裡不列。
        </p>

        <section aria-labelledby="registered-h" class="mb-12">
          <h2 id="registered-h" class="text-2xl font-black text-navy-900 mb-4">內政部政黨名冊上的政黨</h2>
          <ul class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <li v-for="p in registered" :key="p.id">
              <a :href="`/party/${p.id}`" class="flex items-center gap-3 bg-white rounded-xl border border-slate-200 shadow-sm p-4 hover:shadow-md hover:border-blue-300 transition">
                <PartyBadge :party="p.name" :size="8" class="shrink-0" />
                <span class="min-w-0">
                  <span class="block font-bold text-navy-900">{{ p.name }}<span v-if="p.shortName" class="ml-1 text-sm font-normal text-slate-500">（{{ p.shortName }}）</span></span>
                  <span class="block text-xs text-slate-500">政黨編號 {{ p.moiNo }}<template v-if="status(p)">・{{ status(p) }}</template></span>
                </span>
              </a>
            </li>
          </ul>
        </section>

        <section v-if="unregistered.length" aria-labelledby="unregistered-h">
          <h2 id="unregistered-h" class="text-2xl font-black text-navy-900 mb-2">名冊查無此名稱的政黨名稱</h2>
          <p class="text-sm text-slate-600 mb-4">資料裡有人登記這些政黨名稱參選，但內政部政黨名冊（擷取日）找不到同名的政黨，多半是已經改名或解散的舊名稱，待查證。</p>
          <ul class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <li v-for="p in unregistered" :key="p.id">
              <a :href="`/party/${p.id}`" class="block bg-white rounded-xl border border-slate-200 shadow-sm p-4 hover:shadow-md hover:border-blue-300 transition">
                <span class="block font-bold text-navy-900">{{ p.name }}</span>
                <span v-if="p.successor" class="block text-xs text-slate-500">已改名為「{{ p.successor.name }}」</span>
                <span v-else class="block text-xs text-slate-500">名冊查無此名稱</span>
              </a>
            </li>
          </ul>
        </section>
      </template>
    </div>
  </div>
</template>
