-- 驗證票的排序改成「任務被派出前的位置 − 14 天 ＋ 7 天 × 這張票被領走的次數」（2026-11-04，工作單：Yooliang/policy-ops#198，小良哥裁定；更正 2026-10-17「驗證票跟著母任務」）
-- ============================================================
--
-- 問題（小良哥）：任務被領走時插隊秒數歸零、位置回隊尾，驗證票跟的是「回隊尾後」的位置，所以交完件之後的驗證票排在隊尾那一帶
--   （實例：任務 11/01、票 10/19，10/21 之前可派的任務約 7,300 件，「交完下一個人就驗它」沒有發生）；票被領走一次又回隊尾。
--
-- 新規則：
--   基準 B ＝ 母任務被派出（dispatch_count 變動）當下、派出前的排序位置，含插隊秒數。任務被派出時插隊歸零、位置回隊尾（任務列的行為一字不變），
--     所以 B 在派出當下記在任務列的新欄位 task_dispatches.dispatch_base_at；算法與 verify_queue_key 看母任務時完全一樣：
--     task_queue_key(派出前的 last_dispatched_at, 優先秒數, cool_until, boost_seconds)，優先秒數是負的照 queue_settings.verify_inherit_negative 當 0（10-13 裁決不變）。
--   驗證票 queue_at ＝ B − verify_priority_seconds(14 天) − 自己的 boost_seconds ＋ 步長 × dispatch_count。步長有兩個新參數：
--     verify_redispatch_seconds（7 天，一般票）、verify_no_change_redispatch_seconds（14 天，no_change 的票）。第 1 次（還沒被領走）也是 B − 14 天。
--   驗證票入列時（contribution_queue_row／seed 補列的 INSERT）把 B 凍結在自己的列上，之後不再看母任務：
--     · 一般任務的交件：B ＝ 母任務列的 dispatch_base_at（母任務在交件之後才被再派出的，不採用）
--     · 「新增」型交件（verify_ticket_is_new）、或母任務沒有基準（沒經過 /next 派出就交件：/tasks、/request-task、無 task_id、母任務列已不在）：B ＝ 交件建立時間
--   驗證票的 boost_seconds 不再因派出歸零（任務列照舊歸零，#96 的票一路保留到結案）；驗證票被領走一次的位置不再是「派出時間 − 優先秒數 − 14 天」。
--   no_change 的 1～2 天延後（defer_seconds）不再算進排序鍵（小良哥 2026-11-04 裁定，改成 no_change 領走後每次往後 14 天）：欄位保留不刪，觸發器不再寫它；
--   既有 no_change 票的延後已經在凍結的基準裡（見下面的過渡），位置不變，只是之後領走時不再重算延後。投太多輪、爭點驗證、任務停放、原子認領、驗證池過濾都不動。
--   母任務之後被 /boost 不再讓已存在的票跟著前移；要插某張票用 /boost 的 task_ids 指定票本身。
--   refresh_verify_ticket_keys 簽名不動，改成只依列上凍結的值與設定重算（不看母任務），seed 與 task_boost 照舊呼叫也不會讓票移位。
--
-- 既有的票（過渡）：每張既有驗證列把 B 設成「現在的 queue_at ＋ 14 天 ＋ 自己的 boost_seconds − 步長 × dispatch_count」（no_change 步長 14 天，其餘 7 天；不再減 defer_seconds，既有的延後因此留在 B 裡），
--   新公式在同一個瞬間算出來剛好等於現在存的 queue_at：不重算、不跳位；插隊中的票（例如 #96）原樣保留，是公式裡「− boost_seconds」那一項。
--   之後每被領走一次多一個步長，插隊秒數不再歸零。migration 內有自我檢查：回填後任何一張票的 queue_at 變了就整支失敗（期間鎖住 task_dispatches 的寫入）。
--
-- 沒動：verify_follows_task 欄位與 verify_queue_key（簽名不改，要改簽名分兩次上；這次它們不再被排序鍵使用）。日本站（policy_jp）這次不跟，
--   policy-jp-dispatch-drift.test.ts 登記偏離。task_boost_remaining 的 verifies 仍數 boost_seconds > 0 的票——驗證票的插隊不再因派出歸零，
--   所以它現在代表「還帶著插隊秒數的票」，領走過的也算。
--
-- 引用到的既有物件（2026-11-04 唯讀查正式庫確認存在）：task_dispatches(task_id, queue_at, dispatch_count, boost_seconds, defer_seconds, last_dispatched_at,
--   priority_seconds, cool_until, verify_follows_task)、queue_settings(verify_priority_seconds, verify_inherit_negative)、task_queue_key()、verify_ticket_parent()、
--   verify_ticket_defer_seconds()、verify_ticket_priority_seconds()、contribution_queue_row 觸發器。

