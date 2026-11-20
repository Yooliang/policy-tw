-- 強模型裁決自動排入作業（維護者 2026-11-20 裁示：「強模型裁決不用手動排隊，改自動」）。
--
-- 背景：auto-strong 任務（strong_lane_sweep，task.target.requires_tier='strong'）開出來之後，要進 strong_adjudications 作業表，
--   VM 上的執行者（每 5 分鐘 claim 一次 queued）才領得到；原本得由維護者在主控台按「排進作業」或「全部排入」（enqueue_all，#978）。
--   結果任務開了沒人按，正式庫 2026-11-20 有 117 件開著的強模型任務、其中 67 件從來沒有過任何作業。
--
-- 改法：這支 migration 把 enqueue_all 的規則逐條翻成 SQL（strong_adjudications_auto_enqueue），由 pg_cron 每 10 分鐘呼叫。
--   任務一出現就在下一輪被排入，不用人按。主控台的「排進作業」「全部排入」照舊可用（人工動作不受開關影響）。
--
-- 與 enqueue_all（supabase/functions/_shared/strong-adjudicate.ts，action === "enqueue_all"）逐條對照：
--   候選任務  contribution_tasks 裡 task_type='adjudicate' AND status='open' AND target->>'requires_tier'='strong'
--             （＝ strong_lane_list() 的 items 條件）；排序 created_at 由舊到新（list 同序），每輪上限 p_limit。
--   已結案    原貢獻（target.contribution_id）存在且狀態不是 pending／disputed → 跳過（比 enqueue_all 多的一條；找不到原貢獻照排）。
--   busy      任何一筆作業 status 是 queued／running，或 previewed／finalizing 且 COALESCE(completed_at, created_at) 在 30 分鐘內
--             （RECENT_WINDOW_MIN）→ 跳過。
--   returned  最新一筆作業（created_at 最大）是 returned（人退回的）→ 跳過，不自動再跑。
--   retry_cap 這件任務累計已有 2 筆作業（任何狀態，ENQUEUE_ALL_MAX_JOBS_PER_TASK）→ 跳過。
--   寫入      INSERT INTO strong_adjudications (task_id, contribution_id) ── status 預設 queued，其餘欄位全走預設；
--             contribution_id ＝ target->>'contribution_id'（空字串視為 NULL）；requested_by ＝ 'auto-enqueue'
--             （手動排入寫的是維護者 email，這是唯一可區分來源的欄位）。與手動排入的列欄位形狀完全一樣，執行者 claim 不用改。
--   並發      同一件任務同時只能有一筆 queued／running 的唯一索引（strong_adjudications_one_active_per_task）擋掉；
--             撞到就略過（ON CONFLICT DO NOTHING），對應 enqueue_all 的 conflict → busy。
--   不同處    ⓪多一條「已結案」（見上）；①沒有 requeueStale：running 超過 30 分鐘退回 queued、finalizing 超過 10 分鐘收回 previewed，仍由執行者每次 claim 與
--               主控台 list／enqueue 時處理；退回之前這些列算 busy，只會少排、不會多排。
--             ②沒有 strong_lane_list 的 LIMIT 200 上限（直接查表）；每輪上限改由 p_limit 控制。
--   與手動排入的後續流程不變：執行者 claim → complete 後同一支函式立刻帶鑰匙 POST /report 定案（#978）。
--
-- 開關與上限（沿用單列設定表 strong_lane_settings，id=1）：
--   enabled（既有，總開關）＆ auto_enqueue_enabled（新，預設 true）都為 true 才會排；auto_enqueue_limit（新，預設 20，1～200）＝每輪上限。
--   存量 117 件在每 10 分鐘 20 件下約 1 小時排完；執行者並行上限不變。
-- 排程：'6-59/10 * * * *'（每小時 :06、:16…，同分鐘目前只有 2 支；:08 是 strong-lane-sweep，剛開出的任務下一輪就被排入）。
--   指令帶 SET statement_timeout TO '60s'。
-- 回滾：SELECT cron.unschedule('strong-adjudications-auto-enqueue-10min');
--       或 UPDATE strong_lane_settings SET auto_enqueue_enabled = false WHERE id = 1;（排程照跑、函式回 0）。
--       已排入的 queued 作業不會被收回（要收回請在主控台對該筆 return_to_human，或把 status 改 failed）。

