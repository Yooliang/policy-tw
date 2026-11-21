-- 派工優先序：抄公報整段抬到其他種類之上（2026-11-22，維護者 05:40「抄公報抬到其他種類之上」；接 #1026 層級×種類帶狀優先）
-- ============================================================
--
-- 原因（上線約 8 小時的觀察）：層級優先讓車隊九成人力集中在縣市長／議員層的重複政見清理與脈絡「查無」，
--   代表、村里長的抄公報幾乎停擺，公報收錄每小時只 +3～7 人。
--
-- 改的（天，加在屆基準之上；層級不動）：
--   1. 抄公報種類（policy_missing、policy_election_missing）15 → 175：任何層級的抄公報都高於任何層級的其他種類——
--      最高的非抄公報 ＝ 縣市長查證票 170＋19 ＝ 189；最低的抄公報 ＝ 村里長 50＋175 ＝ 225；抄公報內部仍照層級。
--      例：2026 縣市長抄公報 2600＋170＋175 ＝ 2945、村里長抄公報 2825、縣市長照片 2780。
--   2. 插隊（網站按鈕、/boost、維護者任務）200 → 400 天：queue_settings 的 boost_seconds、visitor_front_seconds、
--      visitor_front_pre_election_seconds、manual_front_seconds 皆改 34,560,000。最低插隊 30＋0＋400 ＝ 430 仍高於最高抄公報 170＋175 ＝ 345。
--      （插隊中的列屆基準仍用最新一屆。）
--   3. 驗證票簡化為「屆基準＋母任務層級＋19」：verify_ticket_base 一律取 交件建立時間 − (選舉年秒數 ＋ verify_ticket_band_seconds)，
--      不再沿用「母任務位置 ＋ (19 − 母種類)」（抄公報種類 175 會讓 19 − 母種類變負）。/next 本來就驗證先於任務，票的秒數只影響票之間。
--      verify_ticket_parent_lead_seconds 與夾限函式留著但 verify_ticket_base 不再讀。
--   4. 其他種類、層級、流量比例制不動；投票日後 policy_missing 臂自動關，不需要再改回。
--   5. 一次性重算（任務列與驗證票）：改前的值存進新的備份表 priority_bands2_backup（不蓋掉 #1026 的 priority_bands_backup 回滾點）；
--      先依 task_id 順序 FOR UPDATE 鎖列、lock_timeout 5 秒；插隊中的任務列抬到 400 天。冪等：queue_settings.priority_bands_bulletin_applied_at。
--      流量與需求疊加由下一輪 seed（10 分鐘內）補上。
--   seed 與手動入列不用改：它們呼叫的 task_band_seconds 讀 task_kind_days_by_type。
--
-- 回滾（順序照這樣）：
--   1. UPDATE queue_settings SET boost_seconds = 17280000, manual_front_seconds = 17280000, visitor_front_seconds = 17280000, visitor_front_pre_election_seconds = 17280000 WHERE id = 1;
--   2. task_kind_days_by_type 與 verify_ticket_base 換回 20261121193000 的定義（CREATE OR REPLACE，內容在那支檔案）。
--   3. 用備份表還原（套用時存的改前值）：
--        UPDATE task_dispatches d SET dispatch_base_at = b.dispatch_base_at FROM priority_bands2_backup b WHERE d.task_id = b.task_id AND d.task_id LIKE 'verify:%';
--        UPDATE task_dispatches d SET boost_seconds = b.boost_seconds FROM priority_bands2_backup b WHERE d.task_id = b.task_id AND d.task_id NOT LIKE 'verify:%' AND d.boost_seconds = 34560000 AND b.boost_seconds > 0 AND b.boost_seconds < 34560000;
--      任務列的 priority_seconds 下一輪 seed（10 分鐘）自己換回。新欄位與備份表留著不影響。

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