-- ── 1. 欄位與參數 ──────────────────────────────────────────
ALTER TABLE queue_settings
  ADD COLUMN IF NOT EXISTS verify_redispatch_seconds INTEGER NOT NULL DEFAULT 604800
    CHECK (verify_redispatch_seconds BETWEEN 0 AND 31536000);
COMMENT ON COLUMN queue_settings.verify_redispatch_seconds IS '驗證票每被領走一次往後排的秒數（預設 7 天；no_change 的票用 verify_no_change_redispatch_seconds）：queue_at ＝ 基準 − verify_priority_seconds − boost_seconds ＋ 步長 × dispatch_count。2026-11-04';
ALTER TABLE queue_settings
  ADD COLUMN IF NOT EXISTS verify_no_change_redispatch_seconds INTEGER NOT NULL DEFAULT 1209600
    CHECK (verify_no_change_redispatch_seconds BETWEEN 0 AND 31536000);
COMMENT ON COLUMN queue_settings.verify_no_change_redispatch_seconds IS 'no_change 驗證票每被領走一次往後排的秒數（預設 14 天；其他票用 verify_redispatch_seconds）。2026-11-04';

ALTER TABLE task_dispatches ADD COLUMN IF NOT EXISTS dispatch_base_at TIMESTAMPTZ;
COMMENT ON COLUMN task_dispatches.dispatch_base_at IS '任務列：最近一次被派出（dispatch_count 變動）當下、派出前的排序位置（含插隊秒數；負的優先秒數照 verify_inherit_negative），給之後交件產生的驗證票當基準；驗證列：入列時凍結的基準（之後不再看母任務）。沒經過 /next 派出的任務列是 NULL。2026-11-04';

-- ── 2. 函式 ────────────────────────────────────────────────
-- 這張驗證票每被領走一次往後排幾秒：no_change 用 verify_no_change_redispatch_seconds，其餘用 verify_redispatch_seconds
CREATE OR REPLACE FUNCTION verify_ticket_step_seconds(p_verify_task_id TEXT) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM contributions c WHERE c.id = uuid_or_null(substr(p_verify_task_id, 8)) AND c.contribution_type = 'no_change')
              THEN q.verify_no_change_redispatch_seconds ELSE q.verify_redispatch_seconds END
    FROM queue_settings q WHERE q.id = 1
$$;
COMMENT ON FUNCTION verify_ticket_step_seconds IS '驗證票每被領走一次往後排的秒數（2026-11-04）：no_change 14 天、其餘 7 天（queue_settings 兩個參數）';

-- 驗證票的排序鍵：基準 − 14 天 − 自己的插隊秒數 ＋ 步長 × 領走次數
CREATE OR REPLACE FUNCTION verify_ticket_key(p_base TIMESTAMPTZ, p_dispatch_count INTEGER, p_boost_seconds BIGINT, p_step_seconds INTEGER)
RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(p_base, now())
         - make_interval(secs => s.vs + COALESCE(p_boost_seconds, 0))
         + make_interval(secs => COALESCE(p_step_seconds, 0)::double precision * COALESCE(p_dispatch_count, 0))
    FROM (SELECT COALESCE((SELECT q.verify_priority_seconds FROM queue_settings q WHERE q.id = 1), 0) AS vs) s
$$;
COMMENT ON FUNCTION verify_ticket_key IS '驗證票的排序鍵（2026-11-04）：基準 − verify_priority_seconds − 自己的 boost_seconds ＋ 步長 × dispatch_count（步長見 verify_ticket_step_seconds）。不看母任務、不看派出時間、不算 defer_seconds';

