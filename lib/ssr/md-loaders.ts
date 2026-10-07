import { supabasePublic } from '../supabase'
import { mapPolicy, mapPolitician } from '../../composables/useSupabase'
import type { Election, Policy, Politician, RawPolicy, RawPolitician } from '../../types'
import { fetchAllPages } from '../fetch-all-pages'
import { positionsToLoad } from '../election-levels'
import { SPECIAL_MUNICIPALITIES, TAIWAN_COUNTIES } from '../election-regions'
import { isRunningCandidate } from '../candidate-status'
import { loadBase } from './loaders'
import type { PoliticianMdInput } from '../md/politician'
import { regionCandidatesKey, type Corpus, type RegionCandidates } from '../md/dataset'

/**
 * Markdown 檢視的資料載入（docs/PLAN-markdown-views.md 5b）。兩種用法：
 *   - 人物：Worker 讀時產生，兩個查詢（人物一列＋名下政見）＋基礎資料（選舉，isolate 快取 10 分鐘）
 *   - 其餘（縣市、分類、縣市×分類／主題、矩陣）：排程腳本（scripts/build-data-md.ts）一次撈整份 Corpus，預產進 data_md_cache；Worker 不碰
 * 全部只用 anon。每個查詢都有界（query-bounds）：分頁撈到底、單頁 1000 列。
 */

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 台北今天（YYYY-MM-DD） */
export function taipeiToday(now = Date.now()): string {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

export type PersonLoad =
  | { kind: 'ok'; input: PoliticianMdInput }
  | { kind: 'merged'; into: string }
  | { kind: 'notfound' }

/** 人物 .md 的資料：查無、已合併到別人（301）、或整份輸入 */
export async function loadPoliticianMd(id: string): Promise<PersonLoad> {
  if (!ID_RE.test(id)) return { kind: 'notfound' }
  const base = await loadBase()
  // query-bounds: ok — 主鍵查一列
  const { data, error } = await supabasePublic.from('politicians_with_elections').select('*').eq('id', id).limit(1)
  if (error) throw new Error(`politicians_with_elections: ${error.message}`)
  const row = ((data ?? []) as RawPolitician[])[0]
  if (!row) return { kind: 'notfound' }
  if (row.merged_into) return { kind: 'merged', into: String(row.merged_into) }
  // query-bounds: ok — 一個人的政見最多幾十筆
  const res = await supabasePublic.from('policies_with_logs').select('*').eq('politician_id', id).is('removed_at', null).order('id').limit(1000)
  if (res.error) throw new Error(`policies_with_logs by politician: ${res.error.message}`)
  const policies = ((res.data ?? []) as RawPolicy[]).filter((r) => !r.removed_at).map(mapPolicy)
  return { kind: 'ok', input: { politician: mapPolitician(row), policies, elections: base.elections, today: taipeiToday(), generatedAt: Date.now() } }
}

/** 預產用：撈整份資料。失敗就丟出（腳本整個不寫，不留一半的快取） */
export async function loadCorpus(log: (s: string) => void = () => undefined): Promise<Corpus> {
  const base = await loadBase()
  const elections: Election[] = base.elections

  const peopleRes = await fetchAllPages<RawPolitician>('有政見的人物', (from, to) =>
    supabasePublic.from('politicians_with_policies').select('*').order('id').range(from, to))
  const people: Politician[] = peopleRes.rows.filter((r) => !r.merged_into).map(mapPolitician)

  const policyRes = await fetchAllPages<RawPolicy>('政見', (from, to) =>
    supabasePublic.from('policies_with_logs').select('*').is('removed_at', null).order('id').range(from, to))
  const policies: Policy[] = policyRes.rows.filter((r) => !r.removed_at).map(mapPolicy)
  log(`人物 ${people.length}、政見 ${policies.length}`)
  if (peopleRes.truncated || policyRes.truncated) throw new Error('人物或政見撈取不完整，不產生快取')

  // 各縣市、各屆的候選人（縣市頁那一層與下一層的職位，跟 ElectionPage 同一份職位表）
  const regionCandidates = new Map<string, RegionCandidates>()
  const jobs: Array<{ e: Election; region: string; types: string[] }> = []
  for (const e of elections) {
    for (const region of TAIWAN_COUNTIES) {
      const isSpecial = (SPECIAL_MUNICIPALITIES as readonly string[]).includes(region)
      const types = positionsToLoad({ region, subRegion: 'All', isSpecialMunicipality: isSpecial }).filter((t) => e.types.map(String).includes(t))
      if (types.length > 0) jobs.push({ e, region, types })
    }
  }
  let next = 0
  const worker = async () => {
    for (;;) {
      const job = jobs[next++]
      if (!job) return
      const got = await fetchAllPages<RawPolitician>(`參選人 ${job.e.id}/${job.region}`, (from, to) =>
        supabasePublic.rpc('get_politicians_by_level', { p_election_id: job.e.id, p_region: job.region, p_sub_region: null, p_election_types: job.types })
          .order('id').range(from, to))
      const candidates = got.rows.filter((r) => !r.merged_into).map(mapPolitician)
        .filter((p) => (p.elections ?? []).some((x) => x.electionId === job.e.id && isRunningCandidate(x.candidacyStatus)))
      regionCandidates.set(regionCandidatesKey(job.e.id, job.region), { candidates, truncated: got.truncated })
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  log(`縣市候選人 ${regionCandidates.size} 組`)
  return { elections, people, policies, regionCandidates, today: taipeiToday() }
}
