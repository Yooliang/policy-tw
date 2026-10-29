<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { ChevronRight } from 'lucide-vue-next'
import type { BreadcrumbItem } from '../composables/usePageHead'

/**
 * 麵包屑（2026-09-30）：放進 Hero 的 default slot（白色蓋板卡片）裡的一列膠囊，跟 /stats 分頁列同款；窄螢幕橫向捲動。每一層都是真連結（最後一層是本頁、不連）。
 * 結構化資料（BreadcrumbList）由 usePageHead 的 breadcrumbs 選項輸出，這裡只管畫面。
 */
defineProps<{ items: BreadcrumbItem[] }>()
</script>

<template>
  <nav v-if="items.length > 1" aria-label="麵包屑" class="w-full min-w-0 text-left">
    <ol class="flex items-center gap-1.5 overflow-x-auto flex-nowrap py-0.5">
      <li v-for="(item, i) in items" :key="i" class="flex items-center gap-1.5 shrink-0">
        <ChevronRight v-if="i > 0" :size="14" class="shrink-0 text-slate-300" aria-hidden="true" />
        <RouterLink
          v-if="item.path && i < items.length - 1"
          :to="item.path"
          class="inline-flex items-center px-3 py-1.5 rounded-full border border-slate-200 bg-white text-sm font-bold text-slate-500 whitespace-nowrap hover:text-blue-600 hover:border-blue-300 transition-colors"
        ><span class="sm:hidden">{{ item.short ?? item.name }}</span><span class="hidden sm:inline">{{ item.name }}</span></RouterLink>
        <span
          v-else
          class="inline-flex items-center px-3 py-1.5 rounded-full bg-blue-600 text-white text-sm font-bold whitespace-nowrap"
          aria-current="page"
        ><span class="sm:hidden">{{ item.short ?? item.name }}</span><span class="hidden sm:inline">{{ item.name }}</span></span>
      </li>
    </ol>
  </nav>
</template>
