/**
 * 任務型別 → 建議用哪一種貢獻型別回報。
 *
 * 這張表原本在 next/index.ts 與 tasks/index.ts 各抄一份，而且早就抄岔了：
 * tasks 那份停在六種，news_sweep／fix_disputed／policy_election_missing／roster_check
 * 四種任務從 /tasks 拿到的 suggested_contribution_type 一直是 null，沒有任何東西會紅。
 * 2026-09-13 加 election_result_missing 時踩到，收成一份。
 *
 * 新增自動缺口時只改這裡。protocol-guard.test.ts 會從 migration 的 SQL 把所有 task_type
 * 撈出來逐一比對，漏登記就紅。
 */
export const SUGGESTED_TYPE: Record<string, string> = {
  duplicate_politician: "merge_politician",
  // 政見重複清查：找到重複就對空泛的那筆提 removal；沒有重複用 no_change 回報（任務敘述有寫）
  duplicate_policy: "removal",
  // 不參選重查：在名單上就 correction 改回 registered；確實不在名單上用 no_change（outcome=confirmed）
  not_running_recheck: "correction",
  legacy_audit: "no_change",
  policy_missing: "policy",
  profile_gap: "politician",
  policy_source_missing: "correction",
  // 來源存在但不支持內容（數字／承諾原文查無）：改寫或刪掉那段沒根據的文字，走 correction 改 policies.description；整筆都沒根據才 removal
  source_mismatch: "correction",
  progress_stale: "policy_progress",
  candidacy_source_missing: "candidacy",
  adjudicate: "adjudication",
  // 掃 RSS 找到的多半是新政見；既有政見的新進度就改用 policy_progress，任務敘述有寫
  news_sweep: "policy",
  // 修正任務多半是改既有資料；整筆不該存在的話改用 removal，任務敘述有寫
  fix_disputed: "correction",
  policy_election_missing: "correction",
  policy_election_mismatch: "correction",
  // 選舉結果要補在參選紀錄上（politician_elections.election_result），所以走 candidacy
  election_result_missing: "candidacy",
  // 名單清查用同名的型別回報
  roster_check: "roster_check",
  // 公民提問用 question_answer 回報（非自動缺口，所以守門測試不會要求它，但它一樣該有）
  question: "question_answer",
  // 登記截止後還掛著「傳聞參選」的：查登記名單後用 correction 改成 registered 或 not_running
  candidate_status_stale: "correction",
  // 「這不是政見？」：查證後多半是整筆移除，也可能是改分類（correction）或確認有效（no_change），
  // 任務敘述會把三條路都講清楚。這裡給最常見的那一種。
  // 2026-09-22 shuwei-huang 實跑 8 題：6 題是真政見只缺出處、只有 2 題是口號——預設建議 removal 會把人往刪的方向帶；
  // 常態是補 source_url（correction），真的不是政見再走 removal（做法裡三條路照舊）
  policy_validity: "correction",
};