ALTER TABLE strong_lane_settings ADD COLUMN IF NOT EXISTS auto_enqueue_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE strong_lane_settings ADD COLUMN IF NOT EXISTS auto_enqueue_limit INTEGER NOT NULL DEFAULT 20 CHECK (auto_enqueue_limit BETWEEN 1 AND 200);
COMMENT ON COLUMN strong_lane_settings.auto_enqueue_enabled IS 'false＝自動排入停用（排程照跑、函式回 0）；主控台手動排入不受影響。2026-11-20';
COMMENT ON COLUMN strong_lane_settings.auto_enqueue_limit IS '自動排入每輪（每 10 分鐘）最多排幾件，1～200。2026-11-20';

-- >>> BEGIN auto_enqueue
CREATE OR REPLACE FUNCTION strong_adjudications_auto_enqueue(p_limit INTEGER DEFAULT NULL) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_on BOOLEAN; v_cap INTEGER; v_lim INTEGER; v_n INTEGER := 0; v_ins INTEGER; r RECORD;
BEGIN
  SELECT s.enabled AND s.auto_enqueue_enabled, s.auto_enqueue_limit INTO v_on, v_cap FROM strong_lane_settings s WHERE s.id = 1;
  IF NOT COALESCE(v_on, false) THEN RETURN 0; END IF;
  v_lim := COALESCE(p_limit, v_cap);
  IF v_lim < 1 OR v_lim > 200 THEN RAISE EXCEPTION 'p_limit 要是 1～200 的整數（收到 %）', v_lim; END IF;
  FOR r IN
    SELECT t.id::TEXT AS task_id, NULLIF(t.target->>'contribution_id', '') AS contribution_id
      FROM contribution_tasks t
     WHERE t.task_type = 'adjudicate' AND t.status = 'open' AND t.target->>'requires_tier' = 'strong'
       -- 原貢獻已被一般驗證結案（狀態不是 pending／disputed）就不排：強模型任務只為還沒定案的交件開
       AND NOT EXISTS (SELECT 1 FROM contributions c WHERE c.id::TEXT = t.target->>'contribution_id' AND c.status NOT IN ('pending', 'disputed'))
       -- busy：排隊中、執行中，或 30 分鐘內剛出爐（previewed／finalizing）
       AND NOT EXISTS (SELECT 1 FROM strong_adjudications a WHERE a.task_id = t.id::TEXT
                          AND (a.status IN ('queued', 'running')
                               OR (a.status IN ('previewed', 'finalizing') AND COALESCE(a.completed_at, a.created_at) >= now() - interval '30 minutes')))
       -- returned：最新一筆是人退回的，不自動再跑
       AND COALESCE((SELECT a.status FROM strong_adjudications a WHERE a.task_id = t.id::TEXT ORDER BY a.created_at DESC LIMIT 1), '') <> 'returned'
       -- retry_cap：累計已有 2 筆作業（任何狀態）就不再排
       AND (SELECT count(*) FROM strong_adjudications a WHERE a.task_id = t.id::TEXT) < 2
     ORDER BY t.created_at, t.id
     LIMIT v_lim
  LOOP
    -- created_at 用 clock_timestamp()：同一輪排入的列各有先後，執行者 oldestQueued 才會照最舊任務先領
    INSERT INTO strong_adjudications (task_id, contribution_id, requested_by, created_at) VALUES (r.task_id, r.contribution_id, 'auto-enqueue', clock_timestamp())
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_ins = ROW_COUNT;
    v_n := v_n + v_ins;
  END LOOP;
  RETURN v_n;
END;
$$;
-- <<< END auto_enqueue
COMMENT ON FUNCTION strong_adjudications_auto_enqueue IS '強模型任務自動排入作業表（規則同主控台 enqueue_all：busy／returned／retry_cap 跳過，最舊先，每輪上限）。pg_cron 每 10 分鐘呼叫；開關 strong_lane_settings.auto_enqueue_enabled／auto_enqueue_limit。回傳這輪排入幾件。2026-11-20';
REVOKE ALL ON FUNCTION strong_adjudications_auto_enqueue(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION strong_adjudications_auto_enqueue(INTEGER) TO service_role;

DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    EXECUTE $q$SELECT cron.unschedule('strong-adjudications-auto-enqueue-10min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'strong-adjudications-auto-enqueue-10min')$q$;
    EXECUTE $q$SELECT cron.schedule('strong-adjudications-auto-enqueue-10min', '6-59/10 * * * *', 'SET statement_timeout TO ''60s''; SELECT strong_adjudications_auto_enqueue();')$q$;
  END IF;
END $$;
