<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Loader2, AlertCircle, Inbox, KeyRound, Plus, X, CheckCircle2, ExternalLink } from 'lucide-vue-next'

/**
 * 看板「任務」分頁：手動任務（維護者建／代理提議／網站請求）的 open 與 closed，加上自動缺口的數量。
 * 資料：GET /functions/v1/tasks?include_closed=1&with_current=0（公開）。
 * 維護者面板：金鑰只放 sessionStorage，打 POST /functions/v1/apply 的 create_task／close_task。
 */

interface BoardTask {
  task_id: string
  task_type: string
  title: string
  description: string | null
  target: Record<string, unknown> | null
  region: string | null
  priority: number
  reward: number
  source: string
  suggested_by: string | null
  created_by: string | null
  status: 'open' | 'closed'
  created_at: string
  closed_at: string | null
  hint_sources: string[]
}

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`
const KEY_STORAGE = 'policytw.maintainer_key'

const TASK_TYPE_LABEL: Record<string, string> = {
  policy_missing: '缺政見', profile_gap: '缺人物資料', policy_source_missing: '政見缺出處',
  progress_stale: '進度停滯', candidacy_source_missing: '參選缺出處', other: '其他',
}
const SOURCE_LABEL: Record<string, string> = { manual: '維護者', suggested: 'AI 提議', web_request: '網站請求' }
const SOURCE_CLASS: Record<string, string> = {
  manual: 'bg-navy-900 text-white', suggested: 'bg-violet-100 text-violet-800', web_request: 'bg-sky-100 text-sky-800',
}

const tasks = ref<BoardTask[]>([])
const totals = ref<Record<string, number>>({})
const loading = ref(false)
const error = ref<string | null>(null)
const showClosed = ref(false)

function headers(): Record<string, string> {
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  return { 'Content-Type': 'application/json', ...(key ? { apikey: key, Authorization: `Bearer ${key}` } : {}) }
}

async function load() {
  loading.value = true
  error.value = null
  try {
    const res = await fetch(`${FN_BASE}/tasks?include_closed=1&with_current=0&limit=50`, { headers: headers() })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body?.success) throw new Error(body?.message || body?.error || `HTTP ${res.status}`)
    tasks.value = (body.tasks as BoardTask[]).filter(t => t.source !== 'auto')
    const { manual_open: _ignored, ...auto } = body.totals ?? {}
    totals.value = auto
  } catch (e) {
    error.value = e instanceof Error ? e.message : '讀取失敗'
    tasks.value = []
  } finally {
    loading.value = false
  }
}

const openTasks = computed(() => tasks.value.filter(t => t.status === 'open'))
const closedTasks = computed(() => tasks.value.filter(t => t.status === 'closed'))
const autoTotal = computed(() => Object.values(totals.value).reduce((a, n) => a + n, 0))

function targetLink(t: BoardTask): { href: string; label: string } | null {
  const target = t.target ?? {}
  if (typeof target.policy_id === 'string') return { href: `/policy/${target.policy_id}`, label: '看政見頁' }
  if (typeof target.politician_id === 'string') return { href: `/politician/${target.politician_id}`, label: '看人物頁' }
  return null
}
function fmtTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// === 維護者面板 ===
const adminOpen = ref(false)
const apiKey = ref('')
const submitting = ref(false)
const adminError = ref<string | null>(null)
const adminNotice = ref<string | null>(null)
const closingId = ref<string | null>(null)

interface TaskForm { title: string; description: string; task_type: string; target_politician_id: string; target_policy_id: string; region: string; priority: number; hint_sources: string }
const EMPTY_FORM: TaskForm = { title: '', description: '', task_type: 'other', target_politician_id: '', target_policy_id: '', region: '', priority: 1, hint_sources: '' }
const form = ref<TaskForm>({ ...EMPTY_FORM })

function readStoredKey(): string {
  try { return sessionStorage.getItem(KEY_STORAGE) || '' } catch { return '' }
}
function rememberKey() {
  try { sessionStorage.setItem(KEY_STORAGE, apiKey.value) } catch { /* 無法寫入時只在記憶體用 */ }
}
function forgetKey() {
  apiKey.value = ''
  try { sessionStorage.removeItem(KEY_STORAGE) } catch { /* ignore */ }
}

async function callApply(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${FN_BASE}/apply`, { method: 'POST', headers: headers(), body: JSON.stringify({ api_key: apiKey.value, ...payload }) })
  const body = await res.json().catch(() => null)
  if (res.status === 401) throw new Error('金鑰不對')
  if (!res.ok || !body?.success) {
    const detail = Array.isArray(body?.errors) ? body.errors.map((e: { path: string; message: string }) => `${e.path}：${e.message}`).join('；') : ''
    throw new Error(detail || body?.message || body?.error || `HTTP ${res.status}`)
  }
  return body
}