-- 1. 種類天數：抄公報 15 → 175
CREATE OR REPLACE FUNCTION task_kind_days_by_type(p_task_type TEXT, p_has_photo_gap BOOLEAN) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN p_task_type LIKE 'verify%' OR p_task_type = 'adjudicate' THEN 19
           WHEN p_task_type IN ('policy_missing', 'policy_election_missing') THEN 175  -- >>> 抄公報抬到其他種類之上（20261122）：原 15
           WHEN p_task_type = 'term_policy_missing' THEN 13
           WHEN p_task_type LIKE 'lineage\_%' THEN 12
           WHEN p_task_type = 'avatar_choice' THEN 10
           WHEN p_task_type = 'profile_gap' THEN CASE WHEN COALESCE(p_has_photo_gap, false) THEN 10 ELSE 8 END
           WHEN p_task_type IN ('profile_detail_gap', 'party_info_missing', 'candidacy_source_missing', 'candidate_status_stale') THEN 8
           WHEN p_task_type IN ('duplicate_policy', 'duplicate_politician', 'policy_election_mismatch', 'source_mismatch', 'policy_source_missing',
                                'policy_validity', 'issue_too_broad', 'legacy_audit') THEN 5
           WHEN p_task_type IN ('progress_stale', 'deadline_due') THEN 3
           ELSE 0 END
$$;
COMMENT ON FUNCTION task_kind_days_by_type IS '任務型別 → 種類天數（20261121，20261122 抄公報 15 → 175）：查證票／adjudicate 19、抄公報 175、任內政見 13、脈絡 12、照片 10、人物基本資料 8、整理類 5、進度 3、其他 0。2026-11-22';

-- 3. 驗證票基準：一律 交件建立時間 − (選舉年秒數 ＋ 母任務層級＋19 天)
CREATE OR REPLACE FUNCTION verify_ticket_base(p_verify_task_id TEXT) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN t.contribution_type IS NULL THEN NULL
           ELSE COALESCE(t.created_at, now()) - make_interval(secs => verify_ticket_election_seconds(p_verify_task_id) + verify_ticket_band_seconds(p_verify_task_id))  -- >>> 抄公報抬高（20261122）：不再沿用母任務位置
         END
    FROM (SELECT 1) x LEFT JOIN verify_ticket_parent(p_verify_task_id) t ON true
$$;
COMMENT ON FUNCTION verify_ticket_base IS '驗證票入列時的基準 B（20261122 起）：交件建立時間 − (選舉年秒數 ＋ 母任務層級＋19 天)，即票 ＝ 屆基準＋母任務層級＋19；不再沿用母任務位置（20261121193000 的「母任務位置＋(19−母種類)」在抄公報 175 天下會變負）。找不到貢獻回 NULL';

-- 2. 設定與一次性重算
COMMENT ON COLUMN queue_settings.priority_bands_bulletin_applied_at IS '抄公報抬高（20261122160000）的一次性設定與重算做完的時間；有值＝已套用，重跑 migration 不再動設定。2026-11-22';
COMMENT ON COLUMN queue_settings.boost_seconds IS '/boost 插隊一次加幾秒（20261122 起 400 天＝34560000；原 200 天）；插隊中的列屆基準用最新一屆；插兩次加兩份；任務列派出就歸零';
COMMENT ON COLUMN queue_settings.manual_front_seconds IS '維護者建的手動任務與裁決第一次進佇列的插隊秒數（20261122 起 400 天；原 200 天）';
COMMENT ON COLUMN queue_settings.visitor_front_seconds IS '網站請求／公民提問的插隊秒數（選後與對不上選舉的目標；20261122 起 400 天，原 200 天）；判斷在 visitor_front_seconds_for(target)';
COMMENT ON COLUMN queue_settings.visitor_front_pre_election_seconds IS '網站請求／公民提問的插隊秒數（選前；20261122 起 400 天，原 200 天，與選後一致）';

