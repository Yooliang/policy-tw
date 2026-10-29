-- 補號次缺口一次性插隊（2026-10-29，維護者：「加速處理，先把號次處理掉，他是一次性的，所以先插隊處理完」）。
--   抽號次 10-23 公布、補號次臂（candidacy_source_missing:cand_no）窗口早已開，但 941 件排在隊後、dispatch_count 全是 0，
--   2026 已登記 19,149 人帶號次的 0 人。做法同 /boost（task_boost）：對已在佇列的列加一份 queue_settings.boost_seconds（5 年），
--   派出就歸零，所以是一次性；之後新出生的列不受影響，不動臂、不動規則。
UPDATE task_dispatches d
   SET boost_seconds = d.boost_seconds + q.boost_seconds, cooling = false
  FROM queue_settings q
 WHERE q.id = 1
   AND d.task_id LIKE 'auto:candidacy_source_missing:cand_no:%'
   AND d.boost_seconds = 0;
