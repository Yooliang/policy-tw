<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { ChevronRight } from 'lucide-vue-next'
import type { BreadcrumbItem } from '../composables/usePageHead'

/**
 * 麵包屑（2026-09-30）：接在深色 Hero 上方的一條窄列。每一層都是真連結（最後一層是本頁、不連）。
 * 結構化資料（BreadcrumbList）由 usePageHead 的 breadcrumbs 選項輸出，這裡只管畫面。
 */
defineProps<{ items: BreadcrumbItem[] }>()
</script>

<template>
  <nav v-if="items.length > 1" aria-label="麵包屑" class="bg-navy-900 border-b border-white/10">
    <ol class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-slate-400 text-left">
      <li v-for="(item, i) in items" :key="i" class="flex items-center gap-1 min-w-0">
        <ChevronRight v-if="i > 0" :size="12" class="shrink-0 text-slate-500" />
        <RouterLink v-if="item.path && i < items.length - 1" :to="item.path" class="hover:text-white transition-colors whitespace-nowrap">{{ item.name }}</RouterLink>
        <span v-else class="text-slate-300 truncate max-w-[16rem] sm:max-w-md" aria-current="page">{{ item.name }}</span>
      </li>
    </ol>
  </nav>
</template>
