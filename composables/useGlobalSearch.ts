import { computed, ref, watch, type Ref } from 'vue'
import { supabasePublic as supabase } from '../lib/supabase'
import { withTimeoutAndRetry } from '../lib/retry'
import { useSupabase } from './useSupabase'
import { electionYearOfDate } from '../lib/election-route'
import { isElectionVoted } from '../lib/policy-stage'
import { createSearchTracker } from '../lib/search-analytics'

/**
 * 全站搜尋（2026-09-17）：找人與找政見。
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
export interface PersonHit {
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
 * 排序用的職位位階（2026-09-17：「人無高低，但職位位階較高的會較常被搜尋」）。
 * 順序照 types.ts 的 ElectionType，不是我自己排的。
 */
const TYPE_RANK: Record<string, number> = {
  總統副總統: 0, 立法委員: 1, 縣市長: 2, 縣市議員: 3, 鄉鎮市長: 4,
  直轄市山地原住民區長: 5, 鄉鎮市民代表: 6, 直轄市山地原住民區民代表: 7, 村里長: 8,
}
const rankOf = (t: string | null | undefined): number => (t && TYPE_RANK[t] !== undefined ? TYPE_RANK[t] : 9)
/** 退選的（含 AI 推測會選、但中選會名單裡沒有的）與傳聞（空值），不算「正在參選」 */
const RUNNING_STATUSES = ['considering', 'declared', 'filed']
export interface PolicyHit { id: string; title: string; status: string | null; election_id: number | null }

function escapeTerm(s: string): string {
  // ilike 的萬用字元要擋掉，不然使用者打 % 會把整張表撈回來
  return s.replace(/[%_]/g, (m) => `\\${m}`)
}


/** 搜尋頁頁首的輸入框與頁面內容共用同一個字串（頁首在 Navbar，結果在頁面裡） */
export const searchPageTerm = ref('')

/** 全站搜尋的邏輯（找人與找政見）；視窗版（GlobalSearch）與手機搜尋頁（SearchPage）共用，term 由呼叫端提供 */
export function useGlobalSearch(term: Ref<string>) {
  const { getActiveElection, elections } = useSupabase()
  const loading = ref(false)
  const people = ref<PersonHit[]>([])
  const policies = ref<PolicyHit[]>([])
  let timer: ReturnType<typeof setTimeout> | null = null
  let seq = 0
  /** 搜尋視窗網址不變，GA4 內建站內搜尋抓不到，自己送 search 事件（見 lib/search-analytics.ts） */
  const tracker = createSearchTracker()

  /** 政見所屬的那場選舉的投票年份（election_id 是 id、不一定是年份） */
  function electionYearText(electionId: number): string {
    return String(electionYearOfDate(elections.value.find((e) => e.id === electionId)?.electionDate) ?? '')
  }

  const refElection = computed(() => getActiveElection() ?? null)
  const activeYear = computed(() => refElection.value?.id ?? null)
  /**
   * 投票日過了沒？（2026-09-17 問「2027 年沒有選舉時呢」）
   * getActiveElection() 在沒有進行中的選舉時會退回最近一屆，所以 2027 年搜尋拿到的是 2026。
   * 那時候該標的不是「參選中」——選完了，落選的人標成參選中是假的——而是「當選」。
   */
  const voted = computed(() => {
    const d = refElection.value?.electionDate
    return isElectionVoted(d)
  })
  /** 選前看候選人，選後看當選人 */
  const highlightStatuses = computed(() => (voted.value ? ['elected'] : RUNNING_STATUSES))

  /**
   * 排序的第一順位是「現在是不是這個人」，不是位階（2026-09-17 問「當選 現職 高低？」）。
   * 只看位階的話，2022 落選的縣市長會排在現任議員前面——那不是搜尋的人要找的。
   *   第一層：本屆候選人
   *   第二層：現任（最近幾屆當選、任期內）
   *   第三層：其他歷屆紀錄
   * 同一層之內才按職位位階排。
   */
  const recentVotedYears = computed(() => {
    return elections.value
      // 近四年：看投票日的年份，不看 id（新增的選舉 id 不是年份，#344 第二階段 A）
      .filter((e) => isElectionVoted(e.electionDate) && (electionYearOfDate(e.electionDate) ?? 0) >= new Date().getFullYear() - 4)
      .map((e) => e.id)
  })
  const hasResults = computed(() => people.value.length > 0 || policies.value.length > 0)

  /** 這個人這一屆有沒有參選：有就標色，沒有就是歷屆紀錄 */
  function isRunning(p: PersonHit): boolean {
    return !!p.running_type
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
              .select('election_id, election_type, candidacy_status, politicians!inner(id, name, party, region, current_position)')
              .in('election_id', years).in('candidacy_status', [...highlightStatuses.value, 'elected'])
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
        const isThisTerm = row.election_id === year && highlightStatuses.value.includes(row.candidacy_status)
        const isIncumbent = row.candidacy_status === 'elected' && recentVotedYears.value.includes(row.election_id)
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
      tracker.results(q, people.value.length + policies.value.length)
    } catch {
      if (mine === seq) { people.value = []; policies.value = [] }
    } finally {
      if (mine === seq) loading.value = false
    }
  }

  watch(term, (v) => {
    if (timer) clearTimeout(timer)
    const q = v.trim()
    if (q.length === 0) { tracker.cancel(); people.value = []; policies.value = []; loading.value = false; return }
    timer = setTimeout(() => run(q), 220)
  })

  /** 清掉結果與計時（關閉視窗、離開搜尋頁時用） */
  function reset() {
    if (timer) clearTimeout(timer)
    tracker.flush()
    tracker.reset()
    seq++
    people.value = []
    policies.value = []
    loading.value = false
  }

  return { loading, people, policies, hasResults, voted, activeYear, isRunning, electionYearText, tracker, reset }
}
