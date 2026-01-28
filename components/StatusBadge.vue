<script setup lang="ts">
import { computed } from 'vue'
import { PolicyStatus } from '../types'

const props = defineProps<{
  status: PolicyStatus
}>()

const styles = computed(() => {
  switch (props.status) {
    case PolicyStatus.ACHIEVED:
      return 'bg-emerald-100 text-emerald-800 border-emerald-200'
    case PolicyStatus.IN_PROGRESS:
      return 'bg-blue-100 text-blue-800 border-blue-200'
    case PolicyStatus.PROPOSED:
      return 'bg-slate-100 text-slate-800 border-slate-200'
    case PolicyStatus.STALLED:
      return 'bg-amber-100 text-amber-800 border-amber-200'
    case PolicyStatus.FAILED:
      return 'bg-red-100 text-red-800 border-red-200'
    case PolicyStatus.CAMPAIGN:
      return 'bg-violet-100 text-violet-800 border-violet-200 font-bold'
    default:
      return 'bg-gray-100 text-gray-800'
  }
})

const label = computed(() => {
  return props.status === PolicyStatus.CAMPAIGN ? '競選承諾' : props.status
})
</script>

<template>
  <span :class="`px-2.5 py-0.5 rounded-full text-xs font-medium border ${styles}`">
    {{ label }}
  </span>
</template>
