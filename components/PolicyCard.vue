<script setup lang="ts">
import { shortUrlsIn } from '../lib/url'
import { computed } from 'vue'
import { Policy, Politician, PolicyStatus } from '../types'
import StatusBadge from './StatusBadge.vue'
import Avatar from './Avatar.vue'
import { Calendar, Tag, ChevronRight, ThumbsUp, Star, ThumbsDown, Flame } from 'lucide-vue-next'
import { policyYear } from '../lib/policy-date'
import { useCheckpoints } from '../composables/useCheckpoints'
import { useSupabase } from '../composables/useSupabase'

const props = withDefaults(defineProps<{
  policy: Policy
  politician: Politician
  onClick?: () => void
  /**
   * 卡片上要不要印政治人物（頭像、姓名、政黨）。
   * 2026-09-16 看人物頁：「裡面的卡片再一直重覆…就沒意義了吧」——
   * 已經在那個人的頁面上，每張卡再報一次名字是雜訊。清單混著多人時才需要。
   */
  showPolitician?: boolean
  /**
   * 要不要顯示狀態標籤。人物頁的「競選承諾」區塊是用 status 篩出來的，
   * 每張卡的標籤都是同一個「競選承諾」——2026-09-17：「我看起來都一樣…這個標籤就不要顯示了」。
   * 施政紀錄那一區有執行中／已完成／規劃中，標籤在那裡才有資訊。
   */
  showStatus?: boolean
}>(), { showPolitician: true, showStatus: true })

const isCampaign = props.policy.status === PolicyStatus.CAMPAIGN

// 用小卡（無期待度、無⭐）的兩種承諾（2026-09-18）：
//   1. 那場選舉已經投完票——支持或反對一個 2024 年的承諾改變不了任何事
//   2. 沒標屆別——不知道是哪一場，就不能當成進行中的來收集民意
// 「當選了沒」不拿來當依據：election_result 目前九成是空的。
const { elections } = useSupabase()
const isPastCampaign = computed(() => {
  if (!isCampaign) return false
  if (props.policy.electionId == null) return true
  const date = elections.value.find((e) => e.id === props.policy.electionId)?.electionDate
  return !!date && date < new Date().toISOString().slice(0, 10)
})

// 我的關注改走 useCheckpoints（2026-09-17）：原本這裡直接讀寫 localStorage，
// 四個地方各寫一份，而且登入與否毫無差別——換台機器就全沒了。
const { isCheckpointed: has, toggle, followCount, countsTowardFollows } = useCheckpoints()
const isCheckpointed = computed(() => has(props.policy.id))
// 🔥 關注數＝按了⭐的登入帳號數；自己剛按的立刻反映，不必等重新整理
const shownFollows = computed(() => followCount(props.policy.id, props.policy.stancePriority ?? 0))
// 那場選舉的結果：落選就標出來，順便解釋為什麼這張卡沒有進度可看。
// 查不到（過去選舉九成還是空的）就不標，不猜。
const campaignResult = computed(() => {
  if (!isCampaign || props.policy.electionId == null) return null
  return props.politician.elections?.find((e) => e.electionId === props.policy.electionId)?.electionResult ?? null
})

const starTitle = computed(() => {
  if (isCheckpointed.value) return '取消關注'
  return countsTowardFollows.value ? '加入我的關注' : '加入我的關注（登入後才會計入關注數）'
})

// 支持 vs 反對：左右互搶的比例長條。兩邊都 0 就不給寬度，長條整條灰——
// 不能畫成一半一半，那會讓人以為有人表態而且剛好平手。
const stanceTotal = computed(() => (props.policy.stanceSupport ?? 0) + (props.policy.stanceOppose ?? 0))
const supportPct = computed(() => (stanceTotal.value > 0 ? ((props.policy.stanceSupport ?? 0) / stanceTotal.value) * 100 : 0))
const opposePct = computed(() => (stanceTotal.value > 0 ? 100 - supportPct.value : 0))
const stanceLabel = computed(() => (stanceTotal.value > 0
  ? `支持 ${props.policy.stanceSupport ?? 0}、反對 ${props.policy.stanceOppose ?? 0}（支持 ${Math.round(supportPct.value)}%）`
  : '還沒有人表態'))

