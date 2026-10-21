// 捐款頁「官方代理（每月）」表格：資料來自設定表 agent_plans，這裡只做小計與合計。
export type AgentPlan = {
  provider: string
  plan: string
  qty: number
  monthly_usd: number
  note: string | null
  sort: number
}

export type AgentPlanRow = {
  provider: string
  plan: string
  qty: number
  subtotal: number
  /** note 標「約」＝金額是估計值 */
  approx: boolean
}

export function agentPlanRows(plans: AgentPlan[]): { rows: AgentPlanRow[]; total: number; approx: boolean } {
  const rows = [...plans]
    .sort((a, b) => a.sort - b.sort)
    .map((p) => ({
      provider: p.provider,
      plan: p.plan,
      qty: Number(p.qty),
      subtotal: Number(p.qty) * Number(p.monthly_usd),
      approx: (p.note ?? '').trim().startsWith('約'),
    }))
  return { rows, total: rows.reduce((s, r) => s + r.subtotal, 0), approx: rows.some((r) => r.approx) }
}
