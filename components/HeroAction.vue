<script setup lang="ts">
import { RouterLink, type RouteLocationRaw } from 'vue-router'

/**
 * Hero 動作列的統一按鈕：有 `to` 就是連結（RouterLink），否則是按鈕（emit click）。
 * 樣式只有兩種：active（本頁／目前頁籤，白底）與一般（半透明），各頁不要再自己刻。
 */
defineProps<{
  to?: RouteLocationRaw
  active?: boolean
  /**
   * 手機上縮小一級。給「一排三顆以上、又希望不要換行」的場合用（PolicyViewNav）。
   * 只縮 sm 以下：桌機空間夠，沒必要把字變小。
   * 四顆按鈕的 MechanismNav 刻意不用——那排本來就預期會換行。
   */
  compact?: boolean
}>()
defineEmits<{ click: [] }>()

const FULL = 'px-4 py-2.5 text-sm gap-2'
const COMPACT = 'px-2.5 py-2 text-xs gap-1.5 sm:px-4 sm:py-2.5 sm:text-sm sm:gap-2'
const BASE = 'rounded-xl font-bold flex items-center transition-all whitespace-nowrap'
const ACTIVE = 'bg-white text-navy-900 shadow-lg'
const IDLE = 'bg-white/10 text-white hover:bg-white/20 border border-white/20'
</script>

<template>
  <RouterLink v-if="to" :to="to" :class="[BASE, compact ? COMPACT : FULL, active ? ACTIVE : IDLE]" :aria-current="active ? 'page' : undefined">
    <slot />
  </RouterLink>
  <button v-else type="button" :class="[BASE, compact ? COMPACT : FULL, active ? ACTIVE : IDLE]" :aria-current="active ? 'page' : undefined" @click="$emit('click')">
    <slot />
  </button>
</template>
