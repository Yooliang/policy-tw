<script setup lang="ts">
import type { Component } from 'vue'
import { RouterLink } from 'vue-router'
import { Sparkles, Loader2, CheckCircle, XCircle } from 'lucide-vue-next'
import { BOARD_PATH, requestTaskDoneLabel, requestTaskMessage } from '../lib/request-task'
import type { LookupState } from './AiLookupInline.vue'

/**
 * 「請 AI 補充最新的…」的卡片版：放在卡片清單格線的最後一格，跟政見卡同圓角、同陰影、佔一格，
 * 淡紫虛線框讓人一眼看出是動作卡不是內容卡；整張可點，行為跟小按鈕（AiLookupInline）一樣。
 * 空狀態的大按鈕與表格檢視仍用各自的寫法。
 */
defineProps<{
  state: LookupState
  label: string
  hint?: string
  /** 閒置時的大圖示，沒給用星星 */
  icon?: Component
}>()
defineEmits<{ click: [] }>()
</script>

<template>
  <div
    role="button"
    tabindex="0"
    :aria-disabled="state.loading"
    data-testid="ai-lookup-card"
    :class="[
      'rounded-2xl border-2 border-dashed p-6 min-h-[12rem] h-full flex flex-col items-center justify-center text-center gap-2 shadow-sm transition-colors cursor-pointer',
      state.result ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
        : state.error ? 'bg-red-50 border-red-200 text-red-700 hover:bg-red-100'
          : 'bg-violet-50 border-violet-300 text-violet-700 hover:bg-violet-100',
      state.loading ? 'opacity-70 pointer-events-none' : '',
    ]"
    @click="$emit('click')"
    @keydown.enter.prevent="$emit('click')"
    @keydown.space.prevent="$emit('click')"
  >
    <Loader2 v-if="state.loading" :size="40" class="animate-spin" />
    <CheckCircle v-else-if="state.result" :size="40" />
    <XCircle v-else-if="state.error" :size="40" />
    <component :is="icon ?? Sparkles" v-else :size="40" />
    <p class="text-lg font-black">{{ state.loading ? '送出中…' : state.result ? requestTaskDoneLabel(state.result) : state.error ? '重試' : label }}</p>
    <p v-if="state.error" class="text-xs text-red-500">{{ state.error }}</p>
    <p v-else-if="state.result" class="text-xs">
      {{ requestTaskMessage(state.result) }}
      <RouterLink :to="BOARD_PATH" class="font-bold underline underline-offset-2 ml-1" @click.stop>到任務看板看進度</RouterLink>
    </p>
    <p v-else-if="hint" class="text-xs text-violet-500">{{ hint }}</p>
  </div>
</template>
