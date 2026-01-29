<script setup lang="ts">
import { computed } from 'vue'
import { useSupabase } from '../../composables/useSupabase'
import type { Politician } from '../../types'
import Avatar from '../../components/Avatar.vue'

const props = defineProps<{
  modelValue: string | number
  label: string
  ringColor: string
  selectedRegion: string
  comparisonPool: Politician[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string | number]
}>()

const { politicians, locations } = useSupabase()

const selectedPolitician = computed(() => politicians.value.find(c => String(c.id) === String(props.modelValue)))
</script>

<template>
  <div class="flex-1 w-full text-left">
    <label class="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
      {{ label }}
      <span class="ml-1 text-[10px] bg-slate-200 text-slate-600 px-1 rounded">{{ selectedRegion === 'All' ? '全台' : selectedRegion }}</span>
    </label>
    <div class="relative">
      <select
        :value="modelValue"
        @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"

        :class="`w-full p-3 border border-slate-300 rounded-lg font-bold text-navy-900 shadow-sm focus:ring-2 focus:ring-${ringColor}`"
      >
        <option v-if="comparisonPool.length === 0" value="">無符合條件候選人</option>
        <template v-if="selectedRegion === 'All'">
          <template v-for="loc in locations" :key="loc">
            <optgroup v-if="comparisonPool.filter(c => c.region === loc).length > 0" :label="loc">
              <option v-for="c in comparisonPool.filter(c => c.region === loc)" :key="c.id" :value="c.id">
                {{ c.name }} ({{ c.party }}) {{ c.subRegion ? `- ${c.subRegion}` : '' }}
              </option>
            </optgroup>
          </template>
        </template>
        <template v-else>
          <option v-for="c in comparisonPool" :key="c.id" :value="c.id">
            {{ c.name }} ({{ c.party }}) {{ c.subRegion ? `- ${c.subRegion}` : '' }}
          </option>
        </template>
      </select>
    </div>
    <div v-if="selectedPolitician" class="mt-4 flex items-center gap-3 bg-white p-3 rounded-lg border border-slate-100 shadow-sm animate-fade-in">
      <Avatar :src="selectedPolitician.avatarUrl" :name="selectedPolitician.name" size="md" class="border-2 border-white shadow-sm" />
      <div>
        <div class="font-bold text-navy-900 flex items-center gap-2">
          {{ selectedPolitician.name }}
          <span :class="`text-[10px] px-1.5 py-0.5 rounded text-white ${
            selectedPolitician.party === '國民黨' ? 'bg-blue-600' :
            selectedPolitician.party === '民進黨' ? 'bg-green-600' :
            selectedPolitician.party === '民眾黨' ? 'bg-cyan-600' : 'bg-gray-500'
          }`">{{ selectedPolitician.party }}</span>
        </div>
        <div class="text-xs text-slate-500">{{ selectedPolitician.slogan || '無口號' }}</div>
      </div>
    </div>
  </div>
</template>
