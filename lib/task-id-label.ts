/**
 * 貢獻看板每一筆底下的「任務編號」改成人看得懂的標籤（2026-10-08，維護者，#475）。
 *
 * 原本直接印 `auto:profile_detail_gap:sources:<uuid>`，讀者看不出是什麼任務。task_id 的長相：
 * - `auto:<任務型別>[:<子類>]:<那一列的 id>`：自動缺口。型別名稱沿用 task-labels.ts 的 TASK_TYPE_LABEL（不另做一份）；
 *   有子類的（同一個型別底下做的事不一樣）先查下面的 TASK_KIND_LABEL，查不到就退回型別名稱
 * - `verify:…`：驗證
 * - 單純一個 uuid：維護者或網站請求建的手動任務
 * - 其他看不懂的：原字串照印，不顯示空白（也不丟給使用者一個猜出來的名字）
 * 原始編號由畫面放進 title，要追查時還找得到。
 */
import { TASK_TYPE_LABEL } from './task-labels.ts'

/** 有子類的自動缺口：`<型別>:<子類>` → 名稱（從派工 SQL 的 task_id 組法整理；新增子類時補這裡） */
export const TASK_KIND_LABEL: Readonly<Record<string, string>> = {
  'profile_detail_gap:sources': '補學經歷出處',
  'candidacy_source_missing:party': '補參選政黨',
  'candidacy_source_missing:cand_no': '補號次',
  'candidacy_source_missing:cand_no_recheck': '號次核對',
  'not_running_recheck:filing': '登記後退選核對',
  'election_result_missing:cec': '補選舉結果（照中選會名冊）',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 任務編號 → 中文標籤；對不上的類型回傳原字串（空值回傳空字串，由呼叫端決定不畫） */
export function taskIdLabel(taskId: string | null | undefined): string {
  const id = (taskId ?? '').trim()
  if (!id) return ''
  if (id.startsWith('verify:')) return '驗證'
  if (UUID_RE.test(id)) return '手動任務'
  if (id.startsWith('auto:')) {
    const parts = id.split(':')
    const type = parts[1] ?? ''
    // 子類緊接在型別後面（id 是 uuid 或整數，不會撞上子類名稱）
    const sub = Object.prototype.hasOwnProperty.call(TASK_KIND_LABEL, `${type}:${parts[2]}`) ? TASK_KIND_LABEL[`${type}:${parts[2]}`] : undefined
    if (sub) return sub
    const label = Object.prototype.hasOwnProperty.call(TASK_TYPE_LABEL, type) ? TASK_TYPE_LABEL[type] : undefined
    if (label) return label
  }
  return id
}
