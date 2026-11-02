<script setup lang="ts">
import { ref } from 'vue'
import { ChevronLeft, ChevronRight, GripVertical } from 'lucide-vue-next'
import type { DimDef } from '../../lib/model-flow'

/**
 * 分流圖的維度順序：標籤可以拖曳換位置（桌機），每個標籤兩側也有左右箭頭可以點（手機）。
 * 順序由外層持有（寫進網址），這裡只送出新的完整順序。
 */
const props = defineProps<{ dims: readonly DimDef[]; order: readonly string[]; name: string }>()
const emit = defineEmits<{ (e: 'update:order', v: string[]): void }>()

const labelOf = (id: string) => props.dims.find((d) => d.id === id)?.label ?? id
const dragging = ref<number | null>(null)
const over = ref<number | null>(null)

function move(from: number, to: number) {
  if (from === to || to < 0 || to >= props.order.length) return
  const next = [...props.order]
  const [x] = next.splice(from, 1)
  next.splice(to, 0, x)
  emit('update:order', next)
}
function onDrop(to: number) {
  if (dragging.value !== null) move(dragging.value, to)
  dragging.value = null
  over.value = null
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-1.5" role="group" :aria-label="`${name}的維度順序`" :data-testid="`flow-dims-${name}`">
    <span class="text-xs text-slate-400 whitespace-nowrap">順序</span>
    <template v-for="(id, i) in order" :key="id">
      <ChevronRight v-if="i > 0" :size="12" class="text-slate-300 shrink-0" aria-hidden="true" />
      <div draggable="true"
        :class="['inline-flex items-center rounded-lg border text-xs font-bold select-none bg-white', over === i && dragging !== i ? 'border-blue-500 ring-1 ring-blue-300' : 'border-slate-200', dragging === i ? 'opacity-40' : '']"
        :data-testid="`flow-dim-${id}`"
        @dragstart="dragging = i" @dragend="dragging = null; over = null"
        @dragover.prevent="over = i" @dragleave="over === i && (over = null)" @drop.prevent="onDrop(i)">
        <button type="button" class="px-1 py-1 text-slate-400 hover:text-blue-600 disabled:opacity-25 disabled:hover:text-slate-400" :disabled="i === 0"
          :aria-label="`${labelOf(id)}往前移`" @click="move(i, i - 1)"><ChevronLeft :size="14" /></button>
        <span class="inline-flex items-center gap-0.5 px-0.5 text-navy-900 cursor-grab whitespace-nowrap"><GripVertical :size="12" class="text-slate-300" aria-hidden="true" />{{ labelOf(id) }}</span>
        <button type="button" class="px-1 py-1 text-slate-400 hover:text-blue-600 disabled:opacity-25 disabled:hover:text-slate-400" :disabled="i === order.length - 1"
          :aria-label="`${labelOf(id)}往後移`" @click="move(i, i + 1)"><ChevronRight :size="14" /></button>
      </div>
    </template>
  </div>
</template>
