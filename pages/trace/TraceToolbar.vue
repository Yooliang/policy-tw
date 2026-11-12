<script setup lang="ts">
// 圖表上方的一條工具列：暫停／重來（圖示）、倍速、時間軸、搜尋（預設收成一顆圖示鈕）、全屏。
import { computed, nextTick, ref } from 'vue'
import { Maximize, Minimize, Pause, Play, RotateCcw, Search, SkipBack, SkipForward } from 'lucide-vue-next'
import { speedLabel, taipeiClock } from '../../lib/trace'

const props = defineProps<{
  mode: 'window' | 'events'
  playing: boolean
  speed: number
  speeds: number[]
  reduced: boolean
  loading: boolean
  /** 搜尋框的內容（任務編號、交件編號、人物編號或人名） */
  query: string
  /** 指定對象模式下，顯示「回全站」 */
  canResetScope: boolean
  fullscreenSupported: boolean
  fullscreen: boolean
  position: number
  windowStart: number
  windowMs: number
  count: number
}>()
const emit = defineEmits<{
  toggle: []
  restart: []
  prev: []
  next: []
  speed: [value: number]
  'update:query': [value: string]
  search: []
  all: []
  seek: [value: number]
  'toggle-fullscreen': []
}>()

const max = computed(() => (props.mode === 'window' ? props.windowMs : Math.max(0, props.count - 1)))
const step = computed(() => (props.mode === 'window' ? 1000 : 1))
const sliderValue = computed(() => Math.min(props.position, max.value))
const percent = computed(() => (max.value > 0 ? Math.round((sliderValue.value / max.value) * 1000) / 10 : 0))
const clock = computed(() => (props.mode === 'window' ? taipeiClock(props.windowStart + props.position) : `${Math.min(props.count, Math.floor(props.position) + 1)} / ${props.count}`))

function onSlide(e: Event): void {
  emit('seek', Number((e.target as HTMLInputElement).value))
}

const open = ref(false)
const inputEl = ref<HTMLInputElement | null>(null)
const searchBtn = ref<HTMLButtonElement | null>(null)
const btn = 'inline-flex h-9 min-w-[36px] items-center justify-center gap-1 rounded border border-slate-300 bg-white px-2 text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-sky-400'

async function onSearchButton(): Promise<void> {
  // 載入中不能用 disabled（會讓焦點掉到頁頂），改成 aria-disabled 並略過
  if (props.loading) return
  if (!open.value) {
    open.value = true
    await nextTick()
    inputEl.value?.focus()
    return
  }
  emit('search')
}

async function close(): Promise<void> {
  open.value = false
  await nextTick()
  searchBtn.value?.focus()
}

