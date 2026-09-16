<script setup lang="ts">
import { computed } from 'vue'
import { canonicalParty, partyColor, partyEmblem, partyInitial } from '../lib/party'

/**
 * 掛在頭像右下角的政黨標記：有黨徽就放黨徽，沒有就退回彩色圓圈加一個字。
 * 四個頁面原本各自寫一份判斷，而且都比對簡稱（'國民黨'）對不上資料庫的全名。
 * 位置（absolute bottom-…）由呼叫端給：有的頁面貼在 -bottom-1，有的在 bottom-2。
 */
const props = withDefaults(defineProps<{
  party: string | null | undefined
  /** 圓圈直徑，對應 Tailwind 的 w-/h-；預設 6＝24px */
  size?: 6 | 7 | 8
}>(), { size: 6 })

const emblem = computed(() => partyEmblem(props.party))
const label = computed(() => canonicalParty(props.party) || '未標註政黨')
const box = computed(() => (props.size === 8 ? 'w-8 h-8' : props.size === 7 ? 'w-7 h-7' : 'w-6 h-6'))
const textSize = computed(() => (props.size === 8 ? 'text-sm' : 'text-xs'))
</script>

<template>
  <span
    v-if="emblem"
    :class="['rounded-full bg-white border-2 border-white shadow-sm overflow-hidden flex items-center justify-center', box]"
    :title="label"
  >
    <!-- 黨徽本來就是方的，用 contain 不要裁切；alt 留空，旁邊已經有黨名文字，讀螢幕不需要再唸一次 -->
    <img :src="emblem" alt="" class="w-full h-full object-contain" loading="lazy" decoding="async" />
  </span>
  <span
    v-else
    :class="['flex items-center justify-center rounded-full font-bold text-white border-2 border-white', box, textSize, partyColor(party)]"
    :title="label"
  >
    {{ partyInitial(party) }}
  </span>
</template>
