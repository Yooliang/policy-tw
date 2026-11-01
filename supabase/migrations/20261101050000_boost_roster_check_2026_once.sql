-- 2026 名單清查任務一次性插隊（2026-11-01，維護者核准「名單清查插隊」）。
--   auto:roster_check:2026*（含 findings_only）共 256 張，其中 246 張從沒派出過，queue_at 落在 21,452 筆可派列的第 12,298～18,097 名，
--   原因是沒有插隊。做法同號次缺口（20261029010000）與 /boost（task_boost）：對已在佇列的列加一份
--   queue_settings.boost_seconds（5 年），觸發器照排序鍵重算 queue_at；派出就歸零，所以是一次性——7 天重開的新列不會自動插隊。
--   只動 roster_check 2026 的列，不碰其他任務、不寫任何參選資料。
UPDATE task_dispatches d
   SET boost_seconds = d.boost_seconds + q.boost_seconds, cooling = false
  FROM queue_settings q
 WHERE q.id = 1
   AND d.task_id LIKE 'auto:roster_check:2026%'
   AND d.boost_seconds = 0;
