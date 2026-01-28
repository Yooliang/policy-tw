<script setup lang="ts">
import { ChevronLeft } from 'lucide-vue-next'

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
      class="bg-navy-900 text-white relative overflow-hidden pt-20 pb-24 md:pb-32 max-h-[370px]"
      :style="backgroundImage ? {
        backgroundImage: `url(${backgroundImage})`,
        backgroundSize: 'cover',
        backgroundPosition: 'right center',
        backgroundRepeat: 'no-repeat'
      } : {}"
    >
      <!-- Background Overlay -->
      <div v-if="backgroundImage" class="absolute inset-0 bg-navy-900/80"></div>

      <!-- Decorative Background Icon -->
      <div v-if="$slots.icon && !backgroundImage" class="absolute top-0 right-0 p-10 opacity-10 pointer-events-none z-10">
        <slot name="icon" />
      </div>

      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-20 text-left">

        <!-- Content Area -->
        <div :class="fullWidth ? '' : 'max-w-3xl'">
          <div v-if="$slots.badge" class="inline-flex items-center gap-2 bg-blue-600/20 text-blue-400 px-3 py-1 rounded-full text-[10px] font-black mb-4 border border-blue-500/30 uppercase tracking-widest">
            <slot name="badge" />
          </div>

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
            class="w-10 h-10 flex items-center justify-center bg-white/10 hover:bg-white/20 text-white rounded-full transition-all border border-white/10 group shrink-0"
            aria-label="返回"
          >
            <ChevronLeft :size="24" class="group-hover:-translate-x-1 transition-transform" />
          </button>

          <!-- Actions Area -->
          <div v-if="$slots.actions" class="flex flex-wrap gap-3">
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
