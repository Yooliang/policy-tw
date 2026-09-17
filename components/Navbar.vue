<script setup lang="ts">
import { ref, computed } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { TrendingUp, Heart, X, Vote, MessageSquare, CircleUserRound, Loader2 } from 'lucide-vue-next'
import { useSupabase } from '../composables/useSupabase'
import { useAuth } from '../composables/useAuth'
import GlobalSearch from './GlobalSearch.vue'

const isLoginModalOpen = ref(false)
const isLoggingIn = ref(false)
const route = useRoute()
const router = useRouter()
const { getActiveElection } = useSupabase()
const { isAuthenticated, userDisplayName, userAvatarUrl, signInWithGoogle, loading: authLoading } = useAuth()

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


const activeElection = computed(() => getActiveElection())

const navItems = computed(() => {
  const items = [
    // 「跨任期接力」（/analysis）不在主選單：它是「政見」底下的一種看法，
    // 入口在 PolicyViewNav。放兩個地方會讓人以為是兩件不同的事。
    // 「政見追蹤」而不是「政見」（2026-09-17 小良哥）：這一頁是追進度的，
    // 只寫「政見」會讓人以為是政見列表。手機仍用兩個字，不然會擠掉旁邊兩項。
    { name: '政見追蹤', shortName: '政見', path: '/tracking', icon: TrendingUp },
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
  <nav class="bg-white text-navy-900 sticky top-0 z-50 shadow-sm border-b border-slate-200">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <div class="flex items-center">
          <RouterLink to="/" class="flex-shrink-0 flex items-center gap-0.5 group">
            <!-- 站徽（2026-09-17）：水墨「正見」，兩字都由五個政黨色暈染而成。
                 兩字間距是字高的 10%——原圖間隔超過半個字寬，縮到 4% 又會讓
                 「正」的收筆撞上「見」的起筆。srcset 給 2x 螢幕用。 -->
            <img src="/brand/logo-zhengjian.png" srcset="/brand/logo-zhengjian.png 1x, /brand/logo-zhengjian@2x.png 2x"
              alt="正見" width="72" height="40"
              class="h-8 sm:h-10 w-auto object-contain group-hover:scale-105 transition-transform" />
          </RouterLink>
        </div>

        <!-- Nav Items: Always visible, shorter text on mobile -->
        <div class="flex-1 flex justify-center">
          <!-- 桌面版（lg 以上）圖示與文字左右排，兩者都放大；窄螢幕維持上下疊，
               不然三個項目加起來會擠掉右邊的登入鈕（2026-09-17 小良哥）。 -->
          <div class="flex items-center space-x-0.5 sm:space-x-1 lg:space-x-2">
            <RouterLink
              v-for="item in navItems"
              :key="item.name"
              :to="item.path"
              :class="`flex flex-col lg:flex-row items-center justify-center lg:gap-2 px-2 sm:px-4 lg:px-5 py-1.5 lg:py-2.5 rounded-xl text-[10px] sm:text-xs lg:text-base font-bold transition-colors duration-200 min-w-[48px] sm:min-w-[72px] ${
                isActive(item.path)
                  ? 'bg-blue-50 text-blue-700 border border-blue-200'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-navy-900'
              }`"
            >
              <component :is="item.icon" :size="18" class="mb-0.5 sm:mb-1 lg:mb-0 lg:w-[22px] lg:h-[22px]" />
              <span class="sm:hidden">{{ item.shortName }}</span>
              <span class="hidden sm:inline">{{ item.name }}</span>
            </RouterLink>
          </div>
        </div>

        <!-- Right Side Actions -->
        <div class="flex items-center gap-1 sm:gap-2 flex-shrink-0">
          <GlobalSearch />

          <!-- User Avatar (Logged In) -->
          <template v-if="isAuthenticated">
            <button
              @click="router.push('/profile')"
              class="flex items-center gap-1 sm:gap-2 bg-slate-100 hover:bg-slate-200 text-navy-900 p-1.5 sm:px-3 sm:py-1.5 rounded-full text-sm font-bold transition-all border border-slate-200"
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
            <!-- 登入改成一個人的形象（2026-09-17 小良哥），跟旁邊的愛心一樣是圓鈕。
                 文字拿掉了，所以 aria-label 與 title 一定要留，不然讀螢幕的人不知道這是什麼。 -->
            <button
              @click="isLoginModalOpen = true"
              class="bg-slate-100 hover:bg-slate-200 text-navy-900 w-9 h-9 rounded-full flex items-center justify-center transition-colors border border-slate-200"
              aria-label="登入"
              title="登入"
            >
              <CircleUserRound :size="22" />
            </button>
          </template>

          <!-- 贊助：只用一顆愛心（2026-09-16 小良哥：「主選單那邊用個愛心即可」）；
               文字拿掉了，所以要有 aria-label 與 title，讀螢幕的人與滑過去的人才知道它是什麼 -->
          <RouterLink
            to="/donation"
            class="bg-red-500 hover:bg-red-600 text-white w-8 h-8 rounded-full flex items-center justify-center transition-all shadow-lg hover:shadow-red-500/20"
            aria-label="贊助平台"
            title="贊助平台"
          >
            <Heart :size="16" class="fill-current" />
          </RouterLink>
        </div>
      </div>
    </div>


    <!-- Login Modal (only for non-logged-in users) -->
    <div v-if="isLoginModalOpen && !isAuthenticated" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" @click="isLoginModalOpen = false">
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
      </div>
    </div>
  </nav>
</template>
