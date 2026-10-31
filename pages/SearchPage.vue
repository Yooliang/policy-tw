<script setup lang="ts">
import { nextTick, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Loader2, Search } from 'lucide-vue-next'
import { searchPageTerm, useGlobalSearch } from '../composables/useGlobalSearch'
import SearchResults from '../components/SearchResults.vue'
import { usePageHead } from '../composables/usePageHead'

/**
 * 手機版搜尋頁（底部分頁列的「搜尋」，最小版）：頁首正中是搜尋框（Navbar 讀 searchPageTerm），
 * 這裡只放結果列表；邏輯與列表跟桌面的搜尋視窗共用（useGlobalSearch／SearchResults）。
 */
const router = useRouter()
const route = useRoute()
// 桌面版：搜尋框在內容頂部（手機版在頁首，Navbar 讀 searchPageTerm）；進頁自動聚焦，?q= 預填
const deskInput = ref<HTMLInputElement | null>(null)
onMounted(async () => {
  const q = route.query.q
  if (typeof q === 'string' && q && !searchPageTerm.value) searchPageTerm.value = q
  await nextTick()
  if (window.matchMedia('(min-width: 768px)').matches) deskInput.value?.focus()
})
const search = useGlobalSearch(searchPageTerm)

usePageHead({ title: '搜尋', description: '搜尋政治人物與政見。', noindex: true })

function clear() { searchPageTerm.value = ''; search.reset() }
onDeactivated(clear)
onBeforeUnmount(clear)
</script>

<template>
  <div class="bg-white min-h-[60vh]" data-testid="search-page">
    <div class="hidden md:flex items-center gap-2 border-b border-slate-200 px-6 py-3">
      <Search :size="18" class="shrink-0 text-slate-400" />
      <input ref="deskInput" v-model="searchPageTerm" type="text" enterkeyhint="search" autocomplete="off" placeholder="搜尋人物或政見…" class="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-slate-400" data-testid="search-page-input" />
    </div>
    <div v-if="search.loading.value" class="flex justify-center pt-3 text-slate-400"><Loader2 :size="18" class="animate-spin" /></div>
    <SearchResults :term="searchPageTerm" :search="search" @pick="(p) => router.push(p)" />
  </div>
</template>
