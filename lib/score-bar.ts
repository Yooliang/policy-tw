/**
 * 分數拉鋸條（components/ScoreBar.vue）的算法：貢獻看板與查核履歷共用。
 * 左端 −目標＝退件、右端 ＋目標＝通過，標記在現在的分數。
 */

/** 標記在條上的位置：0～100 的百分比（−目標→0、0→50、＋目標→100；超出範圍夾在兩端） */
export function scorePercent(score: number | null | undefined, target: number | null | undefined): number {
  const t = Math.max(1, target ?? 1)
  const s = Math.max(-t, Math.min(t, score ?? 0))
  return Math.round(((s + t) / (2 * t)) * 100)
}

/** 滑過去看到的說明：分數與兩端門檻，有票數就附上 */
export function scoreBarTitle(score: number, target: number, votes?: { agree?: number; disagree?: number; unsure?: number }): string {
  const base = `分數 ${score}／通過 ${target}、退件 −${target}`
  if (!votes || votes.agree === undefined || votes.disagree === undefined || votes.unsure === undefined) return base
  return `${base}（同意 ${votes.agree}・反對 ${votes.disagree}・存疑 ${votes.unsure}）`
}
