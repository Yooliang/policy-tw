<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Search, X, Loader2, User, FileText } from 'lucide-vue-next'
import { supabasePublic as supabase } from '../lib/supabase'
import { withTimeoutAndRetry } from '../lib/retry'
import { useSupabase } from '../composables/useSupabase'

/**
 * 全站搜尋（2026-09-17 小良哥）：找人與找政見。
 *
 * 兩個刻意的區分：
 *   人物——「正在參選」用顏色標出來。站上 15,864 位政治人物裡，多數是歷屆的紀錄，
 *         現在要找的人幾乎都是這一屆的候選人，混在一起等於沒篩。
 *   政見——競選承諾弱化。承諾是「說要做」，一般政見是「在做／做完了」，
 *         兩者放在同一份清單裡要看得出分量不同。
 *
 * 不預載資料：politicians 有一萬五千筆，全載進瀏覽器只為了搜尋不划算。
 * 打字停下來才查（防抖 220ms），每次各取 6 筆。
 */
const router = useRouter()
const { getActiveElection, elections } = useSupabase()

interface PersonHit {
  id: string
  name: string
  party: string | null
  region: string | null
  current_position: string | null
  election_ids: number[] | null
  /** 這一屆參選的職位（有值代表正在參選） */
  running_type?: string | null
  /** 現任的職位（上一屆當選、任期內） */
  incumbent_type?: string | null
}

/**
 * 排序用的職位位階（2026-09-17 小良哥：「人無高低，但職位位階較高的會較常被搜尋」）。
 * 順序照 types.ts 的 ElectionType，不是我自己排的。
 */
const TYPE_RANK: Record<string, number> = {
  總統副總統: 0, 立法委員: 1, 縣市長: 2, 縣市議員: 3, 鄉鎮市長: 4,
  直轄市山地原住民區長: 5, 鄉鎮市民代表: 6, 直轄市山地原住民區民代表: 7, 村里長: 8,
}
const rankOf = (t: string | null | undefined): number => (t && TYPE_RANK[t] !== undefined ? TYPE_RANK[t] : 9)
/** AI 推測會選、但中選會名單裡沒有的（not_running）與退選的，不算「正在參選」 */
const RUNNING_STATUSES = ['rumored', 'likely', 'confirmed', 'registered', 'qualified']
interface PolicyHit { id: string; title: string; status: string | null; election_id: number | null }

const open = ref(false)
const term = ref('')
const loading = ref(false)
const people = ref<PersonHit[]>([])
const policies = ref<PolicyHit[]>([])
const inputEl = ref<HTMLInputElement | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null
let seq = 0

const refElection = computed(() => getActiveElection() ?? null)
const activeYear = computed(() => refElection.value?.id ?? null)
/**
 * 投票日過了沒？（2026-09-17 小良哥問「2027 年沒有選舉時呢」）
 * getActiveElection() 在沒有進行中的選舉時會退回最近一屆，所以 2027 年搜尋拿到的是 2026。
 * 那時候該標的不是「參選中」——選完了，落選的人標成參選中是假的——而是「當選」。
 */
const voted = computed(() => {
  const d = refElection.value?.electionDate
  return !!d && d < new Date().toISOString().slice(0, 10)
})
/** 選前看候選人，選後看當選人 */
const highlightStatuses = computed(() => (voted.value ? ['elected'] : RUNNING_STATUSES))

/**
 * 排序的第一順位是「現在是不是這個人」，不是位階（2026-09-17 小良哥問「當選 現職 高低？」）。
 * 只看位階的話，2022 落選的縣市長會排在現任議員前面——那不是搜尋的人要找的。
 *   第一層：本屆候選人
 *   第二層：現任（最近幾屆當選、任期內）
 *   第三層：其他歷屆紀錄
 * 同一層之內才按職位位階排。
 */
const recentVotedYears = computed(() => {
  const today = new Date().toISOString().slice(0, 10)
  return elections.value
    .filter((e) => e.electionDate < today && Number(e.id) >= new Date().getFullYear() - 4)
    .map((e) => Number(e.id))
})
const hasResults = computed(() => people.value.length > 0 || policies.value.length > 0)

