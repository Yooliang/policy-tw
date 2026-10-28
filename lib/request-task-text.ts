/**
 * 「請 AI 幫忙查」結果的型別與文字（不碰 import.meta.env，Deno 測試可直接載入）。
 */

export interface RequestTaskResult {
  status: 'queued' | 'already_queued' | 'recently_checked'
  /** recently_checked 沒有建任務，所以沒有 task_id */
  task_id?: string
  queue_position: number
  open_tasks: number
  board_url: string
  message: string
  /** recently_checked：最近一次處理的時間（ISO）與結果（no_change＝查過沒有新資料；updated＝有人交了資料；closed＝任務已結束） */
  checked_at?: string
  outcome?: 'no_change' | 'updated' | 'closed'
  window_days?: number
}

/** 按鈕上的字（送出後）：已排入／已在任務池中／近期已查過 */
export function requestTaskDoneLabel(r: RequestTaskResult): string {
  if (r.status === 'recently_checked') return '近期已查過'
  return r.status === 'already_queued' ? '已在任務池中' : '已排入任務池'
}

/** 成功框的標題：近期已查過時不能說「已交給 AI 代理」（沒有建新任務） */
export function requestTaskHeading(r: RequestTaskResult): string {
  return r.status === 'recently_checked' ? '近期已查過' : '已交給 AI 代理'
}

/** 近期已查過的一句話：「10/27 已查過（查無新資料），5 天內不重複查」 */
function recentMessage(r: RequestTaskResult): string {
  const d = r.checked_at ? new Date(r.checked_at) : null
  const when = d && !Number.isNaN(d.getTime()) ? `${d.getMonth() + 1}/${d.getDate()} ` : ''
  const what = r.outcome === 'no_change' ? '已查過（查無新資料）' : r.outcome === 'updated' ? '已有人處理並交出資料' : '已處理完'
  return `${when}${what}，${r.window_days ?? 5} 天內不重複查`
}

/** 成功／已存在／近期已查過的一句話 */
export function requestTaskMessage(r: RequestTaskResult): string {
  if (r.status === 'recently_checked') return recentMessage(r)
  return r.status === 'already_queued'
    ? `這個項目已在任務池中，AI 代理會來查；目前有 ${r.queue_position} 件任務排隊`
    : `已加入任務池，AI 代理會來查；目前有 ${r.queue_position} 件任務排隊`
}
