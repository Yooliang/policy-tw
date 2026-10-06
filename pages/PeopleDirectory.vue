<script setup lang="ts">
/**
 * 人物一覽（#346 第一階段，/politicians 與 /politicians/:group）：正見收錄的每一位政治人物的總入口，依姓氏筆畫分組。
 * 索引頁列每一組有哪些姓、幾位；分組頁一個姓一段，姓名連到人物頁（真連結）。
 *
 * 預渲染（lib/ssg/server-data.ts）、進網站地圖、canonical 指正見.tw。名單在建置端算好放進快照（lib/people-directory.ts），
 * 從站內別頁換頁進來沒有快照就整頁載入預渲染那一份（lib/full-load.ts）。
 * 一行說明照職稱規則：只來自任期；沒有現任公職的寫最近一次參選。不排名：同一組照姓名筆畫排。
 */
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { Users } from 'lucide-vue-next'
import Hero from '../components/Hero.vue'
import Breadcrumbs from '../components/Breadcrumbs.vue'
import { useSupabase } from '../composables/useSupabase'
import { usePageHead, PUBLISHER_LD, SITE_URL, type BreadcrumbItem } from '../composables/usePageHead'
import { groupLabel, isGroupKey, sectionsBySurname, surnameAnchor } from '../lib/people-directory'
import { reloadForPrerendered } from '../lib/full-load'

const route = useRoute()
const { peopleIndex, peopleGroup } = useSupabase()

const groupKey = computed(() => (route.name === 'politicians-group' ? String(route.params.group ?? '') : ''))
const isIndex = computed(() => groupKey.value === '')
const group = computed(() => (peopleGroup.value && peopleGroup.value.key === groupKey.value ? peopleGroup.value : null))
const total = computed(() => (peopleIndex.value ?? []).reduce((n, g) => n + g.count, 0))
const sections = computed(() => (group.value ? sectionsBySurname(group.value.entries) : []))
const missing = computed(() => (isIndex.value ? !peopleIndex.value : !group.value))
const reloading = ref(false)

onMounted(() => {
  if (missing.value && (isIndex.value || isGroupKey(groupKey.value))) reloading.value = reloadForPrerendered(route.fullPath)
})

const fmt = (n: number) => n.toLocaleString('zh-TW')
const groupPath = (key: string) => `/politicians/${key}`

const title = computed(() => (isIndex.value ? '人物一覽' : `人物一覽：姓氏${groupLabel(groupKey.value)}`))
const breadcrumbs = computed<BreadcrumbItem[]>(() => (isIndex.value
  ? [{ name: '首頁', path: '/' }, { name: '人物一覽' }]
  : [{ name: '首頁', path: '/' }, { name: '人物一覽', path: '/politicians' }, { name: `姓氏${groupLabel(groupKey.value)}` }]))

