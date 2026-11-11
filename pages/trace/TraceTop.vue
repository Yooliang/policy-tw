<script setup lang="ts">
// 近 4 小時最活躍的任務與人物（事件數）；點一個切到指定對象的重播。
import { computed } from 'vue'
import type { Active } from '../../lib/trace'

const props = defineProps<{ rows: Active[]; labelOf: (a: Active) => string }>()
const emit = defineEmits<{ pick: [row: Active] }>()

const tasks = computed(() => props.rows.filter((r) => r.kind === 'task'))
const people = computed(() => props.rows.filter((r) => r.kind === 'person'))
</script>

<template>
  <div class="grid gap-4 sm:grid-cols-2">
    <section v-for="g in [{ title: '最活躍的任務', rows: tasks }, { title: '最活躍的人', rows: people }]" :key="g.title" class="rounded border border-slate-200 bg-white">
      <h3 class="px-3 py-2 text-sm font-semibold text-slate-800 border-b border-slate-100">{{ g.title }}<span class="ml-1 text-xs font-normal text-slate-400">（事件數）</span></h3>
      <p v-if="g.rows.length === 0" class="px-3 py-3 text-sm text-slate-400">這段時間沒有</p>
      <ol v-else class="divide-y divide-slate-100">
        <li v-for="(r, i) in g.rows" :key="r.id">
          <button type="button" class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 min-h-[40px]" @click="emit('pick', r)">
            <span class="w-5 shrink-0 text-xs text-slate-400 tabular-nums">{{ i + 1 }}</span>
            <span class="min-w-0 flex-1 truncate text-sm text-slate-800">{{ labelOf(r) }}</span>
            <span class="shrink-0 text-sm tabular-nums text-sky-700">{{ r.count }}</span>
          </button>
        </li>
      </ol>
    </section>
  </div>
</template>
