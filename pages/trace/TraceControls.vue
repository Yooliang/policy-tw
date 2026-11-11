<script setup lang="ts">
import { computed } from 'vue'
import { Pause, Play, RotateCcw, SkipBack, SkipForward } from 'lucide-vue-next'
import { taipeiClock } from '../../lib/trace'

const props = defineProps<{
  mode: 'window' | 'events'
  playing: boolean
  speed: number
  speeds: number[]
  position: number
  windowStart: number
  windowMs: number
  count: number
  reduced: boolean
}>()
const emit = defineEmits<{
  toggle: []
  restart: []
  seek: [value: number]
  speed: [value: number]
  prev: []
  next: []
}>()

const max = computed(() => (props.mode === 'window' ? props.windowMs : Math.max(0, props.count - 1)))
const step = computed(() => (props.mode === 'window' ? 1000 : 1))
const sliderValue = computed(() => Math.min(props.position, max.value))
const clock = computed(() => (props.mode === 'window' ? taipeiClock(props.windowStart + props.position) : ''))
const eventNo = computed(() => Math.min(props.count, Math.floor(props.position) + 1))
const minutes = computed(() => Math.max(1, Math.round(props.windowMs / 1000 / props.speed / 60)))
const speedLabel = (s: number): string => (props.mode === 'window' ? `${s}×` : `${s}×`)

function onSlide(e: Event): void {
  emit('seek', Number((e.target as HTMLInputElement).value))
}
</script>

<template>
  <div class="flex flex-col gap-2 text-sm text-slate-700">
    <div class="flex flex-wrap items-center gap-2">
      <button
        v-if="!reduced"
        type="button"
        class="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-50 min-h-[36px]"
        :aria-label="playing ? '暫停' : '播放'"
        @click="emit('toggle')"
      >
        <Pause v-if="playing" :size="16" />
        <Play v-else :size="16" />
        {{ playing ? '暫停' : '播放' }}
      </button>
      <button type="button" class="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1.5 hover:bg-slate-50 min-h-[36px]" aria-label="回到開頭" @click="emit('restart')">
        <RotateCcw :size="16" /> 重來
      </button>
      <template v-if="mode === 'events' || reduced">
        <button type="button" class="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1.5 hover:bg-slate-50 min-h-[36px]" aria-label="上一件事" @click="emit('prev')">
          <SkipBack :size="16" /> 上一件
        </button>
        <button type="button" class="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1.5 hover:bg-slate-50 min-h-[36px]" aria-label="下一件事" @click="emit('next')">
          下一件 <SkipForward :size="16" />
        </button>
      </template>
      <span v-if="!reduced" class="ml-auto inline-flex items-center gap-1" role="group" aria-label="播放速度">
        <span class="text-slate-500 text-xs">{{ mode === 'window' ? '倍速' : '速度' }}</span>
        <span class="inline-flex overflow-hidden rounded border border-slate-300 text-xs">
          <button
            v-for="(s, i) in speeds"
            :key="s"
            type="button"
            class="px-2.5 py-1.5 min-h-[36px] tabular-nums"
            :class="[speed === s ? 'bg-slate-800 text-white' : 'bg-white hover:bg-slate-50', i > 0 ? 'border-l border-slate-300' : '']"
            :aria-pressed="speed === s"
            @click="emit('speed', s)"
          >{{ speedLabel(s) }}</button>
        </span>
      </span>
    </div>
    <div class="flex items-center gap-3">
      <input
        type="range"
        class="flex-1 min-w-0 accent-slate-700"
        :min="0"
        :max="max"
        :step="step"
        :value="sliderValue"
        :aria-label="mode === 'window' ? '時間軸' : '第幾件事'"
        @input="onSlide"
      />
      <span class="shrink-0 tabular-nums text-slate-600 text-xs sm:text-sm">
        <template v-if="mode === 'window'">{{ clock }}</template>
        <template v-else>{{ eventNo }} / {{ count }}</template>
      </span>
    </div>
    <p v-if="mode === 'window'" class="text-xs text-slate-400">
      近 4 小時的事件壓縮重播，{{ speed }} 倍速約 {{ minutes }} 分鐘播完；可以拖時間軸跳到任何時刻。
    </p>
    <p v-else-if="reduced" class="text-xs text-slate-400">你的裝置設定為減少動態，改成一件一件步進，不自動播放。</p>
  </div>
</template>
