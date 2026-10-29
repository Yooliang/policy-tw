-- 號次驗證票一次性插隊（2026-10-29，維護者：「號次驗證票也插隊」）。
--   補號次交件已上線（今天 09:06 起 1,722 筆含號次的交件全是 pending、0 筆通過），卡在驗證這一段：
--   驗證票排在網站請求與一般缺口之後。做法同 20261029010000（補號次缺口插隊）與 /boost：
--   對「還在等票的號次交件」的驗證列加一份 queue_settings.boost_seconds（5 年）；被派出就歸零，所以是一次性，
--   之後才交的號次驗證票不受影響。不動規則、不動臂。
UPDATE task_dispatches d
   SET boost_seconds = d.boost_seconds + q.boost_seconds, cooling = false
  FROM contributions c, queue_settings q
 WHERE q.id = 1
   AND d.task_id = 'verify:' || c.id::text
   AND c.status = 'pending'
   AND c.contribution_type = 'candidacy'
   AND c.payload ? 'cand_no'
   AND d.boost_seconds = 0;
