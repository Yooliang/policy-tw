import { ref } from 'vue'
import { fetchAllRows } from './useSupabase'
import type { PipelineSnapshot, RawPipelineSnapshot } from '../types'

function mapSnapshot(row: RawPipelineSnapshot): PipelineSnapshot {
  return {
    takenAt: row.taken_at,
    tasksOpen: row.tasks_open,
    tasksByType: row.tasks_by_type || {},
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

/** 讀取管線健康度採樣（`pipeline_snapshots`，每 4 小時一筆），依時間升冪排列供圖表使用。 */
export function usePipelineSnapshots() {
  const snapshots = ref<PipelineSnapshot[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchSnapshots(): Promise<void> {
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

  return { snapshots, loading, error, fetchSnapshots }
}
