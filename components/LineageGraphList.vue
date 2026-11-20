<script setup lang="ts">
/**
 * 完整關係圖的時序清單（#675 第四期）：手機（≤ 640 px）是頁面主體——直式時間軸，新到舊、依年分組、頂端晶片篩選；
 * 桌機是圖下方給讀屏軟體的同內容清單（variant=a11y，視覺上隱藏）。吃的是 lib/lineage-graph.ts 的 items，跟圖上的標籤同一份、id 相同。
 */
import { computed, ref } from 'vue'
import { AlertCircle, ArrowRight, CalendarClock, FileText, Scale } from 'lucide-vue-next'
import type { GraphItem } from '../lib/lineage-graph-types'
import { TONE_COLOR, EVENT_COLOR } from '../lib/lineage-graph-types'
import { ALL_PLACES, filterItemsByPlace, groupItemsByYear, placeChips } from '../lib/lineage-graph-list'
import { formatStatedDate } from '../lib/lineage-page'
import { PAGE_LABELS as T } from '../lib/lineage-page-labels'

const props = defineProps<{ items: readonly GraphItem[]; variant: 'main' | 'a11y'; selectedId: string | null }>()
const emit = defineEmits<{ select: [id: string] }>()

const place = ref(ALL_PLACES)
const chips = computed(() => placeChips(props.items))
const groups = computed(() => groupItemsByYear(props.variant === 'main' ? filterItemsByPlace(props.items, place.value) : props.items))
const ICON = { policy: FileText, stance: Scale, event: CalendarClock, handover: ArrowRight, gap: AlertCircle } as const
const colorOf = (it: GraphItem): string => (it.kind === 'event' ? EVENT_COLOR : TONE_COLOR[it.tone] ?? '#64748b')
</script>

<template>
  <section :class="variant === 'a11y' ? 'sr-only' : ''" data-testid="lineage-graph-list" :data-variant="variant">
    <h2 :class="variant === 'a11y' ? '' : 'text-lg font-bold text-navy-900 mb-3'">{{ T.timeline }}</h2>

    <!-- 頂端晶片篩選：全部／各地方 -->
    <div v-if="variant === 'main' && chips.length > 2" class="flex gap-2 overflow-x-auto pb-2 mb-3" data-testid="lineage-graph-chips">
      <button
        v-for="c in chips" :key="c.key" type="button" :aria-pressed="place === c.key"
        :class="['shrink-0 px-3 py-1 rounded-full text-sm font-bold border', place === c.key ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-700 border-slate-300']"
        @click="place = c.key"
      >{{ c.label }} {{ c.count }}</button>
    </div>

    <div v-for="g in groups" :key="g.year || 'undated'" class="mb-5">
      <h3 class="text-sm font-black text-slate-500 mb-2">{{ g.year || T.undated }}<template v-if="g.year">{{ T.yearUnit }}</template></h3>
      <ol class="space-y-2">
        <li v-for="it in g.items" :key="it.id">
          <button
            type="button" :tabindex="variant === 'a11y' ? -1 : 0" :data-item-id="it.id" :data-kind="it.kind" :aria-current="selectedId === it.id"
            :class="['w-full text-left rounded-lg border px-3 py-2 flex items-start gap-3', selectedId === it.id ? 'border-blue-500 bg-blue-50' : 'border-slate-200 bg-white']"
            @click="emit('select', it.id)"
          >
            <component :is="ICON[it.kind]" :size="18" class="mt-0.5 shrink-0" :style="{ color: colorOf(it) }" />
            <span class="min-w-0 flex-1">
              <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
                <span v-if="it.date" class="tabular-nums">{{ formatStatedDate(it.date, it.detail.datePrecision) }}</span>
                <span v-if="it.place">{{ it.place }}</span>
                <span v-if="it.person" class="font-bold text-slate-700">{{ it.person }}</span>
                <span v-if="it.disputed" class="font-bold text-red-700">{{ T.disputed }}</span>
              </span>
              <span class="block text-sm text-slate-800 break-words"><span class="font-bold" :style="{ color: colorOf(it) }">{{ it.label }}</span><template v-if="it.text">　{{ it.text }}</template></span>
            </span>
          </button>
        </li>
      </ol>
    </div>
    <p v-if="groups.length === 0" class="text-sm text-slate-500">{{ T.chronicleEmpty }}</p>
  </section>
</template>
