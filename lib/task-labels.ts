/**
 * 任務型別的中文名稱，任務看板與其他頁面共用這一份。
 *
 * 2026-09-15 看任務頁（現 /tasks）：election_result_missing、policy_election_missing、
 * roster_check、policy_validity 直接把英文代號印在畫面上——新增任務型別時沒人記得補這張表。
 * supabase/functions/_shared/protocol-guard.test.ts 會檢查後端每一種任務型別這裡都有名稱，漏了就紅。
 */
export const TASK_TYPE_LABEL: Readonly<Record<string, string>> = {
  policy_missing: '缺政見',
  term_policy_missing: '補該屆政見', // 2026-10-06 起也派給落選人、村里長、代表（照公報補），不只現任
  profile_detail_gap: '補學經歷條列',
  profile_gap: '缺人物資料',
  policy_source_missing: '政見缺出處',
  source_mismatch: '來源不支持內容',
  progress_stale: '進度停滯',
  // 2026-10-05 起這個型別也派「補縣市／補選區／補鄉鎮」（缺什麼看任務說明），名稱不再只講出處
  candidacy_source_missing: '參選紀錄待補',
  election_result_missing: '缺選舉結果',
  // 2026-10-06：一個單位（屆別×選舉×縣市或鄉鎮）的結果一次補
  election_results_missing: '整批補選舉結果',
  // 2026-10-06：同名人物接錯，參選紀錄疑似掛在別人身上
  candidacy_owner_mismatch: '參選紀錄疑似掛錯人',
  policy_election_missing: '政見缺屆別',
  policy_election_mismatch: '政見屆別對不上',
  roster_check: '名單清查',
  district_seats_missing: '補應選名額',
  candidate_status_stale: '參選狀態待確認',
  news_sweep: '掃新聞',
  policy_validity: '疑似不是政見',
  question: '公民提問',
  audit: '文件核對',
  adjudicate: '裁決',
  fix_disputed: '修正被擋的貢獻',
  duplicate_politician: '同名人物確認',
  duplicate_policy: '政見重複清查',
  not_running_recheck: '不參選待核對',
  legacy_audit: '早期匯入核對',
  // 政見三要素（#364，2026-10-05）
  policy_elements_missing: '拆政見三要素',
  deadline_due: '期限到了查進度',
  // 政策脈絡（#349，2026-10-06）
  lineage_candidate: '找同一件事的政見',
  handover_missing: '記前後任交接',
  lineage_roles_missing: '標參與角色',
  lineage_link_candidate: '找上下級脈絡',
  // 2026-10-06
  placeholder_politician: '疑似測試資料',
  party_info_missing: '補政黨資訊',
  other: '其他',
}

/** 查不到名稱時不要把代號丟給使用者看；代號留給 console */
export function taskTypeLabel(type: string): string {
  const label = TASK_TYPE_LABEL[type]
  if (label) return label
  console.info('[任務看板] 沒有中文名稱的任務型別：', type)
  return '其他'
}
