<script setup lang="ts">
import { computed, ref } from 'vue'
import { needsCollapse, segmentText, splitParagraphs } from '../lib/rich-text'

/**
 * 時間軸條目的內文：依序號與換行分段、網址只顯示網域（可點）、太長預設收合。
 * 收合只用 CSS 遮住下半段，全文一直在 DOM 裡（爬蟲與讀螢幕的人都讀得到）。
 */
const props = withDefaults(defineProps<{ text: string | null | undefined; struck?: boolean }>(), { struck: false })

const paragraphs = computed(() => splitParagraphs(props.text).map((p) => segmentText(p)))
const collapsible = computed(() => needsCollapse(props.text))
const collapsed = ref(true)
const isCollapsed = computed(() => collapsible.value && collapsed.value)
</script>

<template>
  <div data-testid="rich-text">
    <div :class="['relative space-y-1.5 text-xs text-navy-900 leading-snug break-words', struck ? 'line-through decoration-slate-400 text-slate-500' : '', isCollapsed ? 'max-h-[6.25rem] overflow-hidden' : '']" :data-collapsed="isCollapsed">
      <p v-for="(segs, i) in paragraphs" :key="i">
        <template v-for="(s, j) in segs" :key="j">
          <a v-if="s.type === 'link'" :href="s.href" rel="noopener nofollow" target="_blank" class="text-blue-700 underline underline-offset-2" @click.stop>{{ s.label }}</a>
          <template v-else>{{ s.text }}</template>
        </template>
      </p>
      <div v-if="isCollapsed" class="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-white to-transparent"></div>
    </div>
    <button v-if="collapsible" type="button" class="mt-1 text-xs text-blue-700 hover:underline" :aria-expanded="!collapsed" data-testid="rich-text-toggle" @click.stop="collapsed = !collapsed">{{ collapsed ? '展開全文' : '收合' }}</button>
  </div>
</template>
