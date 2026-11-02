import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useSupabase } from './useSupabase'
import { sectionOfPolicy, sectionOfRoute, type DeskSection } from '../lib/desk-sections'
import { isElectionVoted, stageOfPolicy } from '../lib/policy-stage'

/**
 * 桌面版左欄目前所在的區塊與（承諾頁時）所屬的那一屆選舉。
 * 大多數頁面照路由名稱歸區（lib/desk-sections.ts）；政見詳情頁看那一條的資料：
 * 選前的承諾（屬於某一屆）歸「選舉」，延伸欄跟著顯示那一屆。
 */
export function useDeskSection() {
  const route = useRoute()
  const { policies, politicians, getElectionById } = useSupabase()
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
  const section = computed<DeskSection | null>(() => (pledgeElection.value ? 'election' : sectionOfRoute(route.name)))
  return { section, pledgeElection }
}