usePageHead({
  title: () => title.value,
  description: () => {
    if (isIndex.value) {
      return `正見收錄的 ${fmt(total.value)} 位政治人物（含全台村里長），依姓氏筆畫分組：點姓氏看那一組的名單，點姓名看人物的參選紀錄、政見與出處。`
    }
    if (!group.value) return '人物一覽：依姓氏筆畫分組的政治人物名單。'
    const chars = sections.value.slice(0, 12).map((s) => s.char).join('、')
    return `姓氏${group.value.label}的 ${fmt(group.value.entries.length)} 位政治人物：${chars}${sections.value.length > 12 ? '等' : ''}姓。每位附現任職稱或最近一次參選，點姓名看參選紀錄、政見與出處。`
  },
  // 網址的組名認不得、或那一組沒有人：這一頁沒有內容，不收錄
  noindex: () => !isIndex.value && !group.value && !reloading.value,
  breadcrumbs: () => breadcrumbs.value,
  jsonLd: () => (isIndex.value
    ? {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: '人物一覽',
        url: `${SITE_URL}/politicians`,
        publisher: PUBLISHER_LD,
        numberOfItems: total.value,
        itemListElement: (peopleIndex.value ?? []).map((g, i) => ({ '@type': 'ListItem', position: i + 1, name: `姓氏${g.label}`, url: `${SITE_URL}${groupPath(g.key)}` })),
      }
    : group.value
      ? { '@context': 'https://schema.org', '@type': 'ItemList', name: title.value, url: `${SITE_URL}${groupPath(group.value.key)}`, publisher: PUBLISHER_LD, numberOfItems: group.value.entries.length }
      : undefined),
})
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20" data-testid="people-directory">
    <Hero>
      <template #title>{{ isIndex ? '人物一覽' : `姓氏${groupLabel(groupKey)}` }}</template>
      <template #description>
        <template v-if="isIndex">正見收錄的每一位政治人物（含全台村里長），依姓氏筆畫分組。點姓氏看那一組的名單，點姓名到人物頁看參選紀錄、政見與出處。</template>
        <template v-else-if="group">姓氏{{ group.label }}的 {{ fmt(group.entries.length) }} 位政治人物，依姓名筆畫排列。每位附現任職稱；沒有現任公職的寫最近一次參選。</template>
        <template v-else>依姓氏筆畫分組的政治人物名單。</template>
      </template>
      <template #icon><Users :size="400" class="text-blue-500" /></template>
    </Hero>
    <Breadcrumbs :items="breadcrumbs" />

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 text-left">
      <!-- 各組（筆畫）：真連結，換組整頁載入預渲染那一份 -->
      <nav v-if="peopleIndex && !isIndex" aria-label="姓氏筆畫" class="mb-8">
        <ul class="flex flex-wrap gap-2">
          <li v-for="g in peopleIndex" :key="g.key">
            <a
              :href="groupPath(g.key)"
              :aria-current="g.key === groupKey ? 'page' : undefined"
              :class="['inline-block rounded-full border px-3 py-1 text-sm font-bold transition-colors',
                       g.key === groupKey ? 'bg-navy-900 text-white border-navy-900' : 'bg-white text-slate-700 border-slate-200 hover:border-blue-300 hover:text-blue-700']"
            >{{ g.label }}</a>
          </li>
        </ul>
      </nav>

      <!-- 索引 -->
      <template v-if="isIndex">
        <div v-if="!peopleIndex" class="text-slate-500 text-center py-20">{{ reloading ? '載入中…' : '這一頁在建置網站時產生，請重新整理。' }}</div>
        <template v-else>
          <p class="text-sm text-slate-600 mb-6">共 {{ fmt(total) }} 位。姓氏依筆畫（台灣通用寫法）分組；漢字以外的姓名（原住民族語拼音等）歸在「其他」。</p>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="people-index">
            <section v-for="g in peopleIndex" :key="g.key" class="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
              <h2 class="text-lg font-black text-navy-900 mb-3">
                <a :href="groupPath(g.key)" class="hover:text-blue-700">{{ g.label }}</a>
                <span class="ml-2 text-sm font-semibold text-slate-500">{{ fmt(g.count) }} 位</span>
              </h2>
              <ul class="flex flex-wrap gap-x-3 gap-y-1.5 text-sm">
                <li v-for="s in g.surnames" :key="s.char">
                  <a :href="`${groupPath(g.key)}#${surnameAnchor(s.char)}`" class="text-blue-700 hover:underline">{{ s.char }}</a><span class="text-slate-500 text-xs ml-0.5">{{ s.count }}</span>
                </li>
              </ul>
            </section>
          </div>
        </template>
      </template>

      <!-- 一組 -->
      <template v-else>
        <div v-if="!group" class="text-slate-500 text-center py-20">
          <template v-if="reloading">載入中…</template>
          <template v-else>找不到這一組。<a href="/politicians" class="text-blue-700 hover:underline">回人物一覽</a></template>
        </div>
        <template v-else>
          <nav aria-label="姓氏" class="mb-6 bg-white rounded-xl border border-slate-200 p-4">
            <ul class="flex flex-wrap gap-x-3 gap-y-1.5 text-base">
              <li v-for="s in sections" :key="s.char">
                <a :href="`#${surnameAnchor(s.char)}`" class="text-blue-700 hover:underline font-bold">{{ s.char }}</a><span class="text-slate-500 text-xs ml-0.5">{{ s.entries.length }}</span>
              </li>
            </ul>
          </nav>
          <section
            v-for="s in sections"
            :id="surnameAnchor(s.char)"
            :key="s.char"
            class="mb-8 scroll-mt-20"
            :aria-labelledby="`${surnameAnchor(s.char)}-h`"
          >
            <h2 :id="`${surnameAnchor(s.char)}-h`" class="text-xl font-black text-navy-900 mb-3 border-b border-slate-200 pb-2">
              {{ s.char }}<span class="ml-2 text-sm font-semibold text-slate-500">{{ fmt(s.entries.length) }} 位</span>
            </h2>
            <!-- 一組最多三千多筆：樣式寫在 .dir-list（styles/main.css），每一筆只帶兩個短 class -->
            <ul class="dir-list grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-6 gap-y-1.5">
              <li v-for="e in s.entries" :key="e.id"><RouterLink :to="`/politician/${e.id}`" class="dn">{{ e.name }}</RouterLink><span v-if="e.label" class="dl">{{ e.label }}</span></li>
            </ul>
          </section>
        </template>
      </template>
    </div>
  </div>
</template>
