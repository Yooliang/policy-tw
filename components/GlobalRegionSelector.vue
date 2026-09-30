<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { useGlobalState } from '../composables/useGlobalState'
import { SPECIAL_MUNICIPALITIES, OTHER_COUNTIES } from '../lib/election-regions'
import { Globe, ChevronUp, ChevronDown } from 'lucide-vue-next'

/**
 * 縣市選擇器。預設是按鈕（改全站共用的 globalRegion）；
 * 給了 linkFor 就改成真連結（選舉頁 2026-09-30：每個縣市有自己的網址，爬蟲才走得到議員、鄉鎮長的人物頁），
 * 目前選中的縣市改看 current（預渲染時 globalRegion 還是全台，要以頁面自己的縣市為準才不會 hydration 不一致）。
 */
const props = defineProps<{
  current?: string
  linkFor?: (region: string) => RouteLocationRaw
}>()

const { globalRegion, setGlobalRegion, regionSelectorExpanded, toggleRegionSelectorExpanded } = useGlobalState()
const selected = computed(() => props.current ?? globalRegion.value)

const specialMunicipalities: readonly string[] = SPECIAL_MUNICIPALITIES
const group1: readonly string[] = OTHER_COUNTIES.slice(0, 8)
const group2: readonly string[] = OTHER_COUNTIES.slice(8)

const getBtnClass = (region: string) => {
  const isSelected = selected.value === region
  const base = "py-2 rounded-xl text-xs font-black transition-all border text-center whitespace-nowrap h-9 flex items-center justify-center gap-1.5"
  const active = "bg-blue-600 text-white border-blue-600 shadow-lg scale-[1.02] z-10"
  const inactive = "bg-slate-50 text-slate-500 border-transparent hover:bg-white hover:border-blue-300 hover:text-blue-600"
  return `${base} ${isSelected ? active : inactive}`
}
</script>

<template>
  <div class="flex gap-4 py-2 w-full">
    <!-- Left Column: All -->
    <div class="flex flex-col shrink-0">
      <RouterLink v-if="linkFor" :to="linkFor('All')" :class="`px-4 ${getBtnClass('All')}`" :aria-current="selected === 'All' ? 'page' : undefined">
        <Globe :size="14" /> 全台
      </RouterLink>
      <button v-else @click="setGlobalRegion('All')" :class="`px-4 ${getBtnClass('All')}`">
        <Globe :size="14" /> 全台
      </button>
    </div>

    <!-- Right Column: 3 Rows x 8 Columns -->
    <div class="flex-grow flex flex-col gap-2">
      <!-- Row 1: Special Municipalities (6) + Toggle Button -->
      <div class="grid grid-cols-4 md:grid-cols-8 gap-2">
        <template v-for="city in specialMunicipalities" :key="city">
          <RouterLink v-if="linkFor" :to="linkFor(city)" :class="getBtnClass(city)" :aria-current="selected === city ? 'page' : undefined">{{ city }}</RouterLink>
          <button v-else @click="setGlobalRegion(city)" :class="getBtnClass(city)">{{ city }}</button>
        </template>
        <!-- 展開/收合按鈕 -->
        <div class="flex col-span-2 justify-end items-center gap-2">
          <span
            v-if="!regionSelectorExpanded && [...group1, ...group2].includes(selected)"
            class="text-xs font-black text-blue-600 truncate"
          >
            {{ selected }}
          </span>
          <button
            @click="toggleRegionSelectorExpanded()"
            class="px-3 h-9 rounded-xl border border-transparent bg-slate-50 text-slate-400 hover:bg-white hover:border-blue-300 hover:text-blue-600 transition-all flex items-center justify-center shrink-0"
          >
            <ChevronUp v-if="regionSelectorExpanded" :size="16" />
            <ChevronDown v-else :size="16" />
          </button>
        </div>
      </div>

      <!-- Row 2: Group 1 (8) -->
      <div v-show="regionSelectorExpanded" class="grid grid-cols-4 md:grid-cols-8 gap-2">
        <template v-for="city in group1" :key="city">
          <RouterLink v-if="linkFor" :to="linkFor(city)" :class="getBtnClass(city)" :aria-current="selected === city ? 'page' : undefined">{{ city }}</RouterLink>
          <button v-else @click="setGlobalRegion(city)" :class="getBtnClass(city)">{{ city }}</button>
        </template>
      </div>

      <!-- Row 3: Group 2 (8) -->
      <div v-show="regionSelectorExpanded" class="grid grid-cols-4 md:grid-cols-8 gap-2">
        <template v-for="city in group2" :key="city">
          <RouterLink v-if="linkFor" :to="linkFor(city)" :class="getBtnClass(city)" :aria-current="selected === city ? 'page' : undefined">{{ city }}</RouterLink>
          <button v-else @click="setGlobalRegion(city)" :class="getBtnClass(city)">{{ city }}</button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
