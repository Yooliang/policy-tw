<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { Sparkles, Loader2, CheckCircle, XCircle } from 'lucide-vue-next'
import { BOARD_PATH, requestTaskMessage, type RequestTaskResult } from '../lib/request-task'

/**
 * 「請 AI 幫忙查」的次要版：區塊已經有資料時放在底部的小按鈕（有資料也能再查、補最新的），
 * 不佔內容區的黃金位置。空狀態的大按鈕仍由頁面自己渲染。
 * 後端 24 小時內重複請求回 already_queued，這裡當成功顯示「已在任務池中」，不當錯誤。
 */
export interface LookupState {
  loading: boolean
  result: RequestTaskResult | null
  error: string | null
}

defineProps<{
  state: LookupState
  label: string
}>()
defineEmits<{ click: [] }>()
</script>

<template>
  <div class="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs" data-testid="ai-lookup-inline">
    <p v-if="state.error" class="text-red-500">{{ state.error }}</p>
    <p v-else-if="state.result" class="text-emerald-700">
      {{ requestTaskMessage(state.result) }}
      <RouterLink :to="BOARD_PATH" class="font-bold underline underline-offset-2 ml-1">到任務看板看進度</RouterLink>
    </p>
    <button
      type="button"
      :disabled="state.loading"
      :class="[
        'px-3 py-1.5 rounded-lg font-bold border transition-colors flex items-center gap-1.5 whitespace-nowrap',
        state.result
          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
          : state.error
            ? 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
            : 'bg-white text-violet-700 border-violet-200 hover:bg-violet-50',
      ]"
      @click="$emit('click')"
    >
      <Loader2 v-if="state.loading" :size="14" class="animate-spin" />
      <CheckCircle v-else-if="state.result" :size="14" />
      <XCircle v-else-if="state.error" :size="14" />
      <Sparkles v-else :size="14" />
      {{ state.loading ? '送出中…' : state.result ? (state.result.status === 'already_queued' ? '已在任務池中' : '已排入任務池') : state.error ? '重試' : label }}
    </button>
  </div>
</template>