const toggleCheckpoint = (e: Event) => {
  e.stopPropagation()
  toggle(props.policy.id)
}
</script>

<template>
  <div
    :class="`bg-white rounded-2xl border shadow-sm hover:shadow-xl transition-all duration-300 cursor-pointer overflow-hidden group relative flex flex-col h-full ${isCampaign ? 'border-violet-100 hover:border-violet-300' : 'border-slate-200 hover:border-blue-300'}`"
    @click="onClick?.()"
  >
    <!-- Checkpoint Star -->
    <!-- 小卡下面沒有期待度長條，容器的底部內距與下面那行的 mb 會疊成一片空白 -->
    <div :class="['px-6 pt-6 flex-1 flex flex-col', isPastCampaign ? 'pb-2' : 'pb-6']">
      <div v-if="props.showPolitician || props.showStatus" :class="['flex items-start mb-4', props.showPolitician ? 'justify-between' : 'justify-start']">
        <div v-if="props.showPolitician" class="flex items-center gap-3">
          <Avatar :src="politician.avatarUrl" :name="politician.name" size="sm" class="border-2 border-slate-50 shadow-sm" />
          <div class="text-left">
            <span class="font-bold text-navy-900 block text-sm">{{ politician.name }}</span>
            <span class="text-[10px] font-black text-slate-400 uppercase tracking-widest">{{ politician.party }}</span>
          </div>
        </div>
        <StatusBadge v-if="props.showStatus" :status="policy.status" />
      </div>

      <!-- 收藏星星跟標題同一行：原本浮在右上角、還要 hover 才出現，跟狀態標籤也會疊到 -->
      <div class="flex items-start gap-2 mb-3">
        <h3 :class="`flex-1 text-lg font-black leading-tight transition-colors ${isCampaign ? 'text-violet-900 group-hover:text-violet-700' : 'text-navy-900 group-hover:text-blue-600'}`">
          {{ policy.title }}
        </h3>
        <button
          v-if="!isPastCampaign"
          @click.stop="toggleCheckpoint"
          :class="`shrink-0 -mt-1 p-1.5 rounded-full transition-colors ${isCheckpointed ? 'text-amber-500 hover:text-amber-600' : 'text-slate-300 hover:text-amber-400'}`"
          :title="starTitle"
          :aria-pressed="isCheckpointed"
        >
          <Star :size="18" :fill="isCheckpointed ? 'currentColor' : 'none'" />
        </button>
      </div>

      <p class="text-sm text-slate-500 line-clamp-2 mb-6 h-10 leading-relaxed font-medium">
        {{ shortUrlsIn(policy.description) }}
      </p>

      <div :class="['flex items-center gap-4 text-[10px] font-black text-slate-400 uppercase tracking-widest', isPastCampaign ? 'mb-0' : 'mb-6']">
        <div class="flex items-center gap-1.5">
          <Calendar :size="12" class="text-slate-300" />
          <span>{{ isCampaign ? `${policyYear(policy) ?? '—'} 承諾` : `${policy.lastUpdated.split('-')[0]} 更新` }}</span>
        </div>
        <div v-if="campaignResult" class="flex items-center gap-1.5">
          <span :class="['px-1.5 py-0.5 rounded-full', campaignResult === 'elected' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500']"
            :title="campaignResult === 'elected' ? '這場選舉當選' : '這場選舉未當選，所以不會有執行進度'">
            {{ campaignResult === 'elected' ? '當選' : '未當選' }}
          </span>
        </div>
        <div class="flex items-center gap-1.5">
          <Tag :size="12" class="text-slate-300" />
          <span>{{ policy.category }}</span>
        </div>
      </div>

      <!-- Progress Logic -->
      <!-- 讀者表態：支持從左、反對從右，互搶一條長條（2026-09-18）。
           兩邊數字都留在兩端：只秀比例會看不出是 1:1 還是 100:100。
           關注（🔥）不是支持或反對，不進長條：它是按了標題旁⭐的登入帳號數。 -->
      <!-- 支持從左、反對從右，互搶一條長條；標籤與關注數在底部那一排（2026-09-18） -->
      <div v-if="isCampaign && !isPastCampaign" class="mt-auto flex items-center gap-2 text-sm font-black tabular-nums" data-testid="stance-bar">
        <span class="flex items-center gap-1 text-violet-700 shrink-0" title="支持"><ThumbsUp :size="13" class="fill-current" />{{ policy.stanceSupport }}</span>
        <div class="flex-1 h-2 rounded-full overflow-hidden flex bg-slate-200" role="img" :aria-label="stanceLabel" :title="stanceLabel">
          <div class="h-full bg-violet-600 transition-all duration-700" :style="{ width: `${supportPct}%` }"></div>
          <div class="h-full bg-rose-500 transition-all duration-700" :style="{ width: `${opposePct}%` }"></div>
        </div>
        <span class="flex items-center gap-1 text-rose-600 shrink-0" title="反對">{{ policy.stanceOppose }}<ThumbsDown :size="13" class="fill-current" /></span>
      </div>
      <!-- 已投票那場的承諾：什麼都不放。進度條對它沒意義（沒當選就不會有執行進度，
           當選且有進度的話狀態早就不是「競選承諾」了，會落在人物頁的施政那一區） -->
      <div v-else-if="!isCampaign" class="mt-auto space-y-2">
        <div class="flex justify-between text-[10px] font-black text-slate-400 uppercase tracking-widest">
          <span>當前執行進度</span>
          <span>{{ policy.progress }}%</span>
        </div>
        <div class="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
          <div
            :class="`h-full rounded-full transition-all duration-1000 ${
              policy.status === PolicyStatus.ACHIEVED ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.3)]' :
              policy.status === PolicyStatus.FAILED ? 'bg-red-500' : 'bg-blue-600 shadow-[0_0_10px_rgba(37,99,235,0.3)]'
            }`"
            :style="{ width: `${policy.progress}%` }"
          ></div>
        </div>
      </div>
    </div>

    <!-- 期待度併進這一排（2026-09-18）：原本它自己一塊，卡片高度一變它就跟著上下跑。
         關注數與支持／反對都在同一行，右邊接詳情入口 -->
    <div :class="`${isCampaign ? 'bg-violet-50/30' : 'bg-slate-50/50'} px-6 py-3 border-t border-slate-100 flex items-center gap-3 group-hover:bg-white transition-colors`" data-testid="card-footer">
      <template v-if="isCampaign && !isPastCampaign">
        <span class="flex items-center gap-1 text-xs font-black tabular-nums text-amber-600 shrink-0" title="關注：按了⭐的登入帳號數"><Flame :size="13" />{{ shownFollows }}</span>
        <span class="text-[10px] font-black uppercase tracking-wider text-violet-700 shrink-0">選民期待度</span>
        <span class="text-slate-200 shrink-0">|</span>
      </template>
      <span :class="`text-[10px] font-black uppercase tracking-widest shrink-0 ${isCampaign ? 'text-violet-500' : 'text-slate-400'} ${isCampaign && !isPastCampaign ? '' : 'flex-1'}`">
        {{ isCampaign ? '查看承諾詳情' : '查看詳細歷程' }}
      </span>
      <ChevronRight :size="14" :class="`shrink-0 ml-auto ${isCampaign ? 'text-violet-300' : 'text-slate-300'} group-hover:translate-x-1 transition-transform`" />
    </div>
  </div>
</template>
