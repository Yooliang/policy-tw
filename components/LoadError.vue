<script setup lang="ts">
import { AlertTriangle, RefreshCw } from 'lucide-vue-next'
import { useSupabase } from '../composables/useSupabase'

/**
 * 讀取失敗。預設是整頁版，顯示 useSupabase 的全域錯誤、重試整頁資料。
 * inline（2026-10-03，統計頁「各模型表現」起）：放在單一區塊裡，錯誤訊息由呼叫端給、重試發 retry 事件給呼叫端自己重讀。
 */
const props = defineProps<{ inline?: boolean; message?: string }>()
const emit = defineEmits<{ retry: [] }>()

const { error, retry } = useSupabase()
</script>

<template>
  <div v-if="props.inline" class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3 text-sm" data-testid="load-error-inline">
    <AlertTriangle :size="18" class="text-amber-500 shrink-0" />
    <p class="text-slate-600 flex-1 min-w-0">{{ props.message || '資料暫時載入不了' }}。可能是網路不穩或伺服器忙碌。</p>
    <button type="button" @click="emit('retry')" class="px-3 py-1.5 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 transition-all inline-flex items-center gap-1.5 shrink-0">
      <RefreshCw :size="14" /> 重試
    </button>
  </div>
  <div v-else class="bg-slate-50 min-h-screen flex items-center justify-center">
    <div class="text-center px-4">
      <AlertTriangle :size="64" class="mx-auto mb-4 text-amber-400" />
      <h2 class="text-2xl font-bold text-navy-900 mb-2">資料暫時載入不了</h2>
      <p class="text-slate-500 mb-6">{{ error }}。可能是網路不穩或伺服器忙碌，請再試一次。</p>
      <button @click="retry()" class="px-6 py-2 bg-blue-600 text-white rounded-lg font-bold shadow-lg shadow-blue-500/20 hover:bg-blue-700 transition-all inline-flex items-center gap-2">
        <RefreshCw :size="18" /> 重試
      </button>
    </div>
  </div>
</template>
