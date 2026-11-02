import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useSupabase } from './useSupabase'
import type { DeskGroup } from '../lib/desk-nav-types'
import { sectionOfPolicy, sectionOfRoute, type DeskSection } from '../lib/desk-sections'
import { levelCountyLinkGroups, pledgeLevelRegion } from '../lib/desk-level-groups'
import { segmentOfId } from '../lib/election-route'
import { isElectionVoted, stageOfPolicy } from '../lib/policy-stage'

/**
 * 桌面版左欄目前所在的區塊與（承諾頁時）所屬的那一屆選舉。
 * 大多數頁面照路由名稱歸區（lib/desk-sections.ts）；政見詳情頁看那一條的資料：
 * 選前的承諾（屬於某一屆）歸「選舉」，延伸欄跟著顯示那一屆。
 */
export function useDeskSection() {
  const route = useRoute()
  const { policies, politicians, elections, getElectionById } = useSupabase()
  const pledgeElection = computed(() => {
    if (route.name !== 'policy') return undefined
    const p = policies.value.find(x => String(x.id) === String(route.params.policyId))
    if (!p || typeof p.electionId !== 'number') return undefined
    const election = getElectionById(p.electionId)
    const politician = politicians.value.find(c => String(c.id) === String(p.politicianId))
    // 已投票的屆要看提出者有沒有當選才分得出承諾／政見；人物還沒載入時先維持原狀，免得畫面先跳一下
    if (!politician && isElectionVoted(election?.electionDate)) return undefined
    const stage = stageOfPolicy(p, politician, id => getElectionById(id)?.electionDate)
    return sectionOfPolicy(stage, p.electionId) === 'election' ? election : undefined
  })
  /**
   * 承諾頁延伸欄的「層級」「縣市」兩組（跟人物頁、選舉頁同一份清單）：
   * 從提出者在該屆的參選紀錄推出層級與縣市，沒有參選紀錄才退回承諾自己的縣市；點了到該屆選舉頁對應的分頁／縣市。
   */
  const pledgeLevelGroups = computed<DeskGroup[]>(() => {
    const election = pledgeElection.value
    if (!election) return []
    const p = policies.value.find(x => String(x.id) === String(route.params.policyId))
    const politician = politicians.value.find(c => String(c.id) === String(p?.politicianId))
    const { type, county } = pledgeLevelRegion(politician?.elections, election.id, p?.lineage?.region)
    return levelCountyLinkGroups(segmentOfId(elections.value, election.id), type, county)
  })
  const section = computed<DeskSection | null>(() => (pledgeElection.value ? 'election' : sectionOfRoute(route.name)))
  return { section, pledgeElection, pledgeLevelGroups }
}
