<script setup lang="ts">
import { ChevronLeft } from 'lucide-vue-next'
import { HERO_ICON_BUTTON, HERO_ICON_SIZE } from '../lib/hero-action-styles'

defineProps<{
  backAction?: () => void
  className?: string
  backgroundImage?: string
  fullWidth?: boolean
  /** 內容很長（例如人物頁的長簡介）時讓標題區跟著長高，不要被固定高度裁掉頭像與名字 */
  autoHeight?: boolean
}>()
</script>

<template>
  <div :class="`relative ${className || ''}`">
    <!-- Dark Section -->
    <section
      :class="['bg-navy-900 text-white relative min-h-[370px] flex items-end overflow-hidden', autoHeight ? 'pt-16 md:pt-16' : 'pt-16 md:pt-0 md:h-[370px]']"
      :style="backgroundImage ? {
        backgroundImage: `url(${backgroundImage})`,
        backgroundSize: 'cover',
        backgroundPosition: 'right center',
        backgroundRepeat: 'no-repeat'
      } : {}"
    >
      <!-- Background Overlay -->
      <div v-if="backgroundImage" class="absolute inset-0 bg-navy-900/80"></div>

      <div class="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-20 text-left pb-16">
        <!-- Decorative Background Icon -->
        <div v-if="$slots.icon && !backgroundImage" class="absolute bottom-0 right-0 p-10 -mb-[120px] opacity-10 pointer-events-none z-10">
          <slot name="icon" />
        </div>

        <!-- Content Area -->
        <div :class="fullWidth ? '' : 'max-w-3xl'">
          <!-- 標題上方的標誌（選用，例如政黨頁的黨徽） -->
          <div v-if="$slots.logo" class="mb-4"><slot name="logo" /></div>

          <h1 class="text-4xl md:text-5xl lg:text-6xl font-black mb-6 tracking-tight leading-tight">

            <slot name="title" />
          </h1>

          <p v-if="$slots.description" class="text-lg lg:text-xl text-slate-400 leading-relaxed mb-8">
            <slot name="description" />
          </p>

          <!-- Back Button (standalone, only when no actions slot) -->
          <button
            v-if="backAction && !$slots.actions"
            @click="backAction"
            :class="HERO_ICON_BUTTON"
            aria-label="返回"
          >
            <ChevronLeft :size="HERO_ICON_SIZE" class="group-hover:-translate-x-1 transition-transform" />
          </button>

          <!-- Actions Area：間距跟按鈕一樣手機縮一級。按鈕尺寸見 lib/hero-action-styles.ts -->
          <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2 sm:gap-3">
            <slot name="actions" />
          </div>
        </div>
      </div>
    </section>

    <!-- Overlapping Bottom Slot Area
         寬度與置中寫在卡片自己身上、不靠外層容器：AdSense 自動廣告會把這一塊包進 div.google-auto-placed（style width:100%）
         （2026-10-29 線上實測，人物頁的卡因此左右撐滿整個視窗、時有時無）。算式＝max-w-7xl 扣掉 sm:px-6／lg:px-8 的左右留白；手機（<sm）撐滿 100%、不圓角，內距 px-4 與上方按鈕左緣對齊（維護者 2026-10-29）。 -->
    <div
      v-if="$slots.default"
      class="bg-white px-4 sm:px-6 py-4 rounded-none sm:rounded-2xl shadow-2xl border border-slate-200 border-x-0 sm:border-x min-h-[86px] flex md:hidden items-center -mt-12 relative z-30 mx-auto w-full max-w-none sm:w-[calc(100%-3rem)] sm:max-w-[calc(80rem-3rem)] lg:w-[calc(100%-4rem)] lg:max-w-[calc(80rem-4rem)]"
    >
      <div class="w-full">
        <slot />
      </div>
    </div>

  </div>
</template>
