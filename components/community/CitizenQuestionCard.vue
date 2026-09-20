<script setup lang="ts">
import { hostOf, shortUrlsIn } from '../../lib/url'
import { computed, ref } from 'vue'
import HistoryPanel from '../history/HistoryPanel.vue'
import { Bot, ChevronDown, ChevronUp, Clock, ExternalLink, Loader2, MessageSquareText, ThumbsDown, ThumbsUp } from 'lucide-vue-next'
import type { CitizenQuestion, QuestionAnswer } from '../../types'
import type { AnswersState } from '../../composables/useCitizenQuestions'
import type { Stance } from '../../lib/citizen-questions'

/**
 * 公民提問列表的一張卡片：問題本文＋表態＋展開後並陳所有 AI 代理的答案。
 * 只負責顯示與轉發使用者動作，資料讀寫由父層（pages/Community.vue）處理。
 */

const props = defineProps<{
  question: CitizenQuestion
  policyTitle?: string
  politicianName?: string
  expanded: boolean
  answers?: AnswersState
  votedStance?: Stance
  voteBusy: boolean
  voteError?: string
}>()

const emit = defineEmits<{
  toggle: [id: string]
  vote: [id: string, stance: Stance]
}>()

// AI 處理紀錄（使用者 2026-09-20：「至少要呈現出來它處理過 3 次、有一個回答正在被檢驗投票，不是呆呆的空在那裡」）
// 由 HistoryPanel（target=question）載入：每一次回答、查不到的回報、驗證票都列出來；這裡只接它回報的次數
const attempts = ref<number | null>(null)

const STATUS_LABEL: Record<CitizenQuestion['status'], string> = {
  open: '待回答',
  answered: '已有答案',
  hidden: '已隱藏',
}
const STATUS_CLASS: Record<CitizenQuestion['status'], string> = {
  open: 'bg-amber-100 text-amber-800 border-amber-200',
  answered: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  hidden: 'bg-slate-100 text-slate-500 border-slate-200',
}

const answerList = computed<QuestionAnswer[] | null>(() =>
  Array.isArray(props.answers) ? props.answers : null
)

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}
</script>

<template>
  <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
    <button type="button" class="w-full text-left p-6 hover:bg-slate-50 transition-colors" @click="emit('toggle', question.id)">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <span :class="['px-2.5 py-0.5 rounded-full text-xs font-bold border', STATUS_CLASS[question.status]]">{{ STATUS_LABEL[question.status] }}</span>
        <RouterLink v-if="question.policyId && policyTitle" :to="`/policy/${question.policyId}`" @click.stop class="text-xs font-bold bg-blue-50 text-blue-700 px-2.5 py-0.5 rounded-full hover:bg-blue-100 transition-colors line-clamp-1">
          政見：{{ policyTitle }}
        </RouterLink>
        <RouterLink v-if="question.politicianId && politicianName" :to="`/politician/${question.politicianId}`" @click.stop class="text-xs font-bold bg-slate-100 text-slate-600 px-2.5 py-0.5 rounded-full hover:bg-slate-200 transition-colors">
          {{ politicianName }}
        </RouterLink>
        <span v-if="question.region" class="text-xs text-slate-400">{{ question.region }}</span>
      </div>
      <h3 class="font-bold text-lg text-navy-900 leading-snug">{{ question.question }}</h3>
      <div class="flex items-center gap-5 text-slate-400 text-xs font-medium mt-3">
        <span class="flex items-center gap-1.5"><MessageSquareText :size="14" /> {{ question.answerCount }} 份回答</span>
        <span class="flex items-center gap-1.5"><ThumbsUp :size="14" /> {{ question.stanceUp + question.stanceDown }} 人表態</span>
        <span class="flex items-center gap-1.5"><Clock :size="14" /> {{ fmtTime(question.createdAt) }}</span>
        <span class="ml-auto text-slate-300"><ChevronUp v-if="expanded" :size="16" /><ChevronDown v-else :size="16" /></span>
      </div>
    </button>

    <div v-if="expanded" class="border-t border-slate-100 bg-slate-50 px-6 py-5 space-y-4">
      <div class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          :disabled="voteBusy || votedStance === 'up'"
          @click="emit('vote', question.id, 'up')"
          :class="[
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-bold border transition-colors disabled:cursor-not-allowed',
            votedStance === 'up' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-300 disabled:hover:border-slate-200',
          ]"
        >
          <ThumbsUp :size="14" /> 贊同 {{ question.stanceUp }}
        </button>
        <button
          type="button"
          :disabled="voteBusy || votedStance === 'down'"
          @click="emit('vote', question.id, 'down')"
          :class="[
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-bold border transition-colors disabled:cursor-not-allowed',
            votedStance === 'down' ? 'bg-red-500 text-white border-red-500' : 'bg-white text-slate-600 border-slate-200 hover:border-red-300 disabled:hover:border-slate-200',
          ]"
        >
          <ThumbsDown :size="14" /> 不贊同 {{ question.stanceDown }}
        </button>
        <Loader2 v-if="voteBusy" :size="16" class="animate-spin text-slate-400" />
        <span v-if="votedStance" class="text-xs text-slate-400">已記錄你的表態，改成另一邊也可以</span>
      </div>
      <p v-if="voteError" class="text-sm text-red-600">{{ voteError }}</p>

      <div v-if="answers === 'loading'" class="text-sm text-slate-400 flex items-center gap-2 py-2">
        <Loader2 :size="16" class="animate-spin" /> 讀取答案中…
      </div>
      <p v-else-if="answers === 'error'" class="text-sm text-red-600 py-2">暫時讀不到答案，請稍後再試。</p>
      <div v-else-if="!answerList || answerList.length === 0" class="py-2 space-y-3">
        <p class="text-sm text-slate-500">
          <template v-if="attempts === null">還沒有通過驗證的回答。</template>
          <template v-else-if="attempts === 0">還沒有 AI 代理處理過這一題；派出後每一次處理都會列在下面。</template>
          <template v-else>還沒有通過驗證的回答；AI 已處理 {{ attempts }} 次，每一次的結果與投票進度在下面（回答要 2 票同意才會顯示）。</template>
        </p>
        <HistoryPanel target="question" :id="question.id" title="AI 處理紀錄" compact @loaded="attempts = $event.total" />
      </div>
      <div v-else class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div v-for="a in answerList" :key="a.id" class="bg-white rounded-lg border border-slate-200 p-4 min-w-0">
          <div class="flex items-center gap-1.5 text-xs font-bold text-slate-500 mb-2">
            <Bot :size="14" class="text-blue-500 flex-shrink-0" />
            <span class="truncate">{{ a.agentName }}</span>
            <template v-if="a.agentTool">
              <span class="text-slate-300">·</span>
              <span class="text-slate-400 font-normal truncate">{{ a.agentTool }}</span>
            </template>
          </div>
          <p class="text-sm text-slate-700 whitespace-pre-wrap break-words leading-relaxed">{{ shortUrlsIn(a.answer) }}</p>
          <div v-if="a.sourceUrls.length > 0" class="mt-3 pt-3 border-t border-slate-100 space-y-1.5">
            <a
              v-for="u in a.sourceUrls"
              :key="u"
              :href="u"
              target="_blank"
              rel="noopener"
              class="text-blue-700 underline underline-offset-2 inline-flex items-start gap-1 break-all text-xs"
            >
              <ExternalLink :size="11" class="mt-0.5 flex-shrink-0" />{{ hostOf(u) }}
            </a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
