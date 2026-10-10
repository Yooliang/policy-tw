/**
 * 排程批次的 HTTP 狀態：這一輪有失敗、而且一筆都沒做成 → 500（不是 200）。
 *
 * 2026-10-09：網頁正文的 NUL 字元讓 jev_decisions 寫入全部失敗，system-one 的系統票停了約 16 小時沒人發現——
 * cron 每 10 分鐘照跑、端點回 200，失敗只寫在回應的 failures 裡（#551 修了原因，這支修「無聲」）。
 * 回 500 之後 net._http_response 的 status_code 看得出來，activity_health 的 system_vote_stalled 另外從資料面盯。
 * 部分成功照舊 200（個別網頁抓不到是常態）。
 */
export function batchHttpStatus(done: number, failures: ReadonlyArray<unknown>): number {
  return failures.length > 0 && done === 0 ? 500 : 200;
}
