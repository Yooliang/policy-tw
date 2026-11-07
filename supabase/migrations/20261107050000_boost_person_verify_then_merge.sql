-- 人物先定下來：人物相關的驗證票先插隊，再來是人物合併（2026-11-07，維護者小良核准）
--   小良：「先把這種人物的驗證先做插隊讓他整個結束，然後再對人物的合併狀況做插隊，盡可能讓人物先定下來再來做後續」。
--   起因：舊排序時代留下來的參選紀錄等票 13～19 天，等它通過時已有人另外建了同一人 → 重複人物（陳麗娟、王國華等 5 組）。
--   做法（只動 task_dispatches 的 boost_seconds，不寫任何資料）：
--     第一層＝2 份 boost_seconds：等票中的 candidacy／politician／reassign_candidacy 的驗證票（verify:<id>）。
--       驗證票的插隊不因派出歸零（20261104120000），一路保留到結案，所以一次加就夠。
--     第二層＝1 份 boost_seconds：等票中的 merge_politician 驗證票，以及同名人物清查 auto:duplicate_politician 的任務列（派出就歸零，一次性）。
--     第一層的鍵比第二層早 5 年，所以人物驗證全部排在合併前面；兩層都在一般任務前面。
--   冷卻中、擋住的不動；已插隊過（boost_seconds > 0）的不重複加。
UPDATE task_dispatches d
   SET boost_seconds = 2 * q.boost_seconds
  FROM queue_settings q, contributions c
 WHERE q.id = 1 AND d.task_id = 'verify:' || c.id::text
   AND c.status = 'pending' AND c.contribution_type IN ('candidacy', 'politician', 'reassign_candidacy')
   AND d.boost_seconds = 0;

UPDATE task_dispatches d
   SET boost_seconds = q.boost_seconds
  FROM queue_settings q, contributions c
 WHERE q.id = 1 AND d.task_id = 'verify:' || c.id::text
   AND c.status = 'pending' AND c.contribution_type = 'merge_politician'
   AND d.boost_seconds = 0;

UPDATE task_dispatches d
   SET boost_seconds = q.boost_seconds
  FROM queue_settings q
 WHERE q.id = 1 AND d.task_id LIKE 'auto:duplicate_politician:%'
   AND d.boost_seconds = 0 AND NOT d.blocked AND (d.cool_until IS NULL OR d.cool_until <= now());