-- 既有的票把 B 凍結成「用新公式算回現在的 queue_at」的值（過渡；也是觸發器遇到沒有基準的驗證列時的退路）
CREATE OR REPLACE FUNCTION verify_ticket_freeze_base(p_queue_at TIMESTAMPTZ, p_dispatch_count INTEGER, p_boost_seconds BIGINT, p_step_seconds INTEGER)
RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT p_queue_at
         + make_interval(secs => s.vs + COALESCE(p_boost_seconds, 0))
         - make_interval(secs => COALESCE(p_step_seconds, 0)::double precision * COALESCE(p_dispatch_count, 0))
    FROM (SELECT COALESCE((SELECT q.verify_priority_seconds FROM queue_settings q WHERE q.id = 1), 0) AS vs) s
$$;
COMMENT ON FUNCTION verify_ticket_freeze_base IS '用 verify_ticket_key 的反運算把基準凍結成「新公式在這一刻剛好等於現在的 queue_at」的值（2026-11-04 過渡）';

-- 一張新驗證票入列時的基準 B
--   「新增」型交件：交件建立時間；一般任務的交件：母任務列的 dispatch_base_at（母任務在交件之後才又被派出的不採用）；
--   母任務沒有基準（沒經過 /next 派出就交件、母任務列已不在）：交件建立時間
CREATE OR REPLACE FUNCTION verify_ticket_base(p_verify_task_id TEXT) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN t.contribution_type IS NULL THEN NULL
           WHEN t.is_new THEN COALESCE(t.created_at, now())
           ELSE COALESCE((SELECT p.dispatch_base_at FROM task_dispatches p
                           WHERE p.task_id = t.parent_id AND p.dispatch_base_at IS NOT NULL
                             AND p.last_dispatched_at <= COALESCE(t.created_at, now())),
                         COALESCE(t.created_at, now()))
         END
    FROM (SELECT 1) x LEFT JOIN verify_ticket_parent(p_verify_task_id) t ON true
$$;
COMMENT ON FUNCTION verify_ticket_base IS '驗證票入列時的基準 B（2026-11-04）：新增型＝交件建立時間；一般任務＝母任務列的 dispatch_base_at（交件之後才又被派出的不採用）；沒有基準＝交件建立時間；找不到貢獻回 NULL（觸發器改用 now()）';