DO $$
DECLARE r RECORD; v_n INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM queue_settings WHERE id = 1 AND priority_bands_bulletin_applied_at IS NOT NULL) THEN
    RAISE NOTICE '抄公報抬高的一次性設定與重算已套用過，略過';
    RETURN;
  END IF;

  -- 備份改前的值（回滾用，見檔頭）並依 task_id 順序先鎖列
  CREATE TABLE IF NOT EXISTS priority_bands2_backup (task_id TEXT PRIMARY KEY, dispatch_base_at TIMESTAMPTZ, priority_seconds INTEGER, boost_seconds BIGINT, queue_at TIMESTAMPTZ, saved_at TIMESTAMPTZ NOT NULL DEFAULT now());
  ALTER TABLE priority_bands2_backup ENABLE ROW LEVEL SECURITY;
  COMMENT ON TABLE priority_bands2_backup IS '抄公報抬高（20261122160000）套用前的 task_dispatches 值備份，只給回滾用；沒有任何 policy＝只有 service_role 讀得到。2026-11-22';
  INSERT INTO priority_bands2_backup (task_id, dispatch_base_at, priority_seconds, boost_seconds, queue_at)
    SELECT d.task_id, d.dispatch_base_at, d.priority_seconds, d.boost_seconds, d.queue_at FROM task_dispatches d ORDER BY d.task_id
  ON CONFLICT (task_id) DO NOTHING;
  PERFORM 1 FROM task_dispatches d ORDER BY d.task_id FOR UPDATE;

  -- 前：隊頭 30 筆
  CREATE TEMP TABLE _pb2_head_before ON COMMIT DROP AS
    SELECT d.task_type, COALESCE(task_level_text(d.task_type, d.target), '無層級') AS lvl
      FROM task_dispatches d WHERE d.task_id NOT LIKE 'verify:%' AND NOT d.blocked ORDER BY d.queue_at, d.task_id LIMIT 30;
  FOR r IN SELECT task_type, lvl, count(*) AS n FROM _pb2_head_before GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2 LOOP
    RAISE NOTICE '重算前 任務隊頭30 % ／ %：% 筆', r.task_type, r.lvl, r.n;
  END LOOP;

  UPDATE queue_settings
     SET boost_seconds = 34560000, manual_front_seconds = 34560000, visitor_front_seconds = 34560000, visitor_front_pre_election_seconds = 34560000,
         note = COALESCE(note || '；', '') || '2026-11-22 抄公報抬到其他種類之上：抄公報種類 15 → 175 天、插隊四值 200 → 400 天（34560000）'
   WHERE id = 1;

  -- 插隊中的任務列抬到 400 天（驗證票的插隊不動：驗證隊伍先看 verify_rank）
  UPDATE task_dispatches d SET boost_seconds = 34560000
   WHERE d.task_id NOT LIKE 'verify:%' AND d.boost_seconds > 0 AND d.boost_seconds < 34560000;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '插隊中的任務列抬到 400 天：% 列', v_n;

  -- 任務列：屆基準（插隊中用最新一屆）＋ 層級 ＋ 種類（新的種類天數）；觸發器重算 queue_at。流量與需求疊加下一輪 seed 補上
  UPDATE task_dispatches d
     SET priority_seconds = (task_year_priority_seconds(d.target, d.boost_seconds > 0) + task_band_seconds(d.task_type, d.target))::INTEGER
   WHERE d.task_id NOT LIKE 'verify:%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '重算 % 列任務列的 priority_seconds', v_n;

  -- 驗證票：基準改成新的 verify_ticket_base（找不到貢獻的保留原值）；觸發器照 verify_ticket_key 重算 queue_at
  UPDATE task_dispatches v SET dispatch_base_at = COALESCE(verify_ticket_base(v.task_id), v.dispatch_base_at) WHERE v.task_id LIKE 'verify:%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '重算 % 張驗證票的基準', v_n;

  -- 後：隊頭 30 筆
  FOR r IN SELECT d.task_type, COALESCE(task_level_text(d.task_type, d.target), '無層級') AS lvl, count(*) AS n
             FROM (SELECT x.task_type, x.target FROM task_dispatches x WHERE x.task_id NOT LIKE 'verify:%' AND NOT x.blocked ORDER BY x.queue_at, x.task_id LIMIT 30) d
            GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2 LOOP
    RAISE NOTICE '重算後 任務隊頭30 % ／ %：% 筆', r.task_type, r.lvl, r.n;
  END LOOP;

  IF EXISTS (SELECT 1 FROM task_dispatches WHERE task_id NOT LIKE 'verify:%'
                AND queue_at IS DISTINCT FROM task_queue_key(last_dispatched_at, priority_seconds, cool_until, boost_seconds)) THEN
    RAISE EXCEPTION '有任務列的 queue_at 不是排序鍵';
  END IF;

  UPDATE queue_settings SET priority_bands_bulletin_applied_at = now() WHERE id = 1;
END;
$$;

NOTIFY pgrst, 'reload schema';
