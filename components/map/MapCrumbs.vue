<script setup lang="ts">
/** 參選地圖的層級路徑：全國 / 縣市 / 鄉鎮（/ 村里）與目前那一區的人數；點每一段放大到那一區（code 空＝全國） */
export interface MapCrumb {
  label: string
  code: string | null
}
defineProps<{ crumbs: MapCrumb[]; people: number | null }>()
defineEmits<{ pick: [code: string | null] }>()
</script>

<template>
  <nav class="flex flex-wrap items-center gap-1 text-sm font-black" aria-label="層級" data-testid="map-crumbs">
    <template v-for="(c, i) in crumbs" :key="i">
      <span v-if="i > 0" class="text-slate-300">/</span>
      <button v-if="i < crumbs.length - 1" type="button" class="px-1.5 py-0.5 rounded-lg text-blue-600 hover:bg-blue-50"
        :data-testid="`map-crumb-${i}`" @click="$emit('pick', c.code)">{{ c.label }}</button>
      <span v-else class="px-1.5 py-0.5 text-navy-900" data-testid="map-current">{{ c.label }}</span>
    </template>
    <span v-if="people !== null" class="ml-1 text-slate-500 font-bold" data-testid="map-total">{{ people }} 人</span>
  </nav>
</template>