/** 這個人這一屆有沒有參選：有就標色，沒有就是歷屆紀錄 */
function isRunning(p: PersonHit): boolean {
  return !!p.running_type
}

function escapeTerm(s: string): string {
  // ilike 的萬用字元要擋掉，不然使用者打 % 會把整張表撈回來
  return s.replace(/[%_]/g, (m) => `\\${m}`)
}

async function run(q: string) {
  const mine = ++seq
  loading.value = true
  try {
    const like = `*${escapeTerm(q)}*`
    const year = activeYear.value
    const years = [...new Set([year, ...recentVotedYears.value].filter((v): v is number => typeof v === 'number'))]
    const [rows, all, po] = await Promise.all([
      // 一次撈本屆候選人與近幾屆當選人，回來再分層——比分兩次查快，也少一次往返
      years.length > 0
        ? withTimeoutAndRetry('search candidacies', (signal) =>
          supabase.from('politician_elections')
            .select('election_id, election_type, candidate_status, politicians!inner(id, name, party, region, current_position)')
            .in('election_id', years).in('candidate_status', [...highlightStatuses.value, 'elected'])
            .ilike('politicians.name', like).limit(40).abortSignal(signal))
        : Promise.resolve({ data: [] as unknown[] }),
      withTimeoutAndRetry('search politicians', (signal) =>
        supabase.from('politicians_with_elections')
          .select('id, name, party, region, current_position, election_type, election_ids')
          .ilike('name', like).limit(20).abortSignal(signal)),
      withTimeoutAndRetry('search policies', (signal) =>
        supabase.from('policies')
          .select('id, title, status, election_id')
          .ilike('title', like).is('removed_at', null).limit(6).abortSignal(signal)),
    ])
    if (mine !== seq) return // 使用者已經打了新的字，這次結果作廢

    const byId = new Map<string, PersonHit>()
    for (const row of ((rows.data ?? []) as Array<Record<string, any>>)) {
      const who = row.politicians
      if (!who?.id) continue
      const isThisTerm = row.election_id === year && highlightStatuses.value.includes(row.candidate_status)
      const isIncumbent = row.candidate_status === 'elected' && recentVotedYears.value.includes(row.election_id)
      const prev = byId.get(who.id) ?? { ...who, election_ids: null, running_type: null, incumbent_type: null } as PersonHit
      if (isThisTerm && (!prev.running_type || rankOf(row.election_type) < rankOf(prev.running_type))) prev.running_type = row.election_type
      if (isIncumbent && (!prev.incumbent_type || rankOf(row.election_type) < rankOf(prev.incumbent_type))) prev.incumbent_type = row.election_type
      byId.set(who.id, prev)
    }
    const others = ((all.data ?? []) as Array<Record<string, any>>)
      .filter((p) => !byId.has(p.id))
      .map((p) => ({ ...p, running_type: null, incumbent_type: null }) as PersonHit)

    const tier = (p: PersonHit) => (p.running_type ? 0 : p.incumbent_type ? 1 : 2)
    const typeOf = (p: PersonHit) => p.running_type ?? p.incumbent_type ?? (p as unknown as { election_type?: string }).election_type
    const ranked = [...byId.values(), ...others].sort((a, b) => tier(a) - tier(b) || rankOf(typeOf(a)) - rankOf(typeOf(b)))
    people.value = ranked.slice(0, 8)
    policies.value = (po.data ?? []) as PolicyHit[]
  } catch {
    if (mine === seq) { people.value = []; policies.value = [] }
  } finally {
    if (mine === seq) loading.value = false
  }
}

watch(term, (v) => {
  if (timer) clearTimeout(timer)
  const q = v.trim()
  if (q.length === 0) { people.value = []; policies.value = []; loading.value = false; return }
  timer = setTimeout(() => run(q), 220)
})

async function show() {
  open.value = true
  await nextTick()
  inputEl.value?.focus()
}

