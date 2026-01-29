<script setup lang="ts">
import { computed } from 'vue'
import { getAvatarUrl } from '../composables/useAvatar'

const props = defineProps<{
  src?: string | null
  name: string
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'
  class?: string
}>()

const avatarUrl = computed(() => getAvatarUrl(props.src, props.name))

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
    :class="['rounded-full bg-cover bg-center', sizeClass, props.class]"
    :style="{ backgroundImage: `url(${avatarUrl})` }"
    :title="name"
  />
</template>
