<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSupabase } from '../composables/useSupabase'
import { PolicyStatus } from '../types'
import PolicyCard from '../components/PolicyCard.vue'
import Hero from '../components/Hero.vue'
import { MapPin, GraduationCap, Briefcase, CheckCircle2, Megaphone, ThumbsUp, User, ChevronLeft, ChevronRight } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const { politicians, policies } = useSupabase()
const activeTab = ref<'campaign' | 'history'>('campaign')

const politician = computed(() => politicians.value.find(c => c.id === route.params.politicianId))
const campaignPledges = computed(() => politician.value ? policies.value.filter(p => p.politicianId === politician.value!.id && p.status === PolicyStatus.CAMPAIGN) : [])
const historicalPolicies = computed(() => politician.value ? policies.value.filter(p => p.politicianId === politician.value!.id && p.status !== PolicyStatus.CAMPAIGN) : [])
</script>

<template>
  <div v-if="politician" class="bg-slate-50 min-h-screen">
    <Hero>
      <template #icon><User :size="400" class="text-violet-500" /></template>
      <template #title>
        <div class="flex flex-col md:flex-row gap-8 items-start">
          <div class="relative">
            <img :src="politician.avatarUrl" :alt="politician.name" class="w-32 h-32 md:w-40 md:h-40 rounded-full border-4 border-white shadow-xl" />
            <span :class="`absolute bottom-2 right-2 w-8 h-8 flex items-center justify-center rounded-full text-sm font-bold text-white border-2 border-white shadow-md
              ${politician.party === '國民黨' ? 'bg-blue-600' :
                politician.party === '民進黨' ? 'bg-green-600' :
                politician.party === '民眾黨' ? 'bg-cyan-600' : 'bg-gray-500'}`">
              {{ politician.party[0] }}
            </span>
          </div>
          <div class="flex-1">
            <div class="flex flex-wrap items-center gap-3 mb-2">
              <h1 class="text-4xl font-bold text-white">{{ politician.name }}</h1>
              <span class="bg-white/20 px-3 py-1 rounded-full text-sm font-medium backdrop-blur-sm">{{ politician.position }}</span>
              <span class="bg-white/20 px-3 py-1 rounded-full text-sm font-medium backdrop-blur-sm flex items-center gap-1"><MapPin :size="14" /> {{ politician.region }}</span>
            </div>
            <h2 v-if="politician.slogan" class="text-xl md:text-2xl font-bold text-amber-400 mb-4 italic">"{{ politician.slogan }}"</h2>
            <p class="text-violet-100 max-w-2xl leading-relaxed mb-6 text-lg">{{ politician.bio || "暫無簡介。" }}</p>
          </div>
        </div>
      </template>
      <template #actions>
        <div class="flex items-center gap-4 ml-0 md:ml-48">
          <button @click="router.go(-1)" class="w-10 h-10 flex items-center justify-center bg-white/10 hover:bg-white/20 text-white rounded-full transition-all border border-white/10 group shrink-0" aria-label="返回">
            <ChevronLeft :size="24" class="group-hover:-translate-x-1 transition-transform" />
          </button>
          <button class="bg-amber-500 hover:bg-amber-600 text-white px-6 py-2 rounded-lg font-bold shadow-lg shadow-amber-500/30 transition-all flex items-center gap-2"><ThumbsUp :size="18" /> 支持候選人</button>
          <button class="bg-white/10 hover:bg-white/20 text-white px-6 py-2 rounded-lg font-bold border border-white/30 transition-all">分享頁面</button>
        </div>
      </template>
    </Hero>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-8 text-left">
        <!-- Main Content (Left) -->
        <div class="lg:col-span-2">
          <div class="flex border-b border-slate-200 mb-6">
            <button @click="activeTab = 'campaign'" :class="`pb-4 px-6 font-bold text-lg flex items-center gap-2 transition-all relative ${activeTab === 'campaign' ? 'text-violet-600' : 'text-slate-400 hover:text-slate-600'}`">
              <Megaphone :size="20" />2026 競選承諾<span class="bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full text-xs ml-1">{{ campaignPledges.length }}</span>
              <div v-if="activeTab === 'campaign'" class="absolute bottom-0 left-0 w-full h-1 bg-violet-600 rounded-t-full"></div>
            </button>
            <button @click="activeTab = 'history'" :class="`pb-4 px-6 font-bold text-lg flex items-center gap-2 transition-all relative ${activeTab === 'history' ? 'text-blue-600' : 'text-slate-400 hover:text-slate-600'}`">
              <CheckCircle2 :size="20" />過往政績與追蹤<span class="bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full text-xs ml-1">{{ historicalPolicies.length }}</span>
              <div v-if="activeTab === 'history'" class="absolute bottom-0 left-0 w-full h-1 bg-blue-600 rounded-t-full"></div>
            </button>
          </div>
          <div class="space-y-6">
            <template v-if="activeTab === 'campaign'">
              <div v-if="campaignPledges.length > 0" class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <PolicyCard v-for="policy in campaignPledges" :key="policy.id" :policy="policy" :politician="politician" :on-click="() => router.push(`/policy/${policy.id}`)" />
              </div>
              <div v-else class="bg-white p-12 text-center rounded-xl border border-dashed border-slate-300"><p class="text-slate-500">該候選人尚未發布 2026 競選承諾。</p></div>
            </template>
            <template v-else>
              <div v-if="historicalPolicies.length > 0" class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <PolicyCard v-for="policy in historicalPolicies" :key="policy.id" :policy="policy" :politician="politician" :on-click="() => router.push(`/policy/${policy.id}`)" />
              </div>
              <div v-else class="bg-white p-12 text-center rounded-xl border border-dashed border-slate-300"><p class="text-slate-500">該候選人無過往追蹤紀錄。</p></div>
            </template>
          </div>
        </div>

        <!-- Sidebar (Right) -->
        <div class="lg:col-span-1 space-y-6">
          <div class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm sticky top-24">
            <div class="space-y-4">
              <div>
                <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">所屬政黨</h4>
                <span :class="`inline-block px-3 py-1 rounded text-sm font-bold
                  ${politician.party === '國民黨' ? 'bg-blue-50 text-blue-700' :
                    politician.party === '民進黨' ? 'bg-green-50 text-green-700' :
                    politician.party === '民眾黨' ? 'bg-cyan-50 text-cyan-700' : 'bg-gray-50 text-gray-700'}`">
                  {{ politician.party }}
                </span>
              </div>

              <div class="pt-4 border-t border-slate-100">
                <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">選區</h4>
                <p class="text-navy-900 font-medium flex items-center gap-2"><MapPin :size="16" class="text-slate-400" />{{ politician.region }}</p>
              </div>

              <div class="pt-4 border-t border-slate-100">
                <h3 class="font-bold text-navy-900 mb-4 flex items-center gap-2"><Briefcase class="text-slate-400" :size="18" /> 經歷</h3>
                <ul class="space-y-3">
                  <template v-if="politician.experience?.length">
                    <li v-for="(exp, i) in politician.experience" :key="i" class="text-sm text-slate-600 pl-4 border-l-2 border-slate-200">{{ exp }}</li>
                  </template>
                  <li v-else class="text-slate-400 text-sm">暫無資料</li>
                </ul>
              </div>

              <div class="pt-4 border-t border-slate-100">
                <h3 class="font-bold text-navy-900 mb-4 flex items-center gap-2"><GraduationCap class="text-slate-400" :size="18" /> 學歷</h3>
                <ul class="space-y-3">
                  <template v-if="politician.education?.length">
                    <li v-for="(edu, i) in politician.education" :key="i" class="text-sm text-slate-600 pl-4 border-l-2 border-slate-200">{{ edu }}</li>
                  </template>
                  <li v-else class="text-slate-400 text-sm">暫無資料</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="p-10 text-center">找不到候選人</div>
</template>
