<script setup lang="ts">
/** 脈絡主頁的出處連結：出處名稱（沒有就網域）＋有存檔時附「存檔」 */
import type { LineageSource } from '../types'
import { sourceLabel } from '../lib/lineage'
import { PAGE_LABELS as T } from '../lib/lineage-page-labels'

defineProps<{ source: LineageSource | null | undefined; url: string }>()
</script>

<template>
  <span>
    <a :href="url" target="_blank" rel="noopener noreferrer" class="text-blue-700 underline underline-offset-2 break-all">{{ sourceLabel(source) || url }}</a>
    <template v-if="source?.archiveUrl">（<a :href="source.archiveUrl" target="_blank" rel="noopener noreferrer" class="text-blue-700 underline underline-offset-2">{{ T.archive }}</a>）</template>
  </span>
</template>