async function createTask() {
  if (!apiKey.value.trim()) { adminError.value = '先填維護者金鑰'; return }
  submitting.value = true
  adminError.value = null
  adminNotice.value = null
  try {
    const f = form.value
    const task = {
      title: f.title.trim(),
      description: f.description.trim() || null,
      task_type: f.task_type,
      target_politician_id: f.target_politician_id.trim() || null,
      target_policy_id: f.target_policy_id.trim() || null,
      region: f.region.trim() || null,
      priority: Number(f.priority) || 0,
      hint_sources: f.hint_sources.split(/\s+/).map(s => s.trim()).filter(Boolean),
    }
    await callApply({ action: 'create_task', task })
    rememberKey()
    adminNotice.value = `已新增「${task.title}」`
    form.value = { ...EMPTY_FORM }
    await load()
  } catch (e) {
    adminError.value = e instanceof Error ? e.message : '新增失敗'
  } finally {
    submitting.value = false
  }
}

async function closeTask(t: BoardTask) {
  if (!apiKey.value.trim()) { adminError.value = '先填維護者金鑰'; adminOpen.value = true; return }
  closingId.value = t.task_id
  adminError.value = null
  try {
    await callApply({ action: 'close_task', task_id: t.task_id })
    rememberKey()
    adminNotice.value = `已關閉「${t.title}」`
    await load()
  } catch (e) {
    adminError.value = e instanceof Error ? e.message : '關閉失敗'
  } finally {
    closingId.value = null
  }
}

onMounted(() => {
  apiKey.value = readStoredKey()
  load()
})

defineExpose({ load })
</script>

