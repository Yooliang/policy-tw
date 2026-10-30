<script setup lang="ts">
import { onBeforeUnmount, onDeactivated } from 'vue'
import { useRouter } from 'vue-router'
import { Loader2 } from 'lucide-vue-next'
import { searchPageTerm, useGlobalSearch } from '../composables/useGlobalSearch'
import SearchResults from '../components/SearchResults.vue'
import { usePageHead } from '../composables/usePageHead'

/**
 * 手機版搜尋頁（底部分頁列的「搜尋」，最小版）：頁首正中是搜尋框（Navbar 讀 searchPageTerm），
 * 這裡只放結果列表；邏輯與列表跟桌面的搜尋視窗共用（useGlobalSearch／SearchResults）。
 */
const router = useRouter()
const search = useGlobalSearch(searchPageTerm)

usePageHead({ title: '搜尋', description: '搜尋政治人物與政見。', noindex: true })

function clear() { searchPageTerm.value = ''; search.reset() }
onDeactivated(clear)
onBeforeUnmount(clear)
</script>

<template>
  <div class="bg-white min-h-[60vh]" data-testid="search-page">
    <div v-if="search.loading.value" class="flex justify-center pt-3 text-slate-400"><Loader2 :size="18" class="animate-spin" /></div>
    <SearchResults :term="searchPageTerm" :search="search" @pick="(p) => router.push(p)" />
  </div>
</template>