-- queue_at＝排序鍵（同 20261028140000，只改兩處，標 >>>）：
--   · 任務列被派出時記下派出前的位置到 dispatch_base_at（插隊歸零、回隊尾照舊）；驗證列派出時不歸零插隊
--   · 驗證列的排序鍵改走 verify_ticket_key（基準凍結在自己的列上）
CREATE OR REPLACE FUNCTION task_dispatches_queue_key() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  -- >>> 驗證票排序（20261104120000）：驗證列的插隊不因派出歸零；任務列派出時先記下派出前的位置（給之後交件的驗證票當基準）再歸零
  IF TG_OP = 'UPDATE' AND NEW.dispatch_count IS DISTINCT FROM OLD.dispatch_count AND NEW.task_id NOT LIKE 'verify:%' THEN
    NEW.dispatch_base_at := task_queue_key(
      COALESCE(OLD.last_dispatched_at, now()),
      CASE WHEN COALESCE((SELECT q.verify_inherit_negative FROM queue_settings q WHERE q.id = 1), false) THEN OLD.priority_seconds ELSE GREATEST(OLD.priority_seconds, 0) END,
      OLD.cool_until, OLD.boost_seconds);
    NEW.boost_seconds := 0;  -- 插隊是一次性的：派出就歸零，回隊尾
  END IF;
  -- <<< 驗證票排序
  IF NEW.task_id LIKE 'verify:%' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.priority_seconds := verify_ticket_priority_seconds(NEW.task_id);
    END IF;
    -- verify_follows_task：欄位保留（改簽名要分兩次上），排序鍵已不看它；照舊記「領走過」
    IF (TG_OP = 'UPDATE' AND NEW.dispatch_count IS DISTINCT FROM OLD.dispatch_count) OR (TG_OP = 'INSERT' AND COALESCE(NEW.dispatch_count, 0) > 0) THEN
      NEW.verify_follows_task := false;
    END IF;
    -- no_change 的 1～2 天延後（20261028140000）不再用：改成 no_change 的步長 14 天；defer_seconds 欄位保留、觸發器不再寫它
    -- >>> 驗證票排序（20261104120000）：入列時凍結基準；遇到沒有基準的舊列（UPDATE）就用現在的 queue_at 反推，不讓票跳位
    IF NEW.dispatch_base_at IS NULL THEN
      IF TG_OP = 'INSERT' THEN
        NEW.dispatch_base_at := COALESCE(verify_ticket_base(NEW.task_id), now());
      ELSE
        NEW.dispatch_base_at := verify_ticket_freeze_base(OLD.queue_at, OLD.dispatch_count, OLD.boost_seconds, verify_ticket_step_seconds(NEW.task_id));
      END IF;
    END IF;
    NEW.queue_at := verify_ticket_key(NEW.dispatch_base_at, NEW.dispatch_count, NEW.boost_seconds, verify_ticket_step_seconds(NEW.task_id));
    -- <<< 驗證票排序
  ELSE
    NEW.queue_at := task_queue_key(COALESCE(NEW.last_dispatched_at, now()), NEW.priority_seconds, NEW.cool_until, NEW.boost_seconds);
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION task_dispatches_queue_key IS
  'task_dispatches 的 BEFORE INSERT／UPDATE 觸發器：queue_at 一律照排序鍵重算（任務列 task_queue_key；驗證列 verify_ticket_key＝入列時凍結的基準 − 14 天 − 自己的插隊秒數 ＋ 步長 × 領走次數，步長 7 天、no_change 14 天）。'
  '任務列派出時記下派出前的位置（dispatch_base_at）、插隊歸零回隊尾；驗證列的插隊不因派出歸零。2026-11-04 改（更正 2026-10-17 的驗證票跟著母任務）';

-- 還依列上凍結的值與設定重算驗證票（不看母任務）：簽名不變，seed 與 task_boost 照舊呼叫；設定（14 天、7 天）改了也靠它同步
CREATE OR REPLACE FUNCTION refresh_verify_ticket_keys() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  UPDATE task_dispatches d
     SET queue_at = verify_ticket_key(d.dispatch_base_at, d.dispatch_count, d.boost_seconds, verify_ticket_step_seconds(d.task_id))
   WHERE d.task_id LIKE 'verify:%' AND d.dispatch_base_at IS NOT NULL
     AND d.queue_at IS DISTINCT FROM verify_ticket_key(d.dispatch_base_at, d.dispatch_count, d.boost_seconds, verify_ticket_step_seconds(d.task_id));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
COMMENT ON FUNCTION refresh_verify_ticket_keys IS '驗證票的 queue_at 依列上凍結的基準與設定重算（2026-11-04 起不看母任務，母任務被插隊不會讓已存在的票移位）；回傳換了位置的張數';

-- ── 3. 既有的票：凍結基準，位置不動（自我檢查：任何一張變了就整支失敗） ──────────
DO $$
DECLARE v_moved INTEGER; v_rows INTEGER;
BEGIN
  LOCK TABLE task_dispatches IN SHARE ROW EXCLUSIVE MODE;
  CREATE TEMP TABLE _verify_before ON COMMIT DROP AS SELECT task_id, queue_at FROM task_dispatches WHERE task_id LIKE 'verify:%';
  UPDATE task_dispatches d
     SET dispatch_base_at = verify_ticket_freeze_base(d.queue_at, d.dispatch_count, d.boost_seconds, verify_ticket_step_seconds(d.task_id))
   WHERE d.task_id LIKE 'verify:%' AND d.dispatch_base_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  SELECT count(*) INTO v_moved FROM _verify_before b JOIN task_dispatches d ON d.task_id = b.task_id WHERE d.queue_at IS DISTINCT FROM b.queue_at;
  IF v_moved > 0 THEN
    RAISE EXCEPTION '驗證票排序過渡失敗：% 張票的 queue_at 變了（共回填 % 張）', v_moved, v_rows;
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
