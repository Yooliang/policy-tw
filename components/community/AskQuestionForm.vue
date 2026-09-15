<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CheckCircle2, Loader2, Sparkles } from 'lucide-vue-next'
import { useSupabase } from '../../composables/useSupabase'
import { askQuestion, isValidQuestion, QUESTION_MAX_LENGTH, QUESTION_MIN_LENGTH, type AskQuestionResult } from '../../lib/citizen-questions'

/**
 * 公民提問表單：訪客免登入發問，AI 代理會去查有出處的資料來回答。
 * 掛在特定政見下時（presetPolicyId）不再讓使用者自己選政見，縣市則一律可選。
 */

const props = defineProps<{
  presetPolicyId?: string
  presetPolicyTitle?: string
  /** 預先填好的問題（網址 ?q=） */
  presetQuestion?: string
  /** 這一題掛在哪一位人物（網址 ?politician=） */
  presetPoliticianId?: string
}>()

const emit = defineEmits<{
  asked: [AskQuestionResult]
}>()

const { locations } = useSupabase()

const questionText = ref(props.presetQuestion ?? '')
// 從別的政見頁再按一次過來時要換成新的預填內容；但使用者已經改過就不要蓋掉他打的字
watch(() => props.presetQuestion, (q, prev) => {
  if (q && (questionText.value === '' || questionText.value === (prev ?? ''))) questionText.value = q
})
const region = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)
const successMessage = ref<string | null>(null)

const trimmedLength = computed(() => questionText.value.trim().length)
const canSubmit = computed(() => isValidQuestion(questionText.value) && !submitting.value)

async function submit() {
  if (!canSubmit.value) return
  submitting.value = true
  error.value = null
  successMessage.value = null
  try {
    const result = await askQuestion({
      question: questionText.value,
      policyId: props.presetPolicyId,
      politicianId: props.presetPoliticianId,
      region: region.value || undefined,
    })
    questionText.value = ''
    successMessage.value = '已經交給 AI 代理去查，答案會出現在這一題下面。'
    emit('asked', result)
  } catch (err) {
    error.value = err instanceof Error ? err.message : '送出失敗，請稍後再試'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
    <h3 class="font-bold text-navy-900 text-lg mb-1 flex items-center gap-2"><Sparkles :size="18" class="text-blue-500" /> 提出你的問題</h3>
    <p class="text-sm text-slate-500 mb-4">
      <template v-if="presetPolicyTitle">這一題會掛在「{{ presetPolicyTitle }}」底下，AI 代理會去查有出處的資料來回答。</template>
      <template v-else>AI 代理會去查有出處的資料來回答，可能不只一個代理作答，答案會並排顯示讓你自己比對。</template>
    </p>
    <textarea
      v-model="questionText"
      rows="3"
      :maxlength="QUESTION_MAX_LENGTH"
      placeholder="想問什麼？例如：這項政見預計什麼時候完工？&#10;看到有人宣布參選、或報導提到新政見，把網址貼進來也可以，AI 會去讀。"
      class="w-full p-3 border border-slate-200 rounded-lg text-navy-900 placeholder:text-slate-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
    />
    <div class="flex items-center justify-end mt-1 mb-4">
      <span :class="['text-xs font-medium', trimmedLength > 0 && trimmedLength < QUESTION_MIN_LENGTH ? 'text-amber-600' : 'text-slate-400']">
        {{ trimmedLength }} / {{ QUESTION_MAX_LENGTH }} 字（至少 {{ QUESTION_MIN_LENGTH }} 字）
      </span>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <select v-model="region" class="px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
        <option value="">不指定縣市</option>
        <option v-for="loc in locations" :key="loc" :value="loc">{{ loc }}</option>
      </select>
      <button
        type="button"
        :disabled="!canSubmit"
        @click="submit"
        class="ml-auto px-5 py-2.5 rounded-lg text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
      >
        <Loader2 v-if="submitting" :size="16" class="animate-spin" /> 送出提問
      </button>
    </div>
    <p v-if="error" class="text-sm text-red-600 mt-3">{{ error }}</p>
    <p v-if="successMessage" class="text-sm text-emerald-600 mt-3 flex items-center gap-1.5"><CheckCircle2 :size="16" />{{ successMessage }}</p>
  </div>
</template>
