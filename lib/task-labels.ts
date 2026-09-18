/**
 * 任務型別的中文名稱，任務看板與其他頁面共用這一份。
 *
 * 2026-09-15 看任務頁（現 /tasks）：election_result_missing、policy_election_missing、
 * roster_check、policy_validity 直接把英文代號印在畫面上——新增任務型別時沒人記得補這張表。
 * supabase/functions/_shared/protocol-guard.test.ts 會檢查後端每一種任務型別這裡都有名稱，漏了就紅。
 */
export const TASK_TYPE_LABEL: Readonly<Record<string, string>> = {
  policy_missing: '缺政見',
  profile_gap: '缺人物資料',
  policy_source_missing: '政見缺出處',
  progress_stale: '進度停滯',
  candidacy_source_missing: '參選缺出處',
  election_result_missing: '缺選舉結果',
  policy_election_missing: '政見缺屆別',
  roster_check: '名單清查',
  candidate_status_stale: '參選狀態待確認',
  news_sweep: '掃新聞',
  policy_validity: '疑似不是政見',
  question: '公民提問',
  audit: '文件核對',
  adjudicate: '裁決',
  fix_disputed: '修正被擋的貢獻',
  other: '其他',
}

/** 查不到名稱時不要把代號丟給使用者看；代號留給 console */
export function taskTypeLabel(type: string): string {
  const label = TASK_TYPE_LABEL[type]
  if (label) return label
  console.info('[任務看板] 沒有中文名稱的任務型別：', type)
  return '其他'
}
