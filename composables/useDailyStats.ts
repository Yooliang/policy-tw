import { ref } from 'vue'
import { supabasePublic as supabase } from '../lib/supabase'

export interface DailyStats {
  todayCandidates: number
  todayPolicies: number
  todayUpdates: number
  todayTasks: number
  todaySuccessRate: number
  todayCostUSD: number
}

export interface MonthlyTrend {
  month: string
  functionType: string
  requestCount: number
  totalTokens: number
  totalCost: number
}

export interface TaskTypeDistribution {
  taskType: string
  count: number
}

export function useDailyStats() {
  const dailyStats = ref<DailyStats>({
    todayCandidates: 0,
    todayPolicies: 0,
    todayUpdates: 0,
    todayTasks: 0,
    todaySuccessRate: 0,
    todayCostUSD: 0,
  })
  const monthlyTrend = ref<MonthlyTrend[]>([])
  const taskTypeDistribution = ref<TaskTypeDistribution[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  // 聚合在資料庫端做（函式 daily_stats），前端只拿結果；日界線為台灣時間，不傳日期＝台灣的今天
  async function fetchDailyStats(date?: string) {
    loading.value = true
    error.value = null

    try {
      const { data, error: err } = await supabase.rpc('daily_stats', { p_date: date ?? null })
      if (err) throw err
      const row = Array.isArray(data) ? data[0] : data
      const tasks = Number(row?.today_tasks) || 0
      const completed = Number(row?.today_completed) || 0
      dailyStats.value = {
        todayCandidates: Number(row?.today_candidates) || 0,
        todayPolicies: Number(row?.today_policies) || 0,
        todayUpdates: Number(row?.today_updates) || 0,
        todayTasks: tasks,
        todaySuccessRate: tasks > 0 ? Math.round((completed / tasks) * 100) : 0,
        todayCostUSD: Number(row?.today_cost_usd) || 0,
      }
    } catch (err) {
      console.error('[useDailyStats] fetchDailyStats error:', err)
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  async function fetchMonthlyTrend() {
    try {
      const { data, error: err } = await supabase
        .from('ai_usage_stats')
        .select('*')
        .order('month', { ascending: true })

      if (err) throw err

      monthlyTrend.value = (data || []).map(row => ({
        month: row.month,
        functionType: row.function_type,
        requestCount: row.request_count,
        totalTokens: row.total_tokens,
        totalCost: Number(row.total_cost) || 0,
      }))
    } catch (err) {
      console.error('[useDailyStats] fetchMonthlyTrend error:', err)
    }
  }

  async function fetchTaskTypeDistribution(date?: string) {
    try {
      const { data, error: err } = await supabase.rpc('daily_task_type_counts', { p_date: date ?? null })
      if (err) throw err

      taskTypeDistribution.value = (data || []).map((row: { task_type: string; task_count: number | string }) => ({
        taskType: row.task_type,
        count: Number(row.task_count) || 0,
      }))
    } catch (err) {
      console.error('[useDailyStats] fetchTaskTypeDistribution error:', err)
    }
  }

  async function fetchAll(date?: string) {
    await Promise.all([
      fetchDailyStats(date),
      fetchMonthlyTrend(),
      fetchTaskTypeDistribution(date),
    ])
  }

  return {
    dailyStats,
    monthlyTrend,
    taskTypeDistribution,
    loading,
    error,
    fetchDailyStats,
    fetchMonthlyTrend,
    fetchTaskTypeDistribution,
    fetchAll,
  }
}
