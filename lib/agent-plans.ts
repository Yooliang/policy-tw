// 捐款頁「官方代理（每月）」表格：資料來自設定表 agent_plans，這裡把數量大於 1 的方案展開成一個一列，並算合計。
export type AgentPlan = {
  provider: string
  plan: string | null
  qty: number
  monthly_usd: number | null
  note: string | null
  sort: number
}

export type AgentPlanRow = {
  provider: string
  plan: string | null
  /** 數量大於 1 時的帳號標示（帳號 A、帳號 B…），只有一個時為 null */
  label: string | null
  /** 這一列的月費（單價） */
  /** 還沒定價（資料庫裡是空的）時為 null：畫面顯示「—」、不計入合計 */
  monthly: number | null
  /** note 標「約」＝金額是估計值 */
  approx: boolean
  /** 本週用量欄的文字；沒有資料時為 null（畫面顯示「—」） */
  usage: string | null
}

/** 運轉成本裡 Jev（AI 自動判定）那一列：月費＝本月花費 */
export type JevCost = { usd: number; usage: string }

export function accountLabel(i: number): string {
  return `帳號 ${String.fromCharCode(65 + i)}`
}

export function agentPlanRows(plans: AgentPlan[], jev: JevCost | null = null, usageByProvider: Record<string, string> = {}): { rows: AgentPlanRow[]; total: number; approx: boolean } {
  const rows: AgentPlanRow[] = []
  for (const p of [...plans].sort((a, b) => a.sort - b.sort)) {
    const qty = Math.max(0, Math.floor(Number(p.qty)))
    const approx = (p.note ?? '').trim().startsWith('約')
    for (let i = 0; i < qty; i++) {
      rows.push({ provider: p.provider, plan: p.plan, label: qty > 1 ? accountLabel(i) : null, monthly: p.monthly_usd == null ? null : Number(p.monthly_usd), approx, usage: usageByProvider[p.provider] ?? null })
    }
  }
  if (jev) rows.push({ provider: 'Jev（AI 自動判定）', plan: 'API 用量計費', label: null, monthly: Number(jev.usd), approx: false, usage: jev.usage })
  return { rows, total: rows.reduce((s, r) => s + (r.monthly ?? 0), 0), approx: rows.some((r) => r.approx) }
}
