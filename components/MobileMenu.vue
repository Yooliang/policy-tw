<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { Menu, X, Heart, CircleUserRound, ALargeSmall } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import { initAppearance } from '../composables/useAppearance'
import AppearancePanel from './AppearancePanel.vue'

// 手機版（sm 以下）頁首右上角的一顆選單：顯示設定（字級與明暗）、登入／帳號、贊助。
// 2026-10-07：原本四顆圓鈕（搜尋、Aa、登入、愛心）在 360 寬就把中間三個主選單擠到跟站徽重疊，
// 所以手機版只留搜尋與這一顆；桌面版維持原樣。aria-label 照舊保留。
const props = defineProps<{
  isAuthenticated: boolean
  userDisplayName: string
  userAvatarUrl?: string | null
}>()
const emit = defineEmits<{ (e: 'login'): void; (e: 'profile'): void }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

// 用 composedPath 不用 e.target.contains：按鈕裡的圖示會在 click 處理完、事件還沒冒泡到 document 之前被換掉
// （Menu ↔ X），那時 e.target 已經脫離 DOM，contains 會回 false，選單一開就被關掉。
function onDocClick(e: MouseEvent) {
  if (open.value && root.value && !e.composedPath().includes(root.value)) open.value = false
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false
}

onMounted(() => {
  initAppearance()
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})

function onAccount() {
  open.value = false
  if (props.isAuthenticated) emit('profile')
  else emit('login')
}
</script>

<template>
  <div ref="root" class="relative" data-testid="mobile-menu">
    <button
      type="button"
      class="bg-slate-100 hover:bg-slate-200 text-navy-900 w-9 h-9 rounded-full flex items-center justify-center transition-colors border border-slate-200"
      aria-label="更多選單：顯示設定、登入、贊助"
      title="更多選單"
      aria-haspopup="true"
      :aria-expanded="open"
      data-testid="mobile-menu-open"
      @click="open = !open"
    >
      <X v-if="open" :size="20" />
      <Menu v-else :size="20" />
    </button>

    <div
      v-if="open"
      class="absolute right-0 mt-2 w-72 max-w-[calc(100vw-1.5rem)] bg-white border border-slate-200 rounded-2xl shadow-xl p-3 z-50"
      role="menu"
      aria-label="更多選單"
    >
      <div class="px-1 pt-1 pb-3 border-b border-slate-100">
        <div class="flex items-center gap-2 text-sm font-bold text-navy-900 mb-3">
          <ALargeSmall :size="20" aria-hidden="true" />
          <span>顯示設定：字級與明暗</span>
        </div>
        <AppearancePanel />
      </div>

      <button
        type="button"
        role="menuitem"
        class="w-full flex items-center gap-3 px-1 py-3 text-left text-sm font-bold text-navy-900 hover:bg-slate-50 rounded-lg"
        :aria-label="isAuthenticated ? '個人帳號' : '登入'"
        @click="onAccount"
      >
        <img v-if="isAuthenticated && userAvatarUrl" :src="userAvatarUrl" :alt="userDisplayName" class="w-6 h-6 rounded-full object-cover" />
        <CircleUserRound v-else :size="22" />
        <span class="truncate">{{ isAuthenticated ? userDisplayName : '登入' }}</span>
      </button>

      <RouterLink
        to="/donation"
        role="menuitem"
        class="w-full flex items-center gap-3 px-1 py-3 text-sm font-bold text-navy-900 hover:bg-slate-50 rounded-lg"
        aria-label="贊助平台"
        @click="open = false"
      >
        <span class="bg-red-500 text-white w-6 h-6 rounded-full flex items-center justify-center"><Heart :size="13" class="fill-current" /></span>
        <span>贊助平台</span>
      </RouterLink>
    </div>
  </div>
</template>
