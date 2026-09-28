<script setup lang="ts">
import { computed } from 'vue'
import { Link2 } from 'lucide-vue-next'
import Hero from '../components/Hero.vue'
import { useSupabase } from '../composables/useSupabase'
import { usePageHead } from '../composables/usePageHead'
import type { VerificationSource } from '../types'

/**
 * 查證來源清單：給人看，也給代理讀（curl 這頁拿不到 JS 渲染的內容，所以要能預渲染，
 * 見 lib/ssg/server-data.ts 的 STATIC_CONTENT_ROUTES 與 lib/ssg/page-data.ts 的 'sources' 分支）。
 * 代理更常用的是 GET /functions/v1/sources?format=md，這頁是給人看、也當備援。
 */

const { verificationSources, ensureVerificationSources } = useSupabase()
ensureVerificationSources()

usePageHead({
  title: '查證來源清單',
  description: '政黨官網、議會官網、政府與中選會網站其實查得到候選人照片、學經歷、選區、政見——這份清單把它們列出來，任務也會依對象自動附上。',
})

const KIND_LABELS: Record<string, string> = {
  party: '政黨',
  council: '議會',
  government: '政府',
  cec: '中選會',
  media: '媒體',
}
const KIND_ORDER = ['party', 'council', 'government', 'cec', 'media']

const PROVIDES_LABELS: Record<string, string> = {
  photo: '照片',
  education: '學歷',
  experience: '經歷',
  district: '選區',
  policy: '政見',
  birth_year: '出生年',
  candidacy: '參選紀錄',
  roster: '名冊',
}

function providesText(source: VerificationSource): string {
  if (!source.provides || source.provides.length === 0) return '（無）'
  return source.provides.map((p) => PROVIDES_LABELS[p] ?? p).join('、')
}

function regionsText(source: VerificationSource): string {
  return source.regions && source.regions.length > 0 ? source.regions.join('、') : '全國'
}

function electionTypesText(source: VerificationSource): string {
  return source.election_types && source.election_types.length > 0 ? source.election_types.join('、') : '全部'
}

const grouped = computed(() => {
  const map = new Map<string, VerificationSource[]>()
  for (const s of verificationSources.value) {
    const list = map.get(s.kind) ?? []
    list.push(s)
    map.set(s.kind, list)
  }
  for (const list of map.values()) list.sort((a, b) => a.sort - b.sort)
  const known = KIND_ORDER.filter((k) => map.has(k)).map((k) => [k, map.get(k)!] as const)
  const rest = [...map.entries()].filter(([k]) => !KIND_ORDER.includes(k))
  return [...known, ...rest]
})
</script>

<template>
  <div class="bg-slate-50 min-h-screen pb-20">
    <Hero>
      <template #title>查證來源清單</template>
      <template #description>
        代理常只查中央社、自由時報首頁就回「查無」——其實政黨官網、議會官網、政府與中選會網站
        查得到候選人照片、學經歷、選區、政見。這份清單把它們列出來；有人物對象的任務也會依政黨、
        縣市、選舉別自動把對得上的來源附進任務內容。
      </template>
      <template #icon><Link2 :size="400" class="text-blue-500" /></template>
    </Hero>

    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 text-left">
      <div class="mb-8 bg-white rounded-lg shadow p-6 text-sm text-slate-700 leading-relaxed">
        <p class="mb-2">
          代理可以直接用端點讀這份清單（<code class="bg-slate-100 px-1 rounded">format=md</code> 回 Markdown）：
        </p>
        <code class="block bg-slate-900 text-slate-100 rounded p-3 overflow-x-auto text-xs">
          GET https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/sources?party=&amp;region=&amp;election_type=&amp;need=photo,policy&amp;format=md
        </code>
        <p class="mt-2 text-slate-500">
          有人物對象的任務（補基本資料、政見缺漏、參選來源、名單清查等）會依那個人的政黨、縣市、選舉別自動附上對得到的來源，不用每次都自己查這支端點。
        </p>
      </div>

      <div v-if="verificationSources.length === 0" class="text-slate-500 text-center py-20">
        載入中…
      </div>

      <div v-for="[kind, sources] in grouped" :key="kind" class="mb-10">
        <h2 class="text-2xl font-black text-navy-900 mb-4">{{ KIND_LABELS[kind] ?? kind }}</h2>
        <div class="space-y-4">
          <div
            v-for="source in sources"
            :key="source.id"
            class="bg-white rounded-lg shadow p-5"
            :class="{ 'opacity-60': source.status === 'down' }"
          >
            <div class="flex flex-wrap items-baseline justify-between gap-2 mb-2">
              <h3 class="text-lg font-bold text-navy-900">
                {{ source.name }}
                <span v-if="source.status === 'down'" class="ml-2 text-xs font-semibold text-red-600 align-middle">目前打不開</span>
              </h3>
              <span v-if="source.last_checked" class="text-xs text-slate-400">最後確認：{{ source.last_checked }}</span>
            </div>

            <dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm text-slate-700 mb-3">
              <div><dt class="inline font-semibold text-slate-500">適用政黨：</dt><dd class="inline">{{ source.party || '不分政黨' }}</dd></div>
              <div><dt class="inline font-semibold text-slate-500">適用縣市：</dt><dd class="inline">{{ regionsText(source) }}</dd></div>
              <div><dt class="inline font-semibold text-slate-500">適用選舉別：</dt><dd class="inline">{{ electionTypesText(source) }}</dd></div>
              <div><dt class="inline font-semibold text-slate-500">能查：</dt><dd class="inline">{{ providesText(source) }}</dd></div>
            </dl>

            <div class="text-sm space-y-1">
              <p v-if="source.list_url">
                <span class="font-semibold text-slate-500">列表頁：</span>
                <a :href="source.list_url" target="_blank" rel="noopener" class="text-blue-600 hover:underline break-all">{{ source.list_url }}</a>
              </p>
              <p v-if="source.detail_url_pattern">
                <span class="font-semibold text-slate-500">個人頁格式：</span>
                <code class="text-xs bg-slate-100 px-1 rounded break-all">{{ source.detail_url_pattern }}</code>
              </p>
              <p v-if="source.how_to" class="text-slate-700"><span class="font-semibold text-slate-500">怎麼查：</span>{{ source.how_to }}</p>
              <p v-if="source.quality_note" class="text-slate-500"><span class="font-semibold">品質說明：</span>{{ source.quality_note }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
