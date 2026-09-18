<script setup lang="ts">
import { computed } from 'vue'
import { Policy, Politician, PolicyStatus } from '../types'
import StatusBadge from './StatusBadge.vue'
import Avatar from './Avatar.vue'
import { Calendar, Tag, ChevronRight, ThumbsUp, Star, ThumbsDown, Flame } from 'lucide-vue-next'
import { policyYear } from '../lib/policy-date'
import { useCheckpoints } from '../composables/useCheckpoints'

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

// 我的追蹤改走 useCheckpoints（2026-09-17）：原本這裡直接讀寫 localStorage，
// 四個地方各寫一份，而且登入與否毫無差別——換台機器就全沒了。
const { isCheckpointed: has, toggle } = useCheckpoints()
const isCheckpointed = computed(() => has(props.policy.id))

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
    <div class="p-6 flex-1">
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
          @click.stop="toggleCheckpoint"
          :class="`shrink-0 -mt-1 p-1.5 rounded-full transition-colors ${isCheckpointed ? 'text-amber-500 hover:text-amber-600' : 'text-slate-300 hover:text-amber-400'}`"
          :title="isCheckpointed ? '移除檢核點' : '加入我的檢核點'"
          :aria-pressed="isCheckpointed"
        >
          <Star :size="18" :fill="isCheckpointed ? 'currentColor' : 'none'" />
        </button>
      </div>

      <p class="text-sm text-slate-500 line-clamp-2 mb-6 h-10 leading-relaxed font-medium">
        {{ policy.description }}
      </p>

      <div class="flex items-center gap-4 text-[10px] font-black text-slate-400 mb-6 uppercase tracking-widest">
        <div class="flex items-center gap-1.5">
          <Calendar :size="12" class="text-slate-300" />
          <span>{{ isCampaign ? `${policyYear(policy) ?? '—'} 承諾` : `${policy.lastUpdated.split('-')[0]} 更新` }}</span>
        </div>
        <div class="flex items-center gap-1.5">
          <Tag :size="12" class="text-slate-300" />
          <span>{{ policy.category }}</span>
        </div>
      </div>

      <!-- Progress Logic -->
      <!-- 讀者表態：支持從左、反對從右，互搶一條長條（2026-09-18）。
           兩邊數字都留在兩端：只秀比例會看不出是 1:1 還是 100:100。關注不是支持或反對，不進長條。 -->
      <div v-if="isCampaign" class="bg-violet-50 rounded-xl p-3 space-y-2" data-testid="stance-bar">
        <div class="flex items-center justify-between">
          <span class="text-[10px] font-black uppercase tracking-wider text-violet-700">選民期待度</span>
          <span class="flex items-center gap-1 text-xs font-black tabular-nums text-amber-600" title="關注"><Flame :size="13" />{{ policy.stancePriority }}</span>
        </div>
        <div class="flex items-center gap-2 text-sm font-black tabular-nums">
          <span class="flex items-center gap-1 text-violet-700 shrink-0" title="支持"><ThumbsUp :size="13" class="fill-current" />{{ policy.stanceSupport }}</span>
          <div class="flex-1 h-2 rounded-full overflow-hidden flex bg-slate-200" role="img" :aria-label="stanceLabel" :title="stanceLabel">
            <div class="h-full bg-violet-600 transition-all duration-700" :style="{ width: `${supportPct}%` }"></div>
            <div class="h-full bg-rose-500 transition-all duration-700" :style="{ width: `${opposePct}%` }"></div>
          </div>
          <span class="flex items-center gap-1 text-rose-600 shrink-0" title="反對">{{ policy.stanceOppose }}<ThumbsDown :size="13" class="fill-current" /></span>
        </div>
      </div>
      <div v-else class="space-y-2">
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

    <div :class="`${isCampaign ? 'bg-violet-50/30' : 'bg-slate-50/50'} px-6 py-4 border-t border-slate-100 flex justify-between items-center group-hover:bg-white transition-colors`">
      <span :class="`text-[10px] font-black uppercase tracking-widest ${isCampaign ? 'text-violet-500' : 'text-slate-400'}`">
        {{ isCampaign ? '查看承諾詳情' : '查看詳細歷程' }}
      </span>
      <ChevronRight :size="14" :class="`${isCampaign ? 'text-violet-300' : 'text-slate-300'} group-hover:translate-x-1 transition-transform`" />
    </div>
  </div>
</template>
