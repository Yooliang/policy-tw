-- 2026 名冊對帳任務再插隊一次（2026-11-07，維護者小良核准「插隊」）。
--   號次已全部公告，cec_roster_2026（19,493）與我們的差異：缺 107、多 39、重複 2，靠 auto:roster_check:2026* 對帳補齊。
--   但這 127 張的 queue_at 落在 1.2 萬筆可派列之後（前面是 1,041 張驗證票與約 1.08 萬件補人物資料），03:30 之後一張都沒派出。
--   做法同 20261101050000：沒插隊的列加一份 queue_settings.boost_seconds，觸發器照排序鍵重算 queue_at；派出就歸零（一次性）。
--   差別：查無冷卻中（cool_until 未過）的不動、也不清 cooling——那 28 張剛查過，冷卻過了照常回來（20261107000000 的查無 2 天規則）。
--   只動 roster_check 2026 的列，不碰其他任務、不寫任何參選資料。
UPDATE task_dispatches d
   SET boost_seconds = d.boost_seconds + q.boost_seconds
  FROM queue_settings q
 WHERE q.id = 1
   AND d.task_id LIKE 'auto:roster_check:2026%'
   AND d.boost_seconds = 0
   AND NOT d.blocked
   AND (d.cool_until IS NULL OR d.cool_until <= now());
