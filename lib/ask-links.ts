/**
 * 使用者發起的「請 AI 幫忙查」一律走公民提問流程：跳到 /community、問題已經先填好，
 * 使用者可以改也可以直接送出。唯一一份，四個按鈕共用。
 *
 * 2026-09-13 小良哥拍板：「使用者在介面上按下的任務，統一進公民提問那邊，作法也都統一
 * 跟「這不是政見？回報給 AI 查證」按鈕一樣，先跳轉 填文字 就好／像是 查政見 查簡介
 * 都一樣的作法」，並且「型別保留」。
 *
 * 為什麼不是一鍵直接建任務（改之前的 request-task 端點）：
 *   1. 那樣建出來的任務是零脈絡的「補 X 的政見（網站訪客請求）」，代理不知道使用者
 *      到底想知道什麼；走提問流程，使用者那句話會跟著任務一起交給代理。
 *   2. 公民提問有表態（stance_up／stance_down），那是「有人也想知道」的公開訊號，
 *      也是派工排序的依據（見 dispatch.ts 的 sortQuestionTasksBySupport）。
 *   3. 答案會公開列在那一題下面，其他讀者看得到。
 *
 * 「型別保留」的意思是：任務型別仍然由 kind 決定（見 _shared/ask.ts 的 ASK_KINDS），
 * 所以代理產出的是一筆資料變更（政見進度／移除／新增政見／補人物欄位），
 * 不是只有一段貼在提問下面的文字。
 */

export const ASK_LINK_KINDS = ['policy_validity', 'policy_progress', 'policy_missing', 'profile_gap'] as const

export type AskLinkKind = (typeof ASK_LINK_KINDS)[number]

/** 問題長度 DB 限 8～300 字，這裡只需要防上限 */
const MAX_QUESTION = 300

export interface AskLinkTarget {
  path: string
  query: Record<string, string>
}

function build(kind: AskLinkKind, question: string, ids: { policyId?: string; politicianId?: string }): AskLinkTarget {
  const query: Record<string, string> = { kind, q: question.slice(0, MAX_QUESTION) }
  if (ids.policyId) query.policy = ids.policyId
  if (ids.politicianId) query.politician = ids.politicianId
  return { path: '/community', query }
}

/** 政見頁「這不是政見？」：查證後移除、改分類，或確認其實是有效的承諾 */
export function askNotAPolicy(policyId: string, title: string): AskLinkTarget {
  return build(
    'policy_validity',
    `「${title}」這筆看起來不像政見（比較像個人表態、行程或活動紀錄）。請查證原始出處後判斷：它應該被移除、改分類，還是其實是有效的承諾？`,
    { policyId },
  )
}

/**
 * 政見頁的查證按鈕。競選承諾問的是「兌現了沒有」，施政中的問「進度到哪」——
 * 兩種問法對應同一個任務型別（progress_stale），但使用者看到的句子要對得上狀態。
 */
export function askPolicyProgress(policyId: string, title: string, isCampaignPledge: boolean): AskLinkTarget {
  const question = isCampaignPledge
    ? `「${title}」這項競選承諾後來有沒有兌現？請查當選之後的執行情形，並附上出處。`
    : `「${title}」目前的進度到哪裡了？請查最近的進展，並附上出處。`
  return build('policy_progress', question, { policyId })
}

/** 人物頁「查政見」 */
export function askPoliticianPolicies(politicianId: string, name: string): AskLinkTarget {
  return build(
    'policy_missing',
    `網站上查不到${name}的政見。可以幫忙找出他有出處的具體政見嗎？`,
    { politicianId },
  )
}

/** 人物頁「查簡介」 */
export function askPoliticianProfile(politicianId: string, name: string): AskLinkTarget {
  return build(
    'profile_gap',
    `${name}的基本資料不齊（出生年、現職或官方照片）。可以幫忙補上查得到的部分嗎？`,
    { politicianId },
  )
}
