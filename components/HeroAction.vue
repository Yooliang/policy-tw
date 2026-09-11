<script setup lang="ts">
import { RouterLink, type RouteLocationRaw } from 'vue-router'

/**
 * Hero 動作列的統一按鈕：有 `to` 就是連結（RouterLink），否則是按鈕（emit click）。
 * 樣式只有兩種：active（本頁／目前頁籤，白底）與一般（半透明），各頁不要再自己刻。
 */
defineProps<{
  to?: RouteLocationRaw
  active?: boolean
}>()
defineEmits<{ click: [] }>()

const BASE = 'px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-all whitespace-nowrap'
const ACTIVE = 'bg-white text-navy-900 shadow-lg'
const IDLE = 'bg-white/10 text-white hover:bg-white/20 border border-white/20'
</script>

<template>
  <RouterLink v-if="to" :to="to" :class="[BASE, active ? ACTIVE : IDLE]" :aria-current="active ? 'page' : undefined">
    <slot />
  </RouterLink>
  <button v-else type="button" :class="[BASE, active ? ACTIVE : IDLE]" :aria-current="active ? 'page' : undefined" @click="$emit('click')">
    <slot />
  </button>
</template>
