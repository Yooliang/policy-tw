/**
 * 政見三要素（數值目標・達成期限・財源）的顯示規則（#364，2026-10-05；與日本站 keifu 同一套）。
 *
 * 資料在 policy_elements（一個要素一列），由視圖 policies_with_logs.elements 帶到前端。這支檔案只管
 * 「怎麼讀」，核心只有一個分別，畫面與 API 都不能混用：
 *   - 陣列裡**沒有**這個要素 → 未調查（還沒有人查過原文）
 *   - 有、而 stated=false   → 未說明（查過原文、他沒寫）
 *   - 有、而 stated=true    → 照原文寫的事實
 * 正見是第三方：不補數字、不換算、不評價。
 *
 * 「期限已到」的條件跟派工臂 contribution_auto_tasks_deadline_due（migration 20261005005640）同一套，
 * 改一邊要改另一邊。
 *
 * 零執行期依賴（只有型別），能被 deno 直接測。
 */
import type { Policy, PolicyElement, PolicyElementKind, PolicyElementSource, RawPolicyElement } from '../types'

export const ELEMENT_KINDS: readonly PolicyElementKind[] = ['target', 'deadline', 'funding']

export const ELEMENT_LABEL: Readonly<Record<PolicyElementKind, string>> = {
  target: '數值目標',
  deadline: '達成期限',
  funding: '財源',
}

/** 有列而 stated=false：查過原文、沒寫 */
export const NOT_STATED_LABEL = '未說明'
/** 沒有列：還沒有人查過 */
export const UNCHECKED_LABEL = '未調查'

/** 給讀者看的一句說明：兩種「沒有內容」各是什麼意思 */
export const ELEMENTS_EXPLAINER = '照原文拆成數值目標、達成期限、財源三項。「未說明」是查過原文、沒有寫；「未調查」是還沒有人查過原文。只記原文寫了什麼，不補數字、不換算、不評價。'

export type ElementState = 'stated' | 'not_stated' | 'unchecked'

export interface ElementCell {
  kind: PolicyElementKind
  label: string
  state: ElementState
  /** 只有 stated 才有 */
  text: string | null
  deadlineDate: string | null
  sourceLocator: string | null
  source: PolicyElementSource | null
}

const isKind = (v: unknown): v is PolicyElementKind => v === 'target' || v === 'deadline' || v === 'funding'

/** 視圖的一列 → 前端型別。認不得的要素丟掉（不讓它冒充三個之一） */
export function mapPolicyElements(rows: readonly RawPolicyElement[] | null | undefined): PolicyElement[] | undefined {
  if (!Array.isArray(rows)) return undefined
  return rows.filter((r) => isKind(r?.element)).map((r) => {
    const stated = r.stated === true
    const src = r.source && typeof r.source.url === 'string' && r.source.url
      ? { url: r.source.url, title: r.source.title ?? null, publisher: r.source.publisher ?? null, kind: r.source.kind ?? null, archiveUrl: r.source.archive_url ?? null }
      : (r.source_url ? { url: r.source_url } : null)
    return {
      element: r.element as PolicyElementKind,
      stated,
      text: stated && typeof r.text === 'string' && r.text.trim() ? r.text.trim() : null,
      deadlineDate: stated && r.element === 'deadline' && typeof r.deadline_date === 'string' ? r.deadline_date.slice(0, 10) : null,
      sourceLocator: typeof r.source_locator === 'string' && r.source_locator.trim() ? r.source_locator.trim() : null,
      source: src,
    }
  })
}

