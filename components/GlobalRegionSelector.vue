<script setup lang="ts">
import { useGlobalState } from '../composables/useGlobalState'
import { Globe } from 'lucide-vue-next'

const { globalRegion, setGlobalRegion } = useGlobalState()

const specialMunicipalities = ['台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市']
const group1 = ['基隆市', '新竹市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義市']
const group2 = ['嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣']

const getBtnClass = (region: string) => {
  const isSelected = globalRegion.value === region
  const base = "py-2 rounded-xl text-xs font-black transition-all border text-center whitespace-nowrap h-9 flex items-center justify-center gap-1.5"
  const active = "bg-blue-600 text-white border-blue-600 shadow-lg scale-[1.02] z-10"
  const inactive = "bg-slate-50 text-slate-500 border-slate-200 hover:bg-white hover:border-blue-300 hover:text-blue-600"
  return `${base} ${isSelected ? active : inactive}`
}
</script>

<template>
  <div class="flex gap-4 py-2 w-full">
    <!-- Left Column: All -->
    <div class="flex flex-col shrink-0 pt-1">
      <button 
        @click="setGlobalRegion('All')"
        :class="`px-4 ${getBtnClass('All')}`"
      >
        <Globe :size="14" /> 全台
      </button>
    </div>

    <!-- Right Column: 3 Rows x 8 Columns -->
    <div class="flex-grow flex flex-col gap-2">
      <!-- Row 1: Special Municipalities (6) + 2 Spacers -->
      <div class="grid grid-cols-4 md:grid-cols-8 gap-2">
        <button 
          v-for="city in specialMunicipalities" 
          :key="city"
          @click="setGlobalRegion(city)"
          :class="getBtnClass(city)"
        >
          {{ city }}
        </button>
        <div class="hidden md:block col-span-2"></div>
      </div>

      <!-- Row 2: Group 1 (8) -->
      <div class="grid grid-cols-4 md:grid-cols-8 gap-2">
        <button 
          v-for="city in group1" 
          :key="city"
          @click="setGlobalRegion(city)"
          :class="getBtnClass(city)"
        >
          {{ city }}
        </button>
      </div>

      <!-- Row 3: Group 2 (8) -->
      <div class="grid grid-cols-4 md:grid-cols-8 gap-2">
        <button 
          v-for="city in group2" 
          :key="city"
          @click="setGlobalRegion(city)"
          :class="getBtnClass(city)"
        >
          {{ city }}
        </button>
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
