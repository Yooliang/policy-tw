<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { X, Heart, CircleUserRound } from 'lucide-vue-next'
import { useMobileShell } from '../composables/useMobileShell'
import { useSupabase } from '../composables/useSupabase'
import { footerElections, taipeiDay } from '../lib/election-list'
import { electionPath } from '../lib/election-regions'
import { electionSegment } from '../lib/election-route'
import AppearancePanel from './AppearancePanel.vue'

// 手機版左側抽屜選單（X 式版面）：頁首左邊的選單鈕、畫面左緣往右滑、分頁區在最左一頁再往右拉，都會把它拉出來。
// 內容是 Footer 的連結加帳號、顯示設定與贊助；往左滑或點背板關閉。
const props = defineProps<{ isAuthenticated: boolean; userDisplayName: string; userAvatarUrl?: string | null }>()
const emit = defineEmits<{ (e: 'login'): void; (e: 'profile'): void }>()

const route = useRoute()
const { drawerOpen, closeDrawer } = useMobileShell()
const { elections } = useSupabase()
const electionList = computed(() => footerElections(elections.value, taipeiDay(Date.now())))

watch(() => route.fullPath, closeDrawer)
watch(drawerOpen, (open) => {
  if (typeof document === 'undefined') return
  document.documentElement.style.overflow = open ? 'hidden' : ''
})
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') closeDrawer() }
onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
  if (typeof document !== 'undefined') document.documentElement.style.overflow = ''
})

let sx = 0
let sy = 0
function onTouchStart(e: TouchEvent) {
  const t = e.touches[0]
  if (t) { sx = t.clientX; sy = t.clientY }
}
function onTouchEnd(e: TouchEvent) {
  const t = e.changedTouches[0]
  if (!t) return
  const dx = t.clientX - sx
  const dy = t.clientY - sy
  if (dx < -56 && Math.abs(dx) > Math.abs(dy) * 1.5) closeDrawer()
}
function onAccount() {
  closeDrawer()
  if (props.isAuthenticated) emit('profile')
  else emit('login')
}
const linkClass = 'block rounded-lg px-3 py-2.5 text-[15px] font-bold text-navy-900 active:bg-slate-100'
</script>

<template>
  <div class="md:hidden" data-testid="mobile-drawer-root">
    <div
      class="fixed inset-0 z-[80] bg-black/40 transition-opacity duration-200 motion-reduce:transition-none"
      :class="drawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0'"
      aria-hidden="true"
      @click="closeDrawer"
    ></div>
    <aside
      class="fixed inset-y-0 left-0 z-[81] flex w-[82%] max-w-[320px] flex-col overflow-y-auto overscroll-contain bg-white shadow-2xl transition-transform duration-200 ease-out motion-reduce:transition-none pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      :class="drawerOpen ? 'translate-x-0' : '-translate-x-full'"
      role="dialog"
      aria-modal="true"
      aria-label="選單"
      :aria-hidden="!drawerOpen"
      :inert="!drawerOpen || undefined"
      data-testid="mobile-drawer"
      @touchstart.passive="onTouchStart"
      @touchend.passive="onTouchEnd"
    >
      <div class="flex items-center justify-between px-4 h-14 shrink-0 border-b border-slate-100">
        <img src="/brand/logo-zhengjian.png" alt="正見" width="72" height="40" class="h-8 w-auto object-contain" />
        <button type="button" class="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 active:bg-slate-100" aria-label="關閉選單" @click="closeDrawer"><X :size="22" /></button>
      </div>

      <button type="button" class="mx-3 mt-3 flex items-center gap-3 rounded-lg px-3 py-3 text-left text-[15px] font-bold text-navy-900 active:bg-slate-100" @click="onAccount">
        <img v-if="isAuthenticated && userAvatarUrl" :src="userAvatarUrl" :alt="userDisplayName" class="h-7 w-7 rounded-full object-cover" />
        <CircleUserRound v-else :size="26" />
        <span class="truncate">{{ isAuthenticated ? userDisplayName : '登入' }}</span>
      </button>

      <nav class="px-3 py-2" aria-label="站內連結">
        <p class="px-3 pt-2 pb-1 text-xs font-black text-slate-400">政見</p>
        <RouterLink to="/tracking" :class="linkClass">政見追蹤</RouterLink>
        <RouterLink to="/analysis" :class="linkClass">政策脈絡</RouterLink>
        <RouterLink to="/regional-data" :class="linkClass">縣市數據分佈</RouterLink>

        <p class="px-3 pt-3 pb-1 text-xs font-black text-slate-400">選舉</p>
        <RouterLink v-for="e in electionList" :key="e.id" :to="electionPath(electionSegment(e))" :class="linkClass">{{ e.shortName }}</RouterLink>
        <RouterLink to="/elections" :class="linkClass">選舉一覽</RouterLink>
        <a href="/politicians" :class="linkClass">人物一覽</a>
        <a href="/parties" :class="linkClass">政黨一覽</a>

        <p class="px-3 pt-3 pb-1 text-xs font-black text-slate-400">貢獻</p>
        <RouterLink to="/skill" :class="linkClass">參與貢獻</RouterLink>
        <RouterLink to="/contributions" :class="linkClass">AI 協作動態牆</RouterLink>
        <RouterLink to="/queue" :class="linkClass">派工隊列</RouterLink>
        <RouterLink to="/sources" :class="linkClass">查證來源</RouterLink>

        <p class="px-3 pt-3 pb-1 text-xs font-black text-slate-400">關於</p>
        <RouterLink to="/vision" :class="linkClass">關於正見</RouterLink>
        <RouterLink to="/contact" :class="linkClass">聯絡我們</RouterLink>
        <RouterLink to="/terms" :class="linkClass">使用條款</RouterLink>
        <RouterLink to="/privacy" :class="linkClass">隱私權政策</RouterLink>
      </nav>

      <div class="mx-3 mt-1 border-t border-slate-100 px-3 pt-4">
        <AppearancePanel />
      </div>

      <RouterLink to="/donation" class="mx-3 my-4 flex items-center gap-3 rounded-lg px-3 py-3 text-[15px] font-bold text-navy-900 active:bg-slate-100" aria-label="贊助平台">
        <span class="flex h-7 w-7 items-center justify-center rounded-full bg-red-500 text-white"><Heart :size="14" class="fill-current" /></span>
        <span>贊助平台</span>
      </RouterLink>
    </aside>
  </div>
</template>