<template>
  <section class="space-y-6" data-testid="task-board">
    <!-- 自動缺口數量 -->
    <div class="bg-white rounded-2xl shadow-lg border border-slate-200 p-4 sm:p-5" data-testid="gap-counts">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
        <h3 class="font-black text-navy-900">自動偵測的缺口</h3>
        <span class="text-xs text-slate-400">系統即時掃出來、不需人建的任務；AI 代理跑 /next 就會被派到</span>
        <span class="ml-auto text-sm font-bold text-navy-900">共 {{ loading ? '–' : autoTotal }} 件</span>
      </div>
      <div class="flex flex-wrap gap-2">
        <span v-for="(n, k) in totals" :key="k" class="px-3 py-1.5 rounded-full bg-slate-100 text-xs font-bold text-slate-700">
          {{ TASK_TYPE_LABEL[String(k)] ?? k }} <span class="text-navy-900">{{ n }}</span>
        </span>
        <span v-if="!loading && Object.keys(totals).length === 0" class="text-xs text-slate-400">目前沒有缺口</span>
      </div>
    </div>

    <!-- 手動任務 -->
    <div class="bg-white rounded-2xl shadow-lg border border-slate-200">
      <div class="p-4 sm:p-5 border-b border-slate-100 flex flex-wrap items-center gap-3">
        <h3 class="font-black text-navy-900">手動任務 <span class="text-sm font-bold text-slate-400">open {{ openTasks.length }}・closed {{ closedTasks.length }}</span></h3>
        <label class="text-xs text-slate-500 inline-flex items-center gap-1.5 ml-auto"><input v-model="showClosed" type="checkbox" class="rounded" data-testid="toggle-closed" /> 顯示已關閉</label>
        <button type="button" class="px-3 py-1.5 rounded-lg text-xs font-bold inline-flex items-center gap-1 bg-navy-900 text-white" data-testid="task-admin-toggle" @click="adminOpen = !adminOpen">
          <component :is="adminOpen ? X : Plus" :size="14" /> {{ adminOpen ? '收起' : '新增任務' }}
        </button>
      </div>

      <!-- 維護者面板 -->
      <div v-if="adminOpen" class="p-4 sm:p-5 border-b border-slate-100 bg-slate-50 space-y-3" data-testid="task-admin">
        <div class="flex flex-col sm:flex-row gap-2 sm:items-center">
          <label class="text-xs font-bold text-slate-500 inline-flex items-center gap-1"><KeyRound :size="14" /> 維護者金鑰</label>
          <input v-model="apiKey" type="password" autocomplete="off" placeholder="只存在這個分頁的 sessionStorage，關掉就消失" class="flex-1 text-sm border border-slate-300 rounded-lg px-3 py-2 bg-white" data-testid="task-admin-key" />
          <button v-if="apiKey" type="button" class="text-xs text-slate-500 underline" @click="forgetKey">清除</button>
        </div>
        <form class="grid sm:grid-cols-2 gap-3" data-testid="task-form" @submit.prevent="createTask">
          <input v-model="form.title" required minlength="2" maxlength="200" placeholder="標題（必填）" class="sm:col-span-2 text-sm border border-slate-300 rounded-lg px-3 py-2 bg-white" />
          <textarea v-model="form.description" rows="3" placeholder="說明：缺什麼、到哪裡找、要附什麼出處" class="sm:col-span-2 text-sm border border-slate-300 rounded-lg px-3 py-2 bg-white"></textarea>
          <select v-model="form.task_type" class="text-sm border border-slate-300 rounded-lg px-3 py-2 bg-white">
            <option v-for="(label, k) in TASK_TYPE_LABEL" :key="k" :value="k">{{ label }}（{{ k }}）</option>
          </select>
          <input v-model.number="form.priority" type="number" min="0" max="100" placeholder="優先序（越大越先派）" class="text-sm border border-slate-300 rounded-lg px-3 py-2 bg-white" />
          <input v-model="form.target_politician_id" placeholder="目標人物 id（uuid，選填）" class="text-sm border border-slate-300 rounded-lg px-3 py-2 bg-white font-mono" />
          <input v-model="form.target_policy_id" placeholder="目標政見 id（uuid，選填）" class="text-sm border border-slate-300 rounded-lg px-3 py-2 bg-white font-mono" />
          <input v-model="form.region" placeholder="縣市（選填）" class="text-sm border border-slate-300 rounded-lg px-3 py-2 bg-white" />
          <input v-model="form.hint_sources" placeholder="建議來源網址，用空白分隔（選填）" class="text-sm border border-slate-300 rounded-lg px-3 py-2 bg-white" />
          <div class="sm:col-span-2 flex flex-wrap items-center gap-3">
            <button type="submit" :disabled="submitting" class="px-4 py-2 rounded-lg bg-navy-900 text-white text-sm font-bold inline-flex items-center gap-2">
              <Loader2 v-if="submitting" :size="14" class="animate-spin" /> 建立任務
            </button>
            <span v-if="adminNotice" class="text-sm text-emerald-700 inline-flex items-center gap-1"><CheckCircle2 :size="14" /> {{ adminNotice }}</span>
            <span v-if="adminError" class="text-sm text-red-700" data-testid="task-admin-error">{{ adminError }}</span>
          </div>
        </form>
      </div>

      <div v-if="loading" class="p-10 text-center text-slate-500" data-testid="task-loading">
        <Loader2 :size="28" class="animate-spin mx-auto mb-2 text-blue-500" />載入中…
      </div>
      <div v-else-if="error" class="p-8 text-center" data-testid="task-error">
        <AlertCircle :size="28" class="mx-auto mb-2 text-red-500" />
        <p class="font-bold text-slate-800">暫時讀不到任務</p>
        <p class="text-sm text-slate-500 mt-1">{{ error }}</p>
        <button type="button" class="mt-4 px-4 py-2 rounded-lg bg-navy-900 text-white text-sm font-bold" @click="load">再試一次</button>
      </div>
      <div v-else-if="openTasks.length === 0 && (!showClosed || closedTasks.length === 0)" class="p-10 text-center text-slate-500" data-testid="task-empty">
        <Inbox :size="32" class="mx-auto mb-2 text-slate-300" />
        <p class="font-bold">目前沒有手動任務</p>
        <p class="text-sm mt-1">自動缺口仍會派給 AI 代理；有特別想補的，維護者可在上方新增。</p>
      </div>
      <ul v-else class="divide-y divide-slate-100" data-testid="task-list">
        <li v-for="t in (showClosed ? tasks : openTasks)" :key="t.task_id" class="p-4 sm:p-5" :class="t.status === 'closed' ? 'opacity-60' : ''" data-testid="task-item" :data-status="t.status" :data-source="t.source">
          <div class="flex flex-wrap items-center gap-2 mb-1.5">
            <span :class="['text-[11px] font-bold px-2 py-0.5 rounded-full', SOURCE_CLASS[t.source] ?? 'bg-slate-100 text-slate-600']">{{ SOURCE_LABEL[t.source] ?? t.source }}</span>
            <span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{{ TASK_TYPE_LABEL[t.task_type] ?? t.task_type }}</span>
            <span v-if="t.status === 'closed'" class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">已關閉{{ t.closed_at ? `・${fmtTime(t.closed_at)}` : '' }}</span>
            <span v-if="t.region" class="text-[11px] text-slate-500">{{ t.region }}</span>
            <span class="text-[11px] text-slate-400 ml-auto whitespace-nowrap">{{ fmtTime(t.created_at) }}</span>
          </div>
          <p class="font-bold text-navy-900 leading-snug break-words">{{ t.title }}</p>
          <p v-if="t.description" class="mt-1 text-sm text-slate-600 whitespace-pre-wrap break-words">{{ t.description }}</p>
          <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span v-if="t.suggested_by">提議者 {{ t.suggested_by }}</span>
            <span v-else-if="t.created_by && t.source === 'manual'">建立者 {{ t.created_by }}</span>
            <span>優先序 {{ t.priority }}</span>
            <a v-if="targetLink(t)" :href="targetLink(t)!.href" class="text-blue-700 underline underline-offset-2 font-bold">{{ targetLink(t)!.label }}</a>
            <a v-for="u in t.hint_sources" :key="u" :href="u" target="_blank" rel="noopener" class="text-blue-700 underline underline-offset-2 inline-flex items-center gap-1 break-all"><ExternalLink :size="10" />{{ u }}</a>
            <button v-if="t.status === 'open'" type="button" class="ml-auto text-xs font-bold text-red-700 underline underline-offset-2" :disabled="closingId === t.task_id" data-testid="task-close" @click="closeTask(t)">
              {{ closingId === t.task_id ? '關閉中…' : '關閉' }}
            </button>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>
