<script setup lang="ts">
/**
 * 出處旁邊的小標籤與「存檔」小連結（#347 第二階段 A）：
 *   等級（官方／本人／媒體／其他）用小標籤，本人來源的認定根據放在提示文字；
 *   有存檔網址（選舉公報、選委會公告類由排程存 Wayback Machine）就多一個「存檔」連結。
 * 沒有等級（舊視圖退路）也沒有存檔就什麼都不畫。
 */
import type { SourceLevel } from '../types'
import { selfEvidenceLabel, SOURCE_LEVEL_CLASS, SOURCE_LEVEL_LABEL } from '../lib/sources'

defineProps<{
  kind?: SourceLevel | null
  selfEvidence?: string | null
  archiveUrl?: string | null
}>()
</script>

<template>
  <span v-if="kind" :class="['font-bold px-1.5 py-0.5 rounded text-xs', SOURCE_LEVEL_CLASS[kind]]" :title="selfEvidenceLabel(kind, selfEvidence) ?? undefined" data-testid="source-level">{{ SOURCE_LEVEL_LABEL[kind] }}</span>
  <a v-if="archiveUrl" :href="archiveUrl" target="_blank" rel="noopener noreferrer" class="text-xs text-blue-700 underline underline-offset-2" data-testid="source-archive">存檔</a>
</template>
