<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Check, Copy, ExternalLink, X } from 'lucide-vue-next'
import { supabasePublic } from '../lib/supabase'
import { renderMdPreview } from '../lib/md/html'
import { renderPage } from '../lib/md/format'
import type { MdPage } from '../lib/md/format'

/**
 * .md 摘要抽屜（2026-10-19 從政見矩陣抽出來共用：政見矩陣、選舉頁「議題串聯」）。
 * 讀預產快取表 data_md_cache 的一列排成網頁；標題旁「複製給 AI」（整份原文含 front matter）與「另開視窗」（開 .md 網址）。
 * pick＝null 是關著；Esc、背景、叉叉都送 close，由呼叫端把 pick 設回 null。
 * 不是快取表的內容也能開：給 text（呼叫端現場組好的原文，例如比較表）或 src（向 Worker 要的 .md 網址，例如人物頁）就不讀快取表。
 * path 空字串就不顯示「另開視窗」。
 */
export interface MdPick {
  id: string
  /** data_md_cache 的 path；有 text 或 src 時不用 */
  row?: string
  /** 「另開視窗」的網址；空字串不顯示 */
  path: string
  title: string
  /** 呼叫端現場組好的 Markdown 原文 */
  text?: string
  /** 開的時候才 fetch 的 .md 網址（同站） */
  src?: string
  /** 複製按鈕字樣，預設「複製給 AI」 */
  copyLabel?: string
}
interface CacheRow { body: string; meta: Record<string, unknown>; generated_at: string }

const props = defineProps<{ pick: MdPick | null }>()
const emit = defineEmits<{ close: [] }>()

const panel = ref<{ text: string; loading: boolean; failed: boolean }>({ text: '', loading: false, failed: false })

/** 抽屜開著時：Esc 關閉、Tab 只在抽屜裡轉、背景不捲動；關掉後焦點回到點開它的那一格 */
const drawerEl = ref<HTMLElement | null>(null)
let opener: HTMLElement | null = null
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
    return
  }
  if (e.key !== 'Tab' || !drawerEl.value) return
  const items = Array.from(drawerEl.value.querySelectorAll<HTMLElement>(FOCUSABLE))
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (e.shiftKey && (active === first || active === drawerEl.value)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

function unlock() {
  window.removeEventListener('keydown', onKey)
  document.body.style.overflow = ''
}

async function load(p: MdPick) {
  copied.value = false
  if (p.text !== undefined) {
    panel.value = { text: p.text, loading: false, failed: !p.text }
    return
  }
  panel.value = { text: '', loading: true, failed: false }
  if (p.src) {
    try {
      const res = await fetch(p.src)
      if (!res.ok) throw new Error(String(res.status))
      const text = await res.text()
      if (props.pick?.id === p.id) panel.value = { text, loading: false, failed: !text }
    } catch {
      if (props.pick?.id === p.id) panel.value = { text: '', loading: false, failed: true }
    }
    return
  }
  try {
    // query-bounds: ok — 主鍵查一列
    const { data, error } = await supabasePublic.from('data_md_cache').select('body,meta,generated_at').eq('path', p.row).limit(1)
    if (error) throw error
    const row = (data ?? [])[0] as CacheRow | undefined
    if (props.pick?.id !== p.id) return
    panel.value = {
      text: row ? renderPage({ ...(row.meta as unknown as MdPage), body: [row.body] }, p.path, Date.parse(row.generated_at) || Date.now()) : '',
      loading: false,
      failed: !row,
    }
  } catch {
    if (props.pick?.id === p.id) panel.value = { text: '', loading: false, failed: true }
  }
}

watch(() => props.pick, async (now, before) => {
  if (now && (now.id !== before?.id || now.text !== before?.text)) void load(now)
  if (now && !before) {
    opener = document.activeElement as HTMLElement | null
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    await nextTick()
    drawerEl.value?.focus()
  } else if (!now && before) {
    unlock()
    // 關掉（Esc、背景、叉叉）後把焦點還給點開它的連結
    opener?.focus()
    opener = null
  }
})
onBeforeUnmount(unlock)

// 抽屜裡看的是排好版的網頁；「複製給 AI」複製的是整份原文（含 front matter）
const preview = computed(() => (panel.value.text ? renderMdPreview(panel.value.text) : null))
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
async function copyRaw() {
  const text = panel.value.text
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // 沒有剪貼簿權限（舊瀏覽器、非 https）就退回選取＋複製指令
    const box = document.createElement('textarea')
    box.value = text
    box.style.position = 'fixed'
    box.style.opacity = '0'
    document.body.appendChild(box)
    box.select()
    try { document.execCommand('copy') } finally { document.body.removeChild(box) }
  }
  copied.value = true
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = false }, 1500)
}
onBeforeUnmount(() => clearTimeout(copiedTimer))

const DRAWER_BTN = 'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors'
</script>

