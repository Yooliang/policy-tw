<script setup lang="ts">
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { HERO_ACTION_ACTIVE, HERO_ACTION_BASE, HERO_ACTION_IDLE, HERO_ACTION_SIZE } from '../lib/hero-action-styles'

/**
 * Hero 動作列的統一按鈕：有 `to` 就是連結（RouterLink），否則是按鈕（emit click）。
 * 樣式只有兩種：active（本頁／目前頁籤，白底）與一般（半透明），各頁不要再自己刻。
 *
 * 尺寸只有一種，在 lib/hero-action-styles.ts。原本多一個 compact prop 只給
 * PolicyViewNav 用，結果全站動作區出現兩種大小——其他頁沒跟著縮顯得奇怪，
 * 所以那一級縮放現在是所有動作區的預設。
 */
defineProps<{
  to?: RouteLocationRaw
  active?: boolean
}>()
defineEmits<{ click: [] }>()
</script>

<template>
  <RouterLink v-if="to" :to="to" :class="[HERO_ACTION_BASE, HERO_ACTION_SIZE, active ? HERO_ACTION_ACTIVE : HERO_ACTION_IDLE]" :aria-current="active ? 'page' : undefined">
    <slot />
  </RouterLink>
  <button v-else type="button" :class="[HERO_ACTION_BASE, HERO_ACTION_SIZE, active ? HERO_ACTION_ACTIVE : HERO_ACTION_IDLE]" :aria-current="active ? 'page' : undefined" @click="$emit('click')">
    <slot />
  </button>
</template>
