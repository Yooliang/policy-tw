<script setup lang="ts">
/**
 * 政見三要素（數值目標・達成期限・財源）一條政見的三格（#364；日本站 keifu 的 PledgeElements 同一個元件）。
 *
 * 三種狀態分開標，不能混：原文有寫 → 原文的字；查過原文沒寫 →「未說明」；還沒有人查 →「未調查」。
 * 規則在 lib/policy-elements.ts。compact 是並排比較的格子用：只印字，不印出處與原句位置。
 * 出處一律真連結（<a href>），預渲染的 HTML 就看得到。
 */
import { computed } from 'vue'
import type { PolicyElement } from '../types'
import { anyChecked, cellText, elementCells, sourceLabel, UNCHECKED_LABEL } from '../lib/policy-elements'

const props = defineProps<{
  elements?: PolicyElement[] | null
  /** 並排比較的格子：一行一個要素、不印出處 */
  compact?: boolean
}>()

const cells = computed(() => elementCells(props.elements))
const allUnchecked = computed(() => !anyChecked(props.elements))

/** 狀態標的樣式：未說明＝琥珀色實線框，未調查＝灰色虛線框（深色模式由 styles/main.css 統一換色） */
const BADGE: Record<string, string> = {
  not_stated: 'bg-amber-50 text-amber-800 border border-amber-200',
  unchecked: 'bg-slate-50 text-slate-500 border border-dashed border-slate-300',
}
</script>

<template>
  <!-- 並排比較的格子裡三個都還沒查：縮成一個「未調查」，不要每條政見都疊三個（上線初期幾乎全部是這樣）。
       標籤旁不加說明文字（小良哥 10-06：只留標籤本身） -->
  <p v-if="compact && allUnchecked" class="text-xs leading-snug" data-testid="policy-elements-compact" data-state="unchecked">
    <span :class="['inline-block px-1.5 rounded text-[11px] font-bold', BADGE.unchecked]">{{ UNCHECKED_LABEL }}</span>
  </p>
  <dl v-else-if="compact" class="space-y-1 text-xs leading-snug" data-testid="policy-elements-compact">
    <div v-for="c in cells" :key="c.kind" class="flex items-start gap-1.5" :data-state="c.state">
      <dt class="shrink-0 w-[4.5em] text-slate-500">{{ c.label }}</dt>
      <dd class="min-w-0">
        <span v-if="c.state === 'stated'" class="text-slate-800 break-words">{{ c.text }}</span>
        <span v-else :class="['inline-block px-1.5 rounded text-[11px] font-bold', BADGE[c.state]]">{{ cellText(c) }}</span>
      </dd>
    </div>
  </dl>

  <dl v-else class="divide-y divide-slate-100" data-testid="policy-elements">
    <div v-for="c in cells" :key="c.kind" class="py-3 first:pt-0 last:pb-0 sm:grid sm:grid-cols-[6.5rem_1fr] sm:gap-4" :data-state="c.state">
      <dt class="text-sm font-bold text-slate-500 mb-1 sm:mb-0">{{ c.label }}</dt>
      <dd class="min-w-0">
        <p v-if="c.state === 'stated'" class="text-navy-900 leading-relaxed break-words">
          {{ c.text }}
          <span v-if="c.deadlineDate" class="ml-1 text-xs text-slate-500 whitespace-nowrap">（換算到 {{ c.deadlineDate }}）</span>
        </p>
        <p v-else>
          <span :class="['inline-block px-2 py-0.5 rounded text-xs font-bold', BADGE[c.state]]">{{ cellText(c) }}</span>
        </p>
        <p v-if="c.state !== 'unchecked' && (c.sourceLocator || c.source)" class="mt-1 text-xs text-slate-500 leading-relaxed break-words">
          <template v-if="c.sourceLocator">原句位置：{{ c.sourceLocator }}</template>
          <template v-if="c.source">
            <span v-if="c.sourceLocator" class="text-slate-300">｜</span>出處：<a :href="c.source.url" target="_blank" rel="noopener noreferrer" class="text-blue-700 underline underline-offset-2 break-all">{{ sourceLabel(c.source) }}</a>
            <template v-if="c.source.archiveUrl">（<a :href="c.source.archiveUrl" target="_blank" rel="noopener noreferrer" class="text-blue-700 underline underline-offset-2">存檔</a>）</template>
          </template>
        </p>
      </dd>
    </div>
  </dl>
</template>
