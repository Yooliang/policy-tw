<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { BarChart3, Database, Sparkles, Users, Upload } from 'lucide-vue-next'

const route = useRoute()

const navItems = [
  { path: '/admin/dashboard', label: '統計總覽', icon: BarChart3 },
  { path: '/admin/scraper', label: '資料抓取', icon: Database },
  { path: '/admin/import', label: '資料匯入', icon: Upload },
  { path: '/admin/ai', label: 'AI 管理', icon: Sparkles },
  { path: '/admin/duplicates', label: '重複資料', icon: Users },
]

const currentPath = computed(() => route.path)
</script>

<template>
  <div class="flex flex-wrap gap-2">
    <router-link
      v-for="item in navItems"
      :key="item.path"
      :to="item.path"
      :class="[
        'flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all',
        currentPath === item.path
          ? 'bg-navy-800 text-white shadow-md'
          : 'bg-white/80 text-slate-600 hover:bg-white hover:text-navy-900 border border-slate-200'
      ]"
    >
      <component :is="item.icon" :size="16" />
      {{ item.label }}
    </router-link>
  </div>
</template>
