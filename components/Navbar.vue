<script setup lang="ts">
import { ref, computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { TrendingUp, FileText, Activity, Heart, X, Vote, MessageSquare, LogIn, LogOut, Loader2 } from 'lucide-vue-next'
import { useSupabase } from '../composables/useSupabase'
import { useAuth } from '../composables/useAuth'

const isLoginModalOpen = ref(false)
const isLoggingIn = ref(false)
const route = useRoute()
const { getActiveElection } = useSupabase()
const { isAuthenticated, userDisplayName, userAvatarUrl, signInWithGoogle, signOut, loading: authLoading } = useAuth()

const handleGoogleLogin = async () => {
  isLoggingIn.value = true
  try {
    await signInWithGoogle()
  } catch (error) {
    console.error('Login failed:', error)
  } finally {
    isLoggingIn.value = false
  }
}

const handleSignOut = async () => {
  try {
    await signOut()
    isLoginModalOpen.value = false
  } catch (error) {
    console.error('Sign out failed:', error)
  }
}

const activeElection = computed(() => getActiveElection())

const navItems = computed(() => {
  const items = [
    { name: '總覽', shortName: '總覽', path: '/', icon: Activity },
    { name: '政見追蹤', shortName: '追蹤', path: '/tracking', icon: TrendingUp },
    { name: '智能分析', shortName: '分析', path: '/analysis', icon: FileText },
    { name: '公民參與', shortName: '參與', path: '/community', icon: MessageSquare },
  ]

  if (activeElection.value) {
    items.push({
      name: activeElection.value.shortName,
      shortName: '選舉',
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
          <RouterLink to="/" class="flex-shrink-0 flex items-center gap-0.5 group">
            <div class="bg-blue-600 rounded-md flex items-center justify-center group-hover:bg-blue-500 transition-colors overflow-hidden shadow-lg" style="width: 37px; height: 45px; min-width: 32px; min-height: 32px; margin: -10px 0;">
              <span class="text-white font-black text-[28px] leading-none">正</span>
            </div>
            <span class="font-bold text-xl tracking-wide hidden min-[500px]:inline">見</span>
          </RouterLink>
        </div>

        <!-- Nav Items: Always visible, shorter text on mobile -->
        <div class="flex-1 flex justify-center">
          <div class="flex items-center space-x-0.5 sm:space-x-1">
            <RouterLink
              v-for="item in navItems"
              :key="item.name"
              :to="item.path"
              :class="`flex flex-col items-center justify-center px-2 sm:px-4 py-1.5 rounded-xl text-[10px] sm:text-xs font-bold transition-colors duration-200 min-w-[48px] sm:min-w-[72px] ${
                isActive(item.path)
                  ? 'bg-navy-800 text-blue-400 border border-navy-700'
                  : 'text-gray-400 hover:bg-navy-800 hover:text-white'
              }`"
            >
              <component :is="item.icon" :size="18" class="mb-0.5 sm:mb-1" />
              <span class="sm:hidden">{{ item.shortName }}</span>
              <span class="hidden sm:inline">{{ item.name }}</span>
            </RouterLink>
          </div>
        </div>

        <!-- Right Side Actions -->
        <div class="flex items-center gap-1 sm:gap-2 flex-shrink-0">
          <!-- Donation: Circle on mobile, rectangle on desktop -->
          <RouterLink to="/donation" class="bg-red-500 hover:bg-red-600 text-white w-8 h-8 sm:w-auto sm:h-auto sm:px-3 sm:py-2 rounded-full sm:rounded-md text-sm font-bold flex items-center justify-center sm:gap-1.5 transition-all shadow-lg hover:shadow-red-500/20 whitespace-nowrap">
            <Heart :size="16" class="fill-current" />
            <span class="hidden sm:inline">贊助平台</span>
          </RouterLink>

          <!-- User Avatar (Logged In) -->
          <template v-if="isAuthenticated">
            <button
              @click="isLoginModalOpen = true"
              class="flex items-center gap-1 sm:gap-2 bg-white/10 hover:bg-white/20 text-white p-1.5 sm:px-3 sm:py-1.5 rounded-full text-sm font-bold transition-all border border-white/20"
            >
              <img
                v-if="userAvatarUrl"
                :src="userAvatarUrl"
                :alt="userDisplayName"
                class="w-6 h-6 sm:w-7 sm:h-7 rounded-full object-cover"
              />
              <div v-else class="w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-blue-500 flex items-center justify-center text-white text-xs font-bold">
                {{ userDisplayName.charAt(0).toUpperCase() }}
              </div>
              <span class="hidden sm:inline max-w-[100px] truncate">{{ userDisplayName }}</span>
            </button>
          </template>

          <!-- Login Button (Not Logged In) -->
          <template v-else>
            <button
              @click="isLoginModalOpen = true"
              class="bg-white/10 hover:bg-white/20 text-white p-2 sm:px-3 sm:py-2 rounded-md text-sm font-bold flex items-center gap-1.5 transition-all border border-white/20 whitespace-nowrap"
            >
              <LogIn :size="16" />
              <span class="hidden sm:inline">登入</span>
            </button>
          </template>
        </div>
      </div>
    </div>


    <!-- Login/Profile Modal -->
    <div v-if="isLoginModalOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" @click="isLoginModalOpen = false">
      <div class="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 p-8" @click.stop>
        <!-- Logged In: User Profile -->
        <template v-if="isAuthenticated">
          <div class="flex items-center justify-between mb-6">
            <h2 class="text-2xl font-bold text-navy-900">我的帳戶</h2>
            <button
              @click="isLoginModalOpen = false"
              class="text-slate-400 hover:text-slate-600 transition-colors"
            >
              <X :size="24" />
            </button>
          </div>

          <div class="text-center mb-8">
            <img
              v-if="userAvatarUrl"
              :src="userAvatarUrl"
              :alt="userDisplayName"
              class="w-20 h-20 rounded-full object-cover mx-auto mb-4 border-4 border-blue-100"
            />
            <div v-else class="w-20 h-20 rounded-full bg-blue-500 flex items-center justify-center text-white text-2xl font-bold mx-auto mb-4">
              {{ userDisplayName.charAt(0).toUpperCase() }}
            </div>
            <h3 class="text-xl font-bold text-navy-900">{{ userDisplayName }}</h3>
            <p class="text-slate-500 text-sm mt-1">已登入</p>
          </div>

          <button
            @click="handleSignOut"
            class="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
          >
            <LogOut :size="18" />
            登出
          </button>
        </template>

        <!-- Not Logged In: Login Options -->
        <template v-else>
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
            <p class="text-slate-600 text-center mb-6">
              使用 Google 帳戶快速登入，參與公民討論與政見追蹤。
            </p>

            <button
              @click="handleGoogleLogin"
              :disabled="isLoggingIn"
              class="w-full bg-white hover:bg-slate-50 text-slate-700 font-bold py-3 px-4 rounded-xl transition-colors shadow-md border border-slate-200 flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <template v-if="isLoggingIn">
                <Loader2 :size="20" class="animate-spin" />
                <span>登入中...</span>
              </template>
              <template v-else>
                <svg class="w-5 h-5" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                <span>使用 Google 登入</span>
              </template>
            </button>

            <p class="text-center text-xs text-slate-400 mt-6">
              登入即表示您同意我們的服務條款與隱私政策
            </p>
          </div>
        </template>
      </div>
    </div>
  </nav>
</template>
