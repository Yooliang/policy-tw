<script setup lang="ts">
// 時間軸與說明文字（播放鈕、倍速、搜尋、全屏都在圖表上方的 TraceToolbar）
import { computed } from 'vue'
import { speedLabel, taipeiClock } from '../../lib/trace'

const props = defineProps<{
  mode: 'window' | 'events'
  speed: number
  position: number
  windowStart: number
  windowMs: number
  count: number
  reduced: boolean
}>()
const emit = defineEmits<{ seek: [value: number] }>()

const max = computed(() => (props.mode === 'window' ? props.windowMs : Math.max(0, props.count - 1)))
const step = computed(() => (props.mode === 'window' ? 1000 : 1))
const sliderValue = computed(() => Math.min(props.position, max.value))
const clock = computed(() => (props.mode === 'window' ? taipeiClock(props.windowStart + props.position) : ''))
const eventNo = computed(() => Math.min(props.count, Math.floor(props.position) + 1))
const minutes = computed(() => Math.max(1, Math.round(props.windowMs / 1000 / props.speed / 60)))

function onSlide(e: Event): void {
  emit('seek', Number((e.target as HTMLInputElement).value))
}
</script>

<template>
  <div class="flex flex-col gap-2 text-sm text-slate-700">
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
      近 4 小時的事件壓縮重播，{{ speedLabel('window', speed) }} 倍速約 {{ minutes }} 分鐘播完；可以拖時間軸跳到任何時刻。
    </p>
    <p v-else-if="reduced" class="text-xs text-slate-400">你的裝置設定為減少動態，改成一件一件步進，不自動播放。</p>
  </div>
</template>
