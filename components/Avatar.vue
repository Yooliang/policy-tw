<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getAvatarUrl } from '../composables/useAvatar'

const props = defineProps<{
  src?: string | null
  name: string
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'
  class?: string
}>()

// 2026-09-22：原本是 background-image，網址掛了（Wikimedia 220px 縮圖整批 400）就是一片空白、沒有任何退路。
// 改成 <img>：載入失敗退回預設圖；src 換了就重來。
const failed = ref(false)
watch(() => props.src, () => { failed.value = false })
const avatarUrl = computed(() => failed.value ? getAvatarUrl(null, props.name) : getAvatarUrl(props.src, props.name))

const sizeClasses: Record<string, string> = {
  xs: 'w-6 h-6',
  sm: 'w-10 h-10',
  md: 'w-12 h-12',
  lg: 'w-16 h-16',
  xl: 'w-20 h-20',
  '2xl': 'w-32 h-32 md:w-40 md:h-40'
}

const sizeClass = computed(() => sizeClasses[props.size || 'md'])
</script>

<template>
  <div
    :class="['rounded-full overflow-hidden bg-slate-100 shrink-0', sizeClass, props.class]"
    :title="name"
  >
    <img :src="avatarUrl" :alt="name" loading="lazy" decoding="async" class="w-full h-full object-cover" @error="failed = true" />
  </div>
</template>