function onInput(e: Event): void {
  emit('update:query', (e.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 text-sm text-slate-700" role="toolbar" aria-label="重播控制">
    <button
      v-if="!props.reduced"
      type="button"
      :class="btn"
      :aria-label="props.playing ? '暫停' : '播放'"
      :title="props.playing ? '暫停' : '播放'"
      @click="emit('toggle')"
    >
      <Pause v-if="props.playing" :size="16" aria-hidden="true" />
      <Play v-else :size="16" aria-hidden="true" />
    </button>
    <button type="button" :class="btn" aria-label="重來" title="重來（回到開頭）" @click="emit('restart')">
      <RotateCcw :size="16" aria-hidden="true" />
    </button>
    <template v-if="props.mode === 'events' || props.reduced">
      <button type="button" :class="btn" aria-label="上一件事" title="上一件事" @click="emit('prev')"><SkipBack :size="16" aria-hidden="true" /></button>
      <button type="button" :class="btn" aria-label="下一件事" title="下一件事" @click="emit('next')"><SkipForward :size="16" aria-hidden="true" /></button>
    </template>

    <span v-if="!props.reduced" class="inline-flex overflow-hidden rounded border border-slate-300 text-xs" role="group" aria-label="播放速度">
      <button
        v-for="(s, i) in props.speeds"
        :key="s"
        type="button"
        class="h-9 px-2.5 tabular-nums"
        :class="[props.speed === s ? 'bg-slate-800 text-white' : 'bg-white hover:bg-slate-50', i > 0 ? 'border-l border-slate-300' : '']"
        :aria-pressed="props.speed === s"
        @click="emit('speed', s)"
      >{{ speedLabel(props.mode, s) }}</button>
    </span>

    <div class="flex min-w-[200px] flex-1 items-center gap-3">
      <input
        type="range"
        class="trace-range min-w-0 flex-1"
        :style="{ '--p': percent + '%' }"
        :min="0"
        :max="max"
        :step="step"
        :value="sliderValue"
        :aria-label="props.mode === 'window' ? '時間軸' : '第幾件事'"
        @input="onSlide"
      />
      <span class="shrink-0 text-xs tabular-nums text-slate-600 sm:text-sm">{{ clock }}</span>
    </div>

    <div class="flex items-center gap-2">
      <button v-if="props.canResetScope" type="button" class="h-9 rounded border border-slate-300 bg-white px-3 text-xs hover:bg-slate-50" @click="emit('all')">全站近 4 小時</button>
      <form class="flex items-center gap-2" role="search" @submit.prevent>
        <label class="sr-only" for="trace-input">任務編號、交件編號、人物編號或人名</label>
        <input
          v-if="open"
          id="trace-input"
          ref="inputEl"
          :value="props.query"
          type="text"
          inputmode="search"
          autocomplete="off"
          placeholder="任務、交件編號或人名（留白＝全站）"
          class="h-9 w-44 rounded border border-slate-300 bg-white px-3 text-base focus:outline-none focus:ring-2 focus:ring-sky-400 sm:w-80 sm:text-sm"
          @input="onInput"
          @keydown.enter.prevent="emit('search')"
          @keydown.esc.prevent.stop="close"
        />
        <button
          type="button"
          ref="searchBtn"
          :class="[btn, props.loading ? 'opacity-50' : '']"
          :aria-disabled="props.loading"
          :aria-expanded="open"
          aria-label="搜尋"
          :title="open ? '送出搜尋（Esc 收起）' : '搜尋任務、交件或人物'"
          @click="onSearchButton"
        >
          <Search :size="16" aria-hidden="true" />
        </button>
      </form>
      <button
        v-if="props.fullscreenSupported"
        type="button"
        :class="btn"
        :aria-label="props.fullscreen ? '退出全屏' : '全屏'"
        :title="props.fullscreen ? '退出全屏' : '全屏'"
        :aria-pressed="props.fullscreen"
        @click="emit('toggle-fullscreen')"
      >
        <Minimize v-if="props.fullscreen" :size="16" aria-hidden="true" />
        <Maximize v-else :size="16" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style>
/* 時間軸：圓點平常藏起來，滑鼠移到軸上、鍵盤聚焦或拖曳時才出現（拖曳行為是原生的，沒動） */
.trace-range { -webkit-appearance: none; appearance: none; height: 18px; background: transparent; cursor: pointer; --fill: #334155; --rest: #cbd5e1; }
html.dark .trace-range { --fill: #94a3b8; --rest: #475569; }
.trace-range:focus { outline: none; }
.trace-range::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(to right, var(--fill) var(--p), var(--rest) var(--p)); }
.trace-range::-moz-range-track { height: 4px; border-radius: 2px; background: var(--rest); }
.trace-range::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--fill); }
.trace-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 14px; height: 14px; margin-top: -5px; border-radius: 50%; border: 0; background: var(--fill); opacity: 0; transition: opacity 0.12s; }
.trace-range::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; border: 0; background: var(--fill); opacity: 0; transition: opacity 0.12s; }
.trace-range:hover::-webkit-slider-thumb, .trace-range:focus-visible::-webkit-slider-thumb, .trace-range:active::-webkit-slider-thumb { opacity: 1; }
.trace-range:hover::-moz-range-thumb, .trace-range:focus-visible::-moz-range-thumb, .trace-range:active::-moz-range-thumb { opacity: 1; }
.trace-range:focus-visible { outline: 2px solid #38bdf8; outline-offset: 2px; border-radius: 4px; }
</style>