<template>
  <!-- 摘要抽屜：桌機從右側滑出、手機全寬；背景遮罩、叉叉、Esc 都能關 -->
  <Transition name="drawer">
    <div v-if="pick" class="fixed inset-0 z-[60]" data-testid="matrix-drawer">
      <div class="absolute inset-0 bg-black/40 backdrop-blur-sm" @click="emit('close')"></div>
      <aside
        ref="drawerEl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="matrix-drawer-title"
        tabindex="-1"
        class="drawer-panel absolute right-0 top-0 h-full w-full sm:w-[34rem] lg:w-[40rem] max-w-full bg-white shadow-2xl flex flex-col outline-none"
      >
        <header class="border-b border-slate-200 px-4 py-3">
          <div class="flex items-start justify-between gap-3">
            <h2 id="matrix-drawer-title" class="min-w-0 font-bold text-slate-800 leading-snug">{{ pick.title }}</h2>
            <button type="button" class="shrink-0 rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="關閉" @click="emit('close')"><X :size="20" /></button>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              :disabled="!panel.text"
              :class="[DRAWER_BTN, copied ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700', 'disabled:cursor-not-allowed disabled:opacity-40']"
              data-testid="matrix-copy"
              @click="copyRaw"
            >
              <component :is="copied ? Check : Copy" :size="16" />{{ copied ? '已複製' : (pick.copyLabel || '複製給 AI') }}
            </button>
            <a v-if="pick.path" :href="pick.path" target="_blank" rel="noopener" :class="[DRAWER_BTN, 'border-slate-200 text-slate-700 hover:bg-slate-50']">
              <ExternalLink :size="16" />另開視窗
            </a>
          </div>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <p v-if="panel.loading" class="text-slate-500">載入中…</p>
          <p v-else-if="panel.failed" class="text-slate-500">這一份的摘要讀取失敗</p>
          <template v-else-if="preview">
            <p v-if="preview.dataAsOf" class="mb-2 text-xs text-slate-400">資料更新：{{ preview.dataAsOf }}</p>
            <!-- 內容來自資料庫：lib/md/html.ts 已把原始 HTML 跳脫、只放安全網址、連結新分頁開 -->
            <article class="md-doc" v-html="preview.html" />
          </template>
        </div>
      </aside>
    </div>
  </Transition>
</template>

<style scoped>
.drawer-enter-active, .drawer-leave-active { transition: opacity 0.2s ease; }
.drawer-enter-active .drawer-panel, .drawer-leave-active .drawer-panel { transition: transform 0.25s ease; }
.drawer-enter-from, .drawer-leave-to { opacity: 0; }
.drawer-enter-from .drawer-panel, .drawer-leave-to .drawer-panel { transform: translateX(100%); }
@media (prefers-reduced-motion: reduce) {
  .drawer-enter-active, .drawer-leave-active, .drawer-enter-active .drawer-panel, .drawer-leave-active .drawer-panel { transition: none; }
}

/* 沒裝 typography plugin，跟技能頁（Skill.vue）一樣手寫最小一套文件樣式，尺寸小一級 */
.md-doc :deep(h1) { font-size: 1.25rem; font-weight: 900; color: #0f172a; margin: 0 0 0.75rem; line-height: 1.3; }
.md-doc :deep(h2) { font-size: 1.1rem; font-weight: 800; color: #0f172a; margin: 1.5rem 0 0.5rem; padding-top: 1rem; border-top: 1px solid #e2e8f0; }
.md-doc :deep(h2:first-child) { margin-top: 0; padding-top: 0; border-top: 0; }
.md-doc :deep(h3) { font-size: 1rem; font-weight: 700; color: #1e293b; margin: 1.25rem 0 0.4rem; }
.md-doc :deep(p), .md-doc :deep(li) { color: #334155; line-height: 1.75; font-size: 0.9rem; }
.md-doc :deep(p) { margin: 0.5rem 0; }
.md-doc :deep(ul), .md-doc :deep(ol) { padding-left: 1.3rem; margin: 0.4rem 0; }
.md-doc :deep(ul) { list-style: disc; }
.md-doc :deep(ol) { list-style: decimal; }
.md-doc :deep(li) { margin: 0.2rem 0; }
.md-doc :deep(strong) { color: #0f172a; font-weight: 700; }
.md-doc :deep(a) { color: #1d4ed8; text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
.md-doc :deep(code) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; background: #f1f5f9; padding: 0.1rem 0.3rem; border-radius: 0.3rem; color: #0f172a; overflow-wrap: anywhere; }
.md-doc :deep(pre) { background: #0f172a; color: #e2e8f0; border-radius: 0.6rem; padding: 0.75rem 1rem; overflow-x: auto; margin: 0.6rem 0; font-size: 0.8rem; line-height: 1.6; }
.md-doc :deep(pre code) { background: transparent; color: inherit; padding: 0; overflow-wrap: normal; }
.md-doc :deep(blockquote) { border-left: 4px solid #3b82f6; background: #eff6ff; margin: 0.6rem 0; padding: 0.3rem 0.9rem; border-radius: 0 0.5rem 0.5rem 0; }
.md-doc :deep(table) { width: 100%; border-collapse: collapse; margin: 0.6rem 0; font-size: 0.8rem; display: block; overflow-x: auto; }
.md-doc :deep(th), .md-doc :deep(td) { border: 1px solid #e2e8f0; padding: 0.4rem 0.55rem; text-align: left; vertical-align: top; }
.md-doc :deep(th) { background: #f8fafc; font-weight: 700; color: #0f172a; }
.md-doc :deep(hr) { border: 0; border-top: 1px solid #e2e8f0; margin: 1.25rem 0; }
</style>
