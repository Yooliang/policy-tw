<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { CheckCircle, XCircle } from 'lucide-vue-next'
import { BOARD_PATH, requestTaskMessage, type RequestTaskResult } from '../lib/request-task'

/**
 * 「請 AI 幫忙查」按鈕送出後的一行結果：成功帶任務看板連結，失敗說原因。
 * 按鈕本身的字由 useRequestTask 的 label 管，這裡只負責按鈕旁邊那一行。
 */
defineProps<{
  result: RequestTaskResult | null
  error: string | null
  /** 放在深色 Hero 上用淺色字 */
  onDark?: boolean
}>()
</script>

<template>
  <p v-if="result" data-testid="request-task-done" :class="['flex items-center gap-1.5 text-sm', onDark ? 'text-emerald-200' : 'text-emerald-700']">
    <CheckCircle :size="16" class="shrink-0" />
    <span>
      {{ requestTaskMessage(result) }}
      <RouterLink :to="BOARD_PATH" :class="['ml-1 font-bold underline underline-offset-2', onDark ? 'text-white' : '']">到任務看板看進度</RouterLink>
    </span>
  </p>
  <p v-else-if="error" data-testid="request-task-error" :class="['flex items-center gap-1.5 text-sm', onDark ? 'text-rose-200' : 'text-rose-600']">
    <XCircle :size="16" class="shrink-0" /> {{ error }}
  </p>
</template>
