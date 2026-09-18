import { ref } from 'vue'
import { fetchAllRows } from './useSupabase'
import type { PipelineSnapshot, RawPipelineSnapshot } from '../types'

import { MANUAL_TASKS_KEY } from '../lib/gap-ranking'

/** tasks_by_type 把手動任務也放在裡面（鍵 manual_open），算資料缺口時要扣掉 */
export { MANUAL_TASKS_KEY }

function mapSnapshot(row: RawPipelineSnapshot): PipelineSnapshot {
  const byType = row.tasks_by_type || {}
  const manualOpen = Number(byType[MANUAL_TASKS_KEY] ?? 0)
  return {
    takenAt: row.taken_at,
    tasksOpen: row.tasks_open,
    tasksByType: byType,
    gapsOpen: Object.entries(byType).filter(([k]) => k !== MANUAL_TASKS_KEY).reduce((a, [, v]) => a + Number(v ?? 0), 0),
    manualOpen,
    pending: row.pending,
    applied: row.applied,
    disputed: row.disputed,
    rejected: row.rejected,
    votesTotal: row.votes_total,
    voters: row.voters,
    policies: row.policies,
    politicians: row.politicians,
    questions: row.questions,
  }
}

// 模組級共用：統計頁有三張圖（運作狀態、資料缺口、缺口走勢）讀同一份採樣。
// 各自撈的話是同一張表全撈三次，而且三張圖拿到的「最新一筆」可能不是同一筆——
// 資料缺口圓餅與缺口走勢就是靠同一筆最新採樣排出前 5 名，顏色才對得上。
const snapshots = ref<PipelineSnapshot[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
let inflight: Promise<void> | null = null

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const rows = await fetchAllRows<RawPipelineSnapshot>('pipeline_snapshots', '*', 'taken_at')
    snapshots.value = rows.map(mapSnapshot)
  } catch (err) {
    console.error('[usePipelineSnapshots] fetchSnapshots error:', err)
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

/** 讀取管線健康度採樣（`pipeline_snapshots`，每小時一筆），依時間升冪排列供圖表使用。 */
export function usePipelineSnapshots() {
  // 同一時間多個元件呼叫只打一次（統計頁三張圖一起掛上時）；之後再呼叫會重撈，拿到最新採樣
  function fetchSnapshots(): Promise<void> {
    if (inflight) return inflight
    inflight = load().finally(() => { inflight = null })
    return inflight
  }
  return { snapshots, loading, error, fetchSnapshots }
}