function close() {
  open.value = false
  term.value = ''
  people.value = []
  policies.value = []
}

function go(path: string) {
  close()
  router.push(path)
}
</script>

<template>
  <button
    type="button"
    class="bg-slate-100 hover:bg-slate-200 text-navy-900 w-9 h-9 rounded-full flex items-center justify-center transition-colors border border-slate-200"
    aria-label="搜尋"
    title="搜尋人物與政見"
    data-testid="global-search-open"
    @click="show"
  >
    <Search :size="18" />
  </button>

  <div v-if="open" class="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm flex items-start justify-center p-4 pt-[10vh]" @click="close">
    <div class="bg-white w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden" @click.stop>
      <div class="flex items-center gap-2 px-4 py-3 border-b border-slate-200">
        <Search :size="18" class="text-slate-400 shrink-0" />
        <!-- 用 text 不用 search：type="search" 瀏覽器會自己加一個清除的 ✕，
             跟右邊的關閉鈕並排就變成兩個叉（2026-09-17 小良哥抓到） -->
        <input
          ref="inputEl"
          v-model="term"
          type="text"
          placeholder="搜尋人物或政見…"
          class="flex-1 min-w-0 outline-none text-base placeholder:text-slate-400"
          data-testid="global-search-input"
          @keydown.esc="close"
        />
        <Loader2 v-if="loading" :size="16" class="animate-spin text-slate-400 shrink-0" />
        <button type="button" class="text-slate-400 hover:text-slate-700 shrink-0" aria-label="關閉" @click="close"><X :size="18" /></button>
      </div>

      <div class="max-h-[60vh] overflow-y-auto">
        <p v-if="!term.trim()" class="px-4 py-6 text-sm text-slate-400">輸入姓名或政見關鍵字。</p>
        <p v-else-if="!loading && !hasResults" class="px-4 py-6 text-sm text-slate-500" data-testid="global-search-empty">找不到「{{ term.trim() }}」。</p>

        <div v-if="people.length" class="py-2">
          <p class="px-4 pb-1 text-xs font-bold text-slate-400 inline-flex items-center gap-1"><User :size="12" />人物</p>
          <button
            v-for="p in people"
            :key="p.id"
            type="button"
            class="w-full text-left px-4 py-2 hover:bg-slate-50 flex items-center gap-2"
            data-testid="search-person"
            @click="go(`/politician/${p.id}`)"
          >
            <span :class="['font-bold', isRunning(p) || p.incumbent_type ? 'text-navy-900' : 'text-slate-500']">{{ p.name }}</span>
            <!-- 這一屆有參選的標色，其餘是歷屆紀錄 -->
            <span v-if="p.running_type" class="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 shrink-0">{{ activeYear }} {{ p.running_type }}{{ voted ? '・當選' : '' }}</span>
            <span v-else-if="p.incumbent_type" class="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700 shrink-0">現任{{ p.incumbent_type }}</span>
            <span class="text-xs text-slate-400 truncate">{{ [p.party, p.region, p.current_position].filter(Boolean).join('・') }}</span>
          </button>
        </div>

        <div v-if="policies.length" class="py-2 border-t border-slate-100">
          <p class="px-4 pb-1 text-xs font-bold text-slate-400 inline-flex items-center gap-1"><FileText :size="12" />政見</p>
          <button
            v-for="x in policies"
            :key="x.id"
            type="button"
            class="w-full text-left px-4 py-2 hover:bg-slate-50 flex items-center gap-2"
            data-testid="search-policy"
            @click="go(`/policy/${x.id}`)"
          >
            <!-- 競選承諾弱化：說要做的事，跟已經在做／做完的不同分量 -->
            <span v-if="x.status === 'Campaign Pledge'" class="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-400 shrink-0">承諾</span>
            <span v-else class="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 shrink-0">政見</span>
            <span :class="['truncate', x.status === 'Campaign Pledge' ? 'text-slate-500' : 'text-navy-900 font-medium']">{{ x.title }}</span>
            <span v-if="x.election_id" class="text-xs text-slate-400 shrink-0">{{ x.election_id }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
