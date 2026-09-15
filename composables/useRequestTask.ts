import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { requestTask, type RequestTaskInput, type RequestTaskResult } from '../lib/request-task'

/**
 * 政見頁／人物頁「請 AI 幫忙查」按鈕的送出狀態：按一下就建任務、就地顯示結果，不換頁。
 *
 * 2026-09-15 小良哥：這些按鈕建的任務要出現在 /ai-assistant?tab=tasks、不用人填文字。
 * 之前（#14）是跳去 /community 預填一題公民提問，已撤回。
 */
export interface RequestTaskState {
  loading: Ref<boolean>
  result: Ref<RequestTaskResult | null>
  error: Ref<string | null>
  done: ComputedRef<boolean>
  /** 按鈕上的字：送出中／已在任務池中／已排入／失敗（重試）／原本的字 */
  label: (idle: string) => string
  send: (input: RequestTaskInput) => Promise<void>
  reset: () => void
}

export function useRequestTask(): RequestTaskState {
  const loading = ref(false)
  const result = ref<RequestTaskResult | null>(null)
  const error = ref<string | null>(null)
  const done = computed(() => result.value !== null)

  async function send(input: RequestTaskInput): Promise<void> {
    if (loading.value || done.value) return
    loading.value = true
    error.value = null
    try {
      result.value = await requestTask(input)
    } catch (err: unknown) {
      console.error('[請 AI 幫忙查] 送出失敗：', err)
      error.value = err instanceof Error ? err.message : '送出失敗，請稍後再試'
    } finally {
      loading.value = false
    }
  }

  function label(idle: string): string {
    if (loading.value) return '送出中…'
    if (result.value) return result.value.status === 'already_queued' ? '已在任務池中' : '已排入任務池'
    if (error.value) return `${idle}（重試）`
    return idle
  }

  function reset(): void {
    loading.value = false
    result.value = null
    error.value = null
  }

  return { loading, result, error, done, label, send, reset }
}
