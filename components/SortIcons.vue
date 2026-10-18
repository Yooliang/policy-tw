<script setup lang="ts" generic="K extends string">
import type { Component } from 'vue'

/**
 * 全站統一的排序切換（2026-10-19 維護者）：一排純圖示按鈕，滑過顯示名稱（title），讀屏念 aria-label。
 * 圖示慣例：時鐘＝最近、「姓」＝姓名筆畫、「名」＝名稱筆畫、清單＝筆數、眼睛＝關注度／表態、「No」＝號次或編號。
 * 每個選項給 icon（lucide 元件）或 text（一兩個字）其中一個。
 */
export interface SortIconOption<T extends string = string> { key: T; label: string; icon?: Component; text?: string }

defineProps<{ options: SortIconOption<K>[]; modelValue: K }>()
const emit = defineEmits<{ 'update:modelValue': [value: K] }>()
</script>

<template>
  <div class="inline-flex items-center gap-0.5 bg-slate-100 p-1 rounded-lg" role="group" aria-label="排序" data-testid="sort-icons">
    <button
      v-for="o in options"
      :key="o.key"
      type="button"
      :title="o.label"
      :aria-label="o.label"
      :aria-pressed="modelValue === o.key"
      :class="`w-8 h-7 inline-flex items-center justify-center rounded-md text-xs font-black transition-all ${modelValue === o.key ? 'bg-white text-navy-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`"
      @click="emit('update:modelValue', o.key)"
    >
      <component :is="o.icon" v-if="o.icon" :size="16" />
      <span v-else aria-hidden="true">{{ o.text }}</span>
    </button>
  </div>
</template>
