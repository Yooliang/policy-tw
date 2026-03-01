import { ref } from 'vue'
import { supabase } from '../lib/supabase'

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

  // Get date range for a given date (start of day to end of day in UTC)
  function getDayRange(dateStr: string) {
    const start = `${dateStr}T00:00:00+08:00`
    const end = `${dateStr}T23:59:59+08:00`
    return { start, end }
  }

  async function fetchDailyStats(date?: string) {
    const targetDate = date || new Date().toISOString().slice(0, 10)
    const { start, end } = getDayRange(targetDate)

    loading.value = true
    error.value = null

    try {
      const [
        candidatesRes,
        policiesRes,
        updatesRes,
        tasksRes,
        costRes,
      ] = await Promise.all([
        // 今日新增候選人數
        supabase
          .from('politicians')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', start)
          .lte('created_at', end),

        // 今日新增政見數
        supabase
          .from('policies')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', start)
          .lte('created_at', end),

        // 今日更新資料筆數 (politician_update tasks)
        supabase
          .from('ai_prompts')
          .select('*', { count: 'exact', head: true })
          .eq('task_type', 'politician_update')
          .eq('status', 'completed')
          .gte('completed_at', start)
          .lte('completed_at', end),

        // 今日所有任務（按 status 分組用）
        supabase
          .from('ai_prompts')
          .select('status')
          .gte('created_at', start)
          .lte('created_at', end),

        // 今日 API 花費
        supabase
          .from('ai_prompts')
          .select('result_data')
          .eq('status', 'completed')
          .gte('completed_at', start)
          .lte('completed_at', end)
          .not('result_data', 'is', null),
      ])

      // Calculate stats
      dailyStats.value.todayCandidates = candidatesRes.count || 0
      dailyStats.value.todayPolicies = policiesRes.count || 0
      dailyStats.value.todayUpdates = updatesRes.count || 0

      // Task count and success rate
      const tasks = tasksRes.data || []
      dailyStats.value.todayTasks = tasks.length
      if (tasks.length > 0) {
        const completed = tasks.filter(t => t.status === 'completed').length
        dailyStats.value.todaySuccessRate = Math.round((completed / tasks.length) * 100)
      } else {
        dailyStats.value.todaySuccessRate = 0
      }

      // API cost (sum total_cost_usd from result_data.usage)
      const costData = costRes.data || []
      dailyStats.value.todayCostUSD = costData.reduce((sum, row) => {
        const cost = row.result_data?.usage?.total_cost_usd
        return sum + (typeof cost === 'number' ? cost : 0)
      }, 0)
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
    const targetDate = date || new Date().toISOString().slice(0, 10)
    const { start, end } = getDayRange(targetDate)

    try {
      const { data, error: err } = await supabase
        .from('ai_prompts')
        .select('task_type')
        .gte('created_at', start)
        .lte('created_at', end)

      if (err) throw err

      // Group by task_type
      const counts: Record<string, number> = {}
      for (const row of data || []) {
        const type = row.task_type || 'unknown'
        counts[type] = (counts[type] || 0) + 1
      }

      taskTypeDistribution.value = Object.entries(counts)
        .map(([taskType, count]) => ({ taskType, count }))
        .sort((a, b) => b.count - a.count)
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
