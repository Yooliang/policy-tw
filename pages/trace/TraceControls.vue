<script setup lang="ts">
// 卡片下方的說明文字（播放鈕、倍速、時間軸、搜尋、全屏都在圖表上方的 TraceToolbar）
import { computed } from 'vue'
import { speedLabel } from '../../lib/trace'

const props = defineProps<{
  mode: 'window' | 'events'
  speed: number
  windowMs: number
  reduced: boolean
}>()

const minutes = computed(() => Math.max(1, Math.round(props.windowMs / 1000 / props.speed / 60)))
</script>

<template>
  <div class="text-xs text-slate-400">
    <p v-if="mode === 'window'">
      近 4 小時的事件壓縮重播，{{ speedLabel('window', speed) }} 倍速約 {{ minutes }} 分鐘播完；可以拖時間軸跳到任何時刻。
    </p>
    <p v-else-if="reduced">你的裝置設定為減少動態，改成一件一件步進，不自動播放。</p>
  </div>
</template>
