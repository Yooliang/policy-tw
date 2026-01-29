<script setup lang="ts">
import { ref, computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { TrendingUp, FileText, Activity, Heart, Menu, X, Vote, MessageSquare, LogIn } from 'lucide-vue-next'
import { useSupabase } from '../composables/useSupabase'

const isOpen = ref(false)
const isLoginModalOpen = ref(false)
const route = useRoute()
const { getActiveElection } = useSupabase()

const activeElection = computed(() => getActiveElection())

const navItems = computed(() => {
  const items = [
    { name: '總覽', path: '/', icon: Activity },
    { name: '政見追蹤', path: '/tracking', icon: TrendingUp },
    { name: '智能分析', path: '/analysis', icon: FileText },
    { name: '公民參與', path: '/community', icon: MessageSquare },
  ]
  
  if (activeElection.value) {
    items.push({ 
      name: activeElection.value.shortName, 
      path: `/election/${activeElection.value.id}`, 
      icon: Vote 
    })
  }
  
  return items
})


const isActive = (path: string) => route.path === path
</script>

<template>
  <nav class="bg-navy-900 text-white sticky top-0 z-50 shadow-lg border-b border-navy-700">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <div class="flex items-center">
          <RouterLink to="/" class="flex-shrink-0 flex items-center gap-2 group">
            <div class="w-8 h-8 bg-blue-600 rounded-sm flex items-center justify-center group-hover:bg-blue-500 transition-colors">
              <Vote :size="18" class="text-white" />
            </div>
            <span class="font-bold text-xl tracking-wide">正見</span>
          </RouterLink>
        </div>

        <div class="hidden md:block">
          <div class="ml-10 flex items-baseline space-x-4">
            <RouterLink
              v-for="item in navItems"
              :key="item.name"
              :to="item.path"
              :class="`flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors duration-200 ${
                isActive(item.path)
                  ? 'bg-navy-800 text-blue-400 border border-navy-700'
                  : 'text-gray-300 hover:bg-navy-800 hover:text-white'
              }`"
            >
              <component :is="item.icon" :size="18" />
              {{ item.name }}
            </RouterLink>
          </div>
        </div>

        <div class="hidden md:flex items-center gap-2 flex-shrink-0">
          <RouterLink to="/donation" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-md text-sm font-bold flex items-center gap-1.5 transition-all shadow-lg hover:shadow-blue-500/20 whitespace-nowrap">
            <Heart :size="16" class="fill-current" />
            <span>贊助平台</span>
          </RouterLink>
          <button
            @click="isLoginModalOpen = true"
            class="bg-white/10 hover:bg-white/20 text-white px-3 py-2 rounded-md text-sm font-bold flex items-center gap-1.5 transition-all border border-white/20 whitespace-nowrap"
          >
            <LogIn :size="16" />
            <span>登入</span>
          </button>
        </div>

        <div class="-mr-2 flex md:hidden">
          <button
            @click="isOpen = !isOpen"
            class="bg-navy-800 inline-flex items-center justify-center p-2 rounded-md text-gray-400 hover:text-white hover:bg-navy-700 focus:outline-none"
          >
            <X v-if="isOpen" :size="24" />
            <Menu v-else :size="24" />
          </button>
        </div>
      </div>
    </div>

    <!-- Mobile menu -->
    <div v-if="isOpen" class="md:hidden bg-navy-800">
      <div class="px-2 pt-2 pb-3 space-y-1 sm:px-3">
        <RouterLink
          v-for="item in navItems"
          :key="item.name"
          :to="item.path"
          @click="isOpen = false"
          :class="`block px-3 py-2 rounded-md text-base font-medium flex items-center gap-3 ${
            isActive(item.path) ? 'bg-navy-900 text-white' : 'text-gray-300 hover:bg-navy-700 hover:text-white'
          }`"
        >
          <component :is="item.icon" :size="18" />
          {{ item.name }}
        </RouterLink>
        <RouterLink
          to="/donation"
          @click="isOpen = false"
          class="block px-3 py-2 rounded-md text-base font-medium text-blue-400 hover:text-blue-300 flex items-center gap-3"
        >
          <Heart :size="18" />
          贊助平台
        </RouterLink>
        <button
          @click="isOpen = false; isLoginModalOpen = true"
          class="block w-full text-left px-3 py-2 rounded-md text-base font-medium text-gray-300 hover:bg-navy-700 hover:text-white flex items-center gap-3"
        >
          <LogIn :size="18" />
          登入
        </button>
      </div>
    </div>

    <!-- Login Modal -->
    <div v-if="isLoginModalOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" @click="isLoginModalOpen = false">
      <div class="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 p-8" @click.stop>
        <div class="flex items-center justify-between mb-6">
          <h2 class="text-2xl font-bold text-navy-900">登入</h2>
          <button
            @click="isLoginModalOpen = false"
            class="text-slate-400 hover:text-slate-600 transition-colors"
          >
            <X :size="24" />
          </button>
        </div>

        <div class="space-y-4">
          <div>
            <label class="block text-sm font-bold text-slate-700 mb-2">電子郵件</label>
            <input
              type="email"
              placeholder="your@email.com"
              class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 text-navy-900"
            />
          </div>

          <div>
            <label class="block text-sm font-bold text-slate-700 mb-2">密碼</label>
            <input
              type="password"
              placeholder="••••••••"
              class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 text-navy-900"
            />
          </div>

          <div class="flex items-center justify-between text-sm">
            <label class="flex items-center gap-2 text-slate-600">
              <input type="checkbox" class="rounded border-slate-300" />
              <span>記住我</span>
            </label>
            <a href="#" class="text-blue-600 hover:text-blue-700 font-bold">忘記密碼？</a>
          </div>

          <button class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-xl transition-colors shadow-lg">
            登入
          </button>

          <div class="text-center text-sm text-slate-600">
            還沒有帳號？ <a href="#" class="text-blue-600 hover:text-blue-700 font-bold">立即註冊</a>
          </div>
        </div>
      </div>
    </div>
  </nav>
</template>
