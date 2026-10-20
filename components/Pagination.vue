<script setup lang="ts">
import { computed } from 'vue'
import { pageItems } from '../lib/pagination'

/** 通用頁碼列：上一頁／頁碼（含省略號）／下一頁。只有一頁時不畫。換頁由父層處理（:page + @update:page）。 */
const props = defineProps<{ page: number; totalPages: number }>()
const emit = defineEmits<{ 'update:page': [page: number] }>()

const items = computed(() => pageItems(props.page, props.totalPages))
function go(p: number) {
  if (p >= 1 && p <= props.totalPages && p !== props.page) emit('update:page', p)
}
const base = 'min-w-9 h-9 px-2 inline-flex items-center justify-center rounded-lg text-sm font-bold border transition-all'
</script>

<template>
  <nav v-if="totalPages > 1" class="flex flex-wrap items-center justify-center gap-1.5 mt-8" aria-label="分頁" data-testid="pagination">
    <button type="button" :class="`${base} bg-white border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-white`" :disabled="page <= 1" @click="go(page - 1)">上一頁</button>
    <template v-for="(it, i) in items" :key="it === 'gap' ? `gap${i}` : it">
      <span v-if="it === 'gap'" class="px-1 text-slate-400" aria-hidden="true">…</span>
      <button
        v-else
        type="button"
        :aria-current="it === page ? 'page' : undefined"
        :class="`${base} ${it === page ? 'bg-blue-600 text-white border-blue-600 shadow-md' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`"
        @click="go(it)"
      >{{ it }}</button>
    </template>
    <button type="button" :class="`${base} bg-white border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-white`" :disabled="page >= totalPages" @click="go(page + 1)">下一頁</button>
  </nav>
</template>
