<script setup lang="ts">
/**
 * 時間軸上的一句說明（2026-09-18）。
 *
 * 政見頁的公民提問在還沒有人問的時候，會在時間軸上放一列灰色的「還沒有人問」，
 * 而不是在框外寫一段小字——讀者掃同一條線就看得完。查核履歷的兩種說明
 * （還沒有貢獻紀錄、收合時那句「這筆資料怎麼來的」）原本是框外的小灰字，
 * 同一張卡裡兩種寫法。這個元件就是那一列，讓兩邊長得一樣。
 */
defineProps<{
  /** 灰膠囊裡的狀態字，例如「尚未查核」 */
  label: string
  /** 這一列要講的話 */
  text: string
}>()
</script>

<template>
  <ol class="relative border-l-2 border-slate-200 ml-2" data-testid="timeline-note">
    <li class="relative pl-6">
      <span class="absolute -left-[7px] top-1.5 w-3 h-3 rounded-full border-2 border-white ring-2 bg-slate-300 ring-slate-100"></span>
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class="font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">{{ label }}</span>
      </div>
      <p class="mt-1 text-sm leading-relaxed break-words text-slate-500">{{ text }}</p>
      <!-- 來源連結、補充說明之類的東西接在這句後面 -->
      <slot />
    </li>
  </ol>
</template>
