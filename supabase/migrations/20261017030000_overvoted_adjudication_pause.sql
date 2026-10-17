-- 投太多輪的裁決：不插隊、先暫停開新的（維護者 2026-10-17：「我其實是想先停下裁決，我怕最後卡一大堆」「至少他不該插隊」）
-- 1. manual_front_seconds：contribution_overvoted_tick 開的裁決任務（created_by = 'auto-overvoted'）第一次進佇列不插隊（0 秒），
--    其餘照 20261011320000。它的裁決交件的驗證票跟著任務排（20261017010000），所以也一起不插隊。
-- 2. 暫停 pg_cron overvoted-tick-10min：不再把超過停派線的交件轉 disputed、開裁決任務。
--    超過停派線的照舊不派驗證（驗證池在 LIMIT 之前排除），主控台隊列頁「投太多輪」區列著等維護者裁。
--    已開的 5 件照常進行（不插隊）。恢復＝新 migration 重新 cron.schedule 同一行。
CREATE OR REPLACE FUNCTION manual_front_seconds(p_task_id TEXT) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN t.created_by = 'auto-overvoted' THEN 0
              WHEN manual_task_is_visitor(t.source, t.task_type) THEN q.visitor_front_seconds
              WHEN t.source IN ('manual', 'auto_dispute') THEN q.manual_front_seconds
              ELSE 0 END
    FROM contribution_tasks t CROSS JOIN queue_settings q
   WHERE q.id = 1 AND t.id::TEXT = p_task_id
$$;
COMMENT ON FUNCTION manual_front_seconds IS '手動任務第一次進佇列的插隊秒數：網站請求／公民提問 visitor_front_seconds、維護者建的與裁決 manual_front_seconds、投太多輪開的裁決（created_by auto-overvoted）0、其餘 0。2026-10-13；2026-10-17 投太多輪不插隊';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'overvoted-tick-10min') THEN
    PERFORM cron.unschedule('overvoted-tick-10min');
  END IF;
END $$;

-- 已開的投太多輪裁決任務：派工列上若還留著插隊秒數，歸零
UPDATE task_dispatches d SET boost_seconds = 0
  FROM contribution_tasks t
 WHERE t.id::TEXT = d.task_id AND t.created_by = 'auto-overvoted' AND COALESCE(d.boost_seconds, 0) <> 0;
