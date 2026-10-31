<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Search, X, Loader2 } from 'lucide-vue-next'
import { useGlobalSearch, useGlobalSearchOpen } from '../composables/useGlobalSearch'
import SearchResults from './SearchResults.vue'

/**
 * 全站搜尋視窗（桌面版頁首的搜尋鈕）。搜尋邏輯與結果列表抽到 useGlobalSearch／SearchResults，
 * 手機版的搜尋頁（pages/SearchPage.vue）共用同一份。
 */
const router = useRouter()
// bare：不畫搜尋鈕，只留視窗（桌面版左欄的「搜尋」鈕透過 useGlobalSearchOpen 開它）
defineProps<{ bare?: boolean }>()
const { requests } = useGlobalSearchOpen()
watch(requests, () => { void show() })
const open = ref(false)
const term = ref('')
const search = useGlobalSearch(term)
const inputEl = ref<HTMLInputElement | null>(null)

// 2026-10-31：桌面版不再開搜尋視窗，所有入口（左欄搜尋、頁首搜尋鈕）改導到 /search 頁（那頁自動聚焦搜尋框）
async function show() {
  await router.push('/search')
}

function close() {
  open.value = false
  term.value = ''
  search.reset()
}

function go(path: string) {
  close()
  router.push(path)
}
</script>

<template>
  <button
    v-if="!bare"
    type="button"
    class="bg-slate-100 hover:bg-slate-200 text-navy-900 w-9 h-9 rounded-full flex items-center justify-center transition-colors border border-slate-200"
    aria-label="搜尋"
    title="搜尋人物與政見"
    data-testid="global-search-open"
    @click="show"
  >
    <Search :size="18" />
  </button>

  <div v-if="open" class="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm flex items-start justify-center p-4 pt-[10vh]" @click="close">
    <div class="bg-white w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden" @click.stop>
      <div class="flex items-center gap-2 px-4 py-3 border-b border-slate-200">
        <Search :size="18" class="text-slate-400 shrink-0" />
        <!-- 用 text 不用 search：type="search" 瀏覽器會自己加一個清除的 ✕，
             跟右邊的關閉鈕並排就變成兩個叉（2026-09-17 抓到） -->
        <input
          ref="inputEl"
          v-model="term"
          type="text"
          placeholder="搜尋人物或政見…"
          class="flex-1 min-w-0 outline-none text-base placeholder:text-slate-400"
          data-testid="global-search-input"
          @keydown.esc="close"
        />
        <Loader2 v-if="search.loading.value" :size="16" class="animate-spin text-slate-400 shrink-0" />
        <button type="button" class="text-slate-400 hover:text-slate-700 shrink-0" aria-label="關閉" @click="close"><X :size="18" /></button>
      </div>

      <SearchResults class="max-h-[60vh] overflow-y-auto" :term="term" :search="search" @pick="go" />
    </div>
  </div>
</template>
