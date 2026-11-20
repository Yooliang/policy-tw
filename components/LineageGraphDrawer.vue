<script setup lang="ts">
/**
 * 完整關係圖的側邊抽屜（#675 第四期；手機是底部抽屜）：點圖上的標籤、箭頭或清單的一筆，顯示原文摘句、出處連結（有存檔附存檔）、
 * 出處位置、日期、備註。按 Esc 或點背景關閉。字全取自 lib/lineage-page-labels.ts。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { X } from 'lucide-vue-next'
import type { GraphItem } from '../lib/lineage-graph-types'
import { formatStatedDate } from '../lib/lineage-page'
import { PAGE_LABELS as T } from '../lib/lineage-page-labels'
import LineageSourceLink from './LineageSourceLink.vue'

const props = defineProps<{ item: GraphItem | null }>()
const emit = defineEmits<{ close: [] }>()
const closeButton = ref<HTMLButtonElement | null>(null)

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.item) emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
watch(() => props.item?.id, async (id) => {
  if (!id) return
  await nextTick()
  closeButton.value?.focus()
})
</script>

<template>
  <div v-if="item" class="fixed inset-0 z-50" data-testid="lineage-graph-drawer">
    <div class="absolute inset-0 bg-slate-900/40" data-testid="lineage-graph-backdrop" @click="emit('close')"></div>
    <aside
      role="dialog" aria-modal="true" :aria-label="item.label"
      class="absolute inset-x-0 bottom-0 max-h-[75vh] overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl sm:inset-y-0 sm:left-auto sm:right-0 sm:bottom-auto sm:max-h-none sm:w-[26rem] sm:rounded-none"
    >
      <div class="flex items-start justify-between gap-3 mb-3">
        <div class="min-w-0">
          <p class="text-xs text-slate-500 tabular-nums">{{ formatStatedDate(item.detail.date, item.detail.datePrecision) }}<template v-if="item.place">　{{ item.place }}</template></p>
          <h2 class="text-lg font-bold text-navy-900 break-words">{{ item.label }}</h2>
        </div>
        <button ref="closeButton" type="button" :aria-label="T.close" class="shrink-0 rounded-full p-2 text-slate-500 hover:bg-slate-100" @click="emit('close')"><X :size="18" /></button>
      </div>

      <div v-if="item.disputed" class="mb-3"><span class="px-2 py-0.5 rounded text-xs font-bold bg-red-50 text-red-700 border border-red-200">{{ T.disputed }}</span></div>

      <dl class="space-y-3 text-sm text-slate-800">
        <div v-if="item.detail.person">
          <dt class="text-xs font-bold text-slate-500">{{ T.person }}</dt>
          <dd>
            <RouterLink :to="`/politician/${item.detail.person.id}`" class="font-bold text-blue-700 hover:underline">{{ item.detail.person.name }}</RouterLink>
            <template v-if="item.detail.toPerson"> → <RouterLink :to="`/politician/${item.detail.toPerson.id}`" class="font-bold text-blue-700 hover:underline">{{ item.detail.toPerson.name }}</RouterLink></template>
          </dd>
        </div>
        <div v-if="item.detail.quote">
          <dt class="text-xs font-bold text-slate-500">{{ T.quote }}</dt>
          <dd><blockquote class="border-l-4 border-slate-300 pl-3 text-slate-700 break-words">{{ item.detail.quote }}</blockquote></dd>
        </div>
        <div v-if="item.detail.condition">
          <dt class="text-xs font-bold text-slate-500">{{ T.condition }}</dt>
          <dd class="break-words">{{ item.detail.condition }}</dd>
        </div>
        <div v-if="item.detail.text && item.kind !== 'stance'">
          <dd class="break-words leading-relaxed">{{ item.detail.text }}</dd>
        </div>
        <div v-if="item.detail.decidedBy">
          <dt class="text-xs font-bold text-slate-500">{{ T.decidedBy }}</dt>
          <dd>{{ item.detail.decidedBy }}</dd>
        </div>
        <div v-if="item.detail.initiator">
          <dt class="text-xs font-bold text-slate-500">{{ T.initiator }}</dt>
          <dd>
            <RouterLink :to="`/politician/${item.detail.initiator.id}`" class="font-bold text-blue-700 hover:underline">{{ item.detail.initiator.name }}</RouterLink>
            <template v-if="item.detail.initiator.note">　{{ item.detail.initiator.note }}</template>
          </dd>
        </div>
        <div v-if="item.detail.note && !item.detail.initiator">
          <dt class="text-xs font-bold text-slate-500">{{ T.note }}</dt>
          <dd class="break-words">{{ item.detail.note }}</dd>
        </div>
        <div v-if="item.detail.sourceUrl">
          <dt class="text-xs font-bold text-slate-500">{{ T.source }}</dt>
          <dd class="break-words"><LineageSourceLink :source="item.detail.source" :url="item.detail.sourceUrl" /></dd>
        </div>
        <div v-if="item.detail.sourceLocator">
          <dt class="text-xs font-bold text-slate-500">{{ T.locator }}</dt>
          <dd class="break-words">{{ item.detail.sourceLocator }}</dd>
        </div>
        <div v-if="item.detail.policyId">
          <RouterLink :to="`/policy/${item.detail.policyId}`" class="font-bold text-blue-700 hover:underline">{{ T.policyPage }}</RouterLink>
        </div>
      </dl>
    </aside>
  </div>
</template>
