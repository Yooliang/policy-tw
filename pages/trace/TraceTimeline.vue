<script setup lang="ts">
// 指定對象的事件時間軸：時間、跟上一件事隔多久、誰、發生什麼；等最久的幾段標出來。
import { computed, nextTick, ref, watch } from 'vue'
import { GROUP_COLOR, GROUP_LABEL, eventNote, eventText, gapText, groupOf, taipeiFull, type TraceItem } from '../../lib/trace'

const props = defineProps<{ items: TraceItem[]; current: number }>()
const emit = defineEmits<{ select: [index: number] }>()

const box = ref<HTMLElement | null>(null)

const gaps = computed(() => props.items.map((e, i) => (i === 0 ? 0 : e.ms - props.items[i - 1].ms)))
const longest = computed(() => {
  const top = gaps.value.map((g, i) => ({ g, i })).filter((x) => x.i > 0 && x.g >= 60_000).sort((a, b) => b.g - a.g).slice(0, 3)
  return new Set(top.map((x) => x.i))
})
/** 時間條寬度：對數刻度，1 分鐘以下幾乎沒有、數天填滿 */
const barPct = (g: number): number => (g < 1000 ? 0 : Math.min(100, (Math.log10(g / 1000) / Math.log10(14 * 86400)) * 100 + 4))

watch(() => props.current, async (i) => {
  await nextTick()
  const row = box.value?.querySelector<HTMLElement>(`[data-i="${i}"]`)
  const c = box.value
  if (!row || !c) return
  // 只捲動這個清單，不拖動整個頁面
  const top = row.offsetTop - c.offsetTop
  if (top < c.scrollTop || top + row.offsetHeight > c.scrollTop + c.clientHeight) c.scrollTop = Math.max(0, top - c.clientHeight / 3)
})
</script>

<template>
  <ol ref="box" class="max-h-[28rem] overflow-y-auto rounded border border-slate-200 bg-white divide-y divide-slate-100 relative" aria-label="事件時間軸">
    <li
      v-for="(e, i) in items"
      :key="i"
      :data-i="i"
      class="px-3 py-2 cursor-pointer hover:bg-slate-50"
      :class="i === current ? 'bg-amber-50' : ''"
      @click="emit('select', i)"
    >
      <button type="button" class="w-full text-left" :aria-current="i === current ? 'step' : undefined" @click.stop="emit('select', i)">
        <div class="flex items-center gap-2 text-xs text-slate-500 tabular-nums">
          <span>{{ taipeiFull(e.ms) }}</span>
          <span v-if="i > 0" class="text-slate-400">· 距上一件 {{ gapText(gaps[i]) }}</span>
          <span v-if="longest.has(i)" class="rounded bg-rose-100 px-1.5 py-0.5 text-rose-700 font-medium">等最久</span>
        </div>
        <div v-if="i > 0 && gaps[i] >= 1000" class="mt-1 h-1 rounded bg-slate-100" aria-hidden="true">
          <div class="h-1 rounded" :class="longest.has(i) ? 'bg-rose-400' : 'bg-slate-300'" :style="{ width: barPct(gaps[i]) + '%' }"></div>
        </div>
        <div class="mt-1 flex items-start gap-2">
          <span class="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-white" :style="{ background: GROUP_COLOR[groupOf(e.kind)] }">{{ GROUP_LABEL[groupOf(e.kind)] }}</span>
          <span class="text-sm text-slate-800 break-words min-w-0">
            {{ eventText(e) }}
            <span v-if="eventNote(e)" class="block text-xs text-slate-500 mt-0.5">{{ eventNote(e) }}</span>
          </span>
        </div>
      </button>
    </li>
  </ol>
</template>