/** 三個要素各一格，順序固定（數值目標、達成期限、財源）。沒有那一列＝未調查 */
export function elementCells(elements: readonly PolicyElement[] | null | undefined): ElementCell[] {
  return ELEMENT_KINDS.map((kind) => {
    const row = (elements ?? []).find((e) => e.element === kind)
    if (!row) return { kind, label: ELEMENT_LABEL[kind], state: 'unchecked', text: null, deadlineDate: null, sourceLocator: null, source: null }
    // 有列但沒有文字的 stated=true（資料庫擋得住，這裡防舊快照）當成未說明，不要印出空白冒充有內容
    const stated = row.stated && !!row.text
    return {
      kind,
      label: ELEMENT_LABEL[kind],
      state: stated ? 'stated' : 'not_stated',
      text: stated ? row.text : null,
      deadlineDate: stated ? row.deadlineDate : null,
      sourceLocator: row.sourceLocator,
      source: row.source,
    }
  })
}

/** 格子裡寫的字：有寫就是原文，沒寫是「未說明」，沒查是「未調查」 */
export function cellText(cell: ElementCell): string {
  if (cell.state === 'stated') return cell.text ?? ''
  return cell.state === 'not_stated' ? NOT_STATED_LABEL : UNCHECKED_LABEL
}

/** 這條政見三個要素有沒有任何一個查過（全部未調查時頁面可以縮成一行） */
export function anyChecked(elements: readonly PolicyElement[] | null | undefined): boolean {
  return elementCells(elements).some((c) => c.state !== 'unchecked')
}

// ── 期限已到 ─────────────────────────────────────────────────────────────

export interface DueContext {
  /** 今天（台北日期，YYYY-MM-DD） */
  today: string
  /** 這條政見所屬那場選舉的投票日；沒有屆別或查不到回 undefined */
  electionDateOf: (policy: Policy) => string | undefined
  /** 提出者在那場選舉的結果（elected／not_elected／withdrawn）；不知道回 undefined */
  electionResultOf: (policy: Policy) => string | undefined
}

export interface DuePolicy {
  policy: Policy
  deadlineDate: string
  deadlineText: string
  /** 期限過了幾天 */
  daysOver: number
}

const FINAL_STATUSES = ['Achieved', 'Failed']

/**
 * 期限已到、還沒有後續（跟派工臂 deadline_due 同一套條件）：
 *   原文寫了達成期限而且換得成日期、日期早於今天；政見還沒達成也沒跳票；期限「之後」沒有任何進度紀錄；
 *   競選承諾要等那場選舉投完票；落選、退選者的承諾不算。
 */
export function deadlineDue(policy: Policy, ctx: DueContext): DuePolicy | null {
  const deadline = elementCells(policy.elements).find((c) => c.kind === 'deadline')
  if (!deadline || deadline.state !== 'stated' || !deadline.deadlineDate) return null
  const d = deadline.deadlineDate
  if (!(d < ctx.today)) return null
  if (FINAL_STATUSES.includes(String(policy.status))) return null
  if ((policy.logs ?? []).some((l) => typeof l.date === 'string' && l.date.slice(0, 10) > d)) return null
  if (policy.status === 'Campaign Pledge') {
    const vote = ctx.electionDateOf(policy)
    if (!vote || !(vote < ctx.today)) return null
  }
  const result = ctx.electionResultOf(policy)
  if (result === 'not_elected' || result === 'withdrawn') return null
  const daysOver = Math.round((Date.parse(`${ctx.today}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86_400_000)
  return { policy, deadlineDate: d, deadlineText: deadline.text ?? '', daysOver }
}

/** 期限已到的政見，期限早的排前面（同一天照標題） */
export function dueDeadlinePolicies(policies: readonly Policy[], ctx: DueContext): DuePolicy[] {
  return policies
    .map((p) => deadlineDue(p, ctx))
    .filter((x): x is DuePolicy => x !== null)
    .sort((a, b) => a.deadlineDate.localeCompare(b.deadlineDate) || a.policy.title.localeCompare(b.policy.title, 'zh-Hant-TW'))
}

/** 出處連結上顯示的字：標題 → 發布者 → 網域 */
export function sourceLabel(source: PolicyElementSource | null | undefined): string {
  if (!source) return ''
  if (source.title) return source.title
  if (source.publisher) return source.publisher
  try { return new URL(source.url).hostname.replace(/^www\./, '') } catch { return source.url }
}
