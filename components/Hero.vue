<script setup lang="ts">
import { ChevronLeft } from 'lucide-vue-next'
import { HERO_ICON_BUTTON, HERO_ICON_SIZE } from '../lib/hero-action-styles'

defineProps<{
  backAction?: () => void
  className?: string
  backgroundImage?: string
  fullWidth?: boolean
}>()
</script>

<template>
  <div :class="`relative ${className || ''}`">
    <!-- Dark Section -->
    <section
      class="bg-navy-900 text-white relative min-h-[370px] pt-16 md:pt-0 md:h-[370px] flex items-end overflow-hidden"
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

    <!-- Overlapping Bottom Slot Area -->
     <div v-if="$slots.default" class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 -mt-12 relative z-30">
      <div class="bg-white px-6 py-4 rounded-2xl shadow-2xl border border-slate-200 w-full min-h-[86px] flex items-center">
        <div class="w-full">
          <slot />
        </div>
      </div>
    </div>

  </div>
</template>
