-- jev_decisions.state 保留政策：14 天前的 state 清成只剩判決摘要（維護者 2026-11-19 裁示；docs/decisions/2026-11-19-Jev判決只留摘要state保留14天.md）。
--
-- 現況（2026-11-19 唯讀查正式庫）：
--   jev_decisions 約 37 萬列（9/19 起），每天新增 5k～23k；主表 404 MB＋索引＋TOAST，合計 912 MB，全庫最大。
--   空間幾乎都在 state（每次問 Jev 附的輸入快照：整頁正文、投稿文字、人物與新聞），判決欄（choice、probability、probabilities、model、cost_usd）很小。
--   沒有任何清理。asked_at 超過 14 天的約 23.7 萬列。
--   表對 anon 公開讀（RLS 一條 USING (true)），舊 state（網頁正文）一直被公開暴露。
--
-- 做什麼：asked_at 超過保留天數的列，state 換成「只剩判決摘要」（預設 '{}'，加上 keep_keys 白名單裡的幾個小純量，見下）。
--   不刪列：id、subject_*、question、choice、probability、probabilities、model、cost_usd、asked_at、state_hash 全部不動。
--   已清的 state 不可復原（沒有備份副本）；要保留就把設定的 days 調大，或 enabled=false。
--
-- 這支 migration 必須先處理的一件事：state_hash 以前是 GENERATED ALWAYS AS (md5(state::text)) STORED。
--   (1) 把 state 改掉，指紋會跟著重算，「同 state 同模型只問一次」（jev_decisions_once_per_state）等於失效——
--       已清的列會變成 md5('{}')，再問一次同一件事就不會被擋，重骰到滿意為止的防線沒了。
--   (2) 同一個 (subject_type, subject_id, question, model) 如果有好幾列（state 變了重問留下的歷史），清完全部是同一個指紋，
--       UPDATE 會直接撞唯一索引。
--   所以：把 state_hash 改成一般欄位（DROP EXPRESSION 只改欄位定義，不重寫表、既有指紋原值保留），
--   由 BEFORE INSERT 觸發器補算 md5(NEW.state::text)。寫入端（upsert onConflict ... state_hash、ignoreDuplicates）不用改一行：
--   觸發器在衝突判斷之前執行，同 state 重問仍被擋。之後 UPDATE state 不會重算指紋（清理要的就是這個）。
--
-- 為什麼是白名單而不是全部清成 '{}'（讀取端核對，全 repo 的 TS／SQL 都 grep 過，詳見 PR 描述）：
--   還有幾處程式讀「舊 state 的小欄位」，清光會改變行為：
--     supported_sources  contribution_system_vote_sources()：最新有效系統票 supported 時降 1～2 分，清掉會變成降 1 分（目標分數悄悄 +1）
--     schema             system-one 合併核對：只認 state.schema＝merge-identity-v2 的舊判定，不認就重問 Jev（付費，每輪 cron 都會再問）
--     reason             roster_batch_status()（公開）：用 reason 分類名冊核對結果，清掉全變「其他」
--   這三個是數字或短字串（reason 截 200 字），整批加起來不到一個 MB，白名單存在設定表 keep_keys，改值一行 UPDATE。
--   另外：還在流程中的交件（contributions.status 不是 applied／rejected／superseded／withdrawn／reverted）的判決列整列不碰——
--   /next 的驗證項讀 state（名冊核對的 pdf_url、整批結果的 mismatches、號次重複、身份檢查 identity_hold）、
--   票數預算影子的 no_change 判斷讀 state->'target'、cec-results 自動套用讀 state 的 unit_open、轉載檢查讀 page.text。
--   交件一結案（通常幾天內），下一輪就會清。目前約 1,350 件在流程中，每件的判決列只有幾列。
--   trace_events（/trace）只看 14 天內的系統票（interval '14 days'），保留天數的下限也是 14（設定表 CHECK），守門測試盯這件事。
--
-- 排程：先每 10 分鐘（4-59/10 ＝ :04、:14、:24…，避開 :00 擠在一起的 seed／jp-seed／cec-sync），每輪最多 batch_size × max_batches ＝ 2.5 萬列，
--   存量幾十輪內清完；函式沒事做時一次索引查詢就返回。
--   **存量清完後改成每日一次**（一行，不必再 migration；UTC 20:05＝台北 04:05，避開 19:30 的週六 cec-sync-2024-weekly）：
--     SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'jev-state-prune'), schedule => '5 20 * * *');
--   （改日排程後再開新 migration 把排程寫成 '5 20 * * *' 才算收斂；上面那行只是現場立即生效。）
--
-- 上線順序：**enabled 預設 false**（函式直接回 0、什麼都不動）。已清的 state 不可復原，所以先小批試跑再全開：
--     SELECT jev_decisions_prune_state(NULL, 100, 1);   -- 清 100 列，逐欄核對：判決欄與 state_hash 不變、state 只剩 supported_sources／schema／reason
--     UPDATE jev_prune_settings SET enabled = true WHERE id = 1;
--   （排程從 migration 套用起就在跑，但 enabled=false 時每輪只讀一列設定。）
--
-- 為什麼 statement_timeout 寫在 cron 指令而不是函式上的 SET：頂層語句的計時器在進函式前就已啟動，函式 SET 的新值對這一句不生效。
--   所以 cron 指令是 'SET statement_timeout TO ''120s''; SELECT jev_decisions_prune_state();'（pg_cron 多語句指令已在正式庫驗證可行）。
--   每輪最多 2.5 萬列（p_max_batches 預設 5），一次交易夠小，不長時間持有列鎖。lock_timeout 仍在函式上（函式內的鎖等待受它管）。
--
-- 回收空間：UPDATE 只是把大 state 換成小的，舊版本要等 autovacuum 釋放，而且 autovacuum 只把空間還給表自己，不還給作業系統。
--   要真的縮小檔案得 VACUUM FULL jev_decisions（鎖表）或 pg_repack，不在這支 migration 做，指令與時段見 PR 描述。
--
-- 索引膨脹：state_pruned_at 是部分索引 jev_decisions_state_unpruned_idx 的述詞欄，UPDATE 它不是 HOT 更新（HOT 要求被更新的欄位不在任何索引的鍵或述詞裡），
--   所以每一列的 UPDATE 都會在表上全部 6 個索引各新增一筆索引項，舊項等 vacuum 回收；存量清的這段時間索引會長。
--   存量清完後做一次 VACUUM FULL（會連索引一起重建）或 REINDEX TABLE jev_decisions 回收。
--
-- 引用到的既有物件：jev_decisions(state, state_hash, asked_at, subject_type, subject_id)、contributions(id, status)、
--   activity_audit()、activity_touch_updated_at()、edit_history、auth.role()、擴充 pg_cron（cron.schedule／cron.unschedule）。
-- 正式庫沒有 jev_prune_settings、jev_decisions_prune_state、jev-state-prune 排程、state_pruned_at 欄位（2026-11-19 查）。
-- 範圍：只有 public.jev_decisions。policy_jp.jev_decisions（日本站，約 456 列）另案。

-- ------------------------------------------------------------
-- 1. state_hash：GENERATED → 一般欄位＋BEFORE INSERT 觸發器
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION jev_decisions_set_state_hash() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.state_hash := md5(NEW.state::text);
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION jev_decisions_set_state_hash IS
  '新增 jev_decisions 時算 state_hash＝md5(state::text)（以前是 GENERATED 欄位；改一般欄位是為了讓清理 state 時指紋不變）。只在 INSERT 執行，UPDATE state 不重算。2026-11-19';

DO $$
BEGIN
  -- 同一個交易內：先放掉運算式，再掛觸發器；中間沒有任何寫入看得到沒有指紋的列（DROP EXPRESSION 持有表的排他鎖到交易結束）
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.jev_decisions'::regclass AND attname = 'state_hash' AND attgenerated <> '') THEN
    ALTER TABLE jev_decisions ALTER COLUMN state_hash DROP EXPRESSION;
  END IF;
  DROP TRIGGER IF EXISTS trg_jev_decisions_state_hash ON jev_decisions;
  CREATE TRIGGER trg_jev_decisions_state_hash BEFORE INSERT ON jev_decisions
    FOR EACH ROW EXECUTE FUNCTION jev_decisions_set_state_hash();
END $$;
COMMENT ON COLUMN jev_decisions.state_hash IS
  'md5(state::text)，新增時由觸發器算（2026-11-19 起不是 GENERATED）。同 state 同模型只會有一列；state 變了才會多一列。清理 state 不改它，所以清掉的列仍擋同 state 重問';

-- ------------------------------------------------------------
-- 2. 已清標記＋索引（只找還沒清的列，不掃整張表、不讀 TOAST）
-- ------------------------------------------------------------
ALTER TABLE jev_decisions ADD COLUMN IF NOT EXISTS state_pruned_at TIMESTAMPTZ;
COMMENT ON COLUMN jev_decisions.state_pruned_at IS
  'state 被 jev_decisions_prune_state() 清成摘要的時間；NULL＝還是完整的輸入快照。2026-11-19';
CREATE INDEX IF NOT EXISTS jev_decisions_state_unpruned_idx ON jev_decisions (asked_at) WHERE state_pruned_at IS NULL;

-- ------------------------------------------------------------
-- 3. 設定（單列）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jev_prune_settings (
  id          SMALLINT PRIMARY KEY CHECK (id = 1),
  enabled     BOOLEAN NOT NULL DEFAULT false,  -- 上線先關；小批試跑核對後再 UPDATE enabled = true（見檔頭）
  -- 下限 14＝/trace（trace_events）只看 14 天內的系統票；比它短，/trace 會讀到被清掉的 supported_sources
  days        INTEGER NOT NULL DEFAULT 14 CHECK (days BETWEEN 14 AND 3650),
  batch_size  INTEGER NOT NULL DEFAULT 5000 CHECK (batch_size BETWEEN 100 AND 50000),
  max_batches INTEGER NOT NULL DEFAULT 5 CHECK (max_batches BETWEEN 1 AND 200),
  keep_keys   TEXT[] NOT NULL DEFAULT ARRAY['supported_sources', 'schema', 'reason'],
  note        TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE jev_prune_settings IS
  'jev_decisions state 清理的參數（單列 id=1）。改值一行 UPDATE，例：UPDATE jev_prune_settings SET days = 30, note = ''…'' WHERE id = 1;（每次修改進 edit_history，agent_name=activity-audit）。停用：enabled = false。已清的 state 不可復原。2026-11-19';
COMMENT ON COLUMN jev_prune_settings.enabled IS 'false＝排程照跑但什麼都不動（預設 false；先 jev_decisions_prune_state(NULL, 100, 1) 小批試跑核對，再改 true）';
COMMENT ON COLUMN jev_prune_settings.days IS 'asked_at 超過幾天的判決，state 清成摘要。下限 14（/trace 的回看窗）；函式參數只能把它調長、不能調短';
COMMENT ON COLUMN jev_prune_settings.batch_size IS '每一批最多處理幾列';
COMMENT ON COLUMN jev_prune_settings.max_batches IS '每次排程最多跑幾批；沒做完的下一輪接著做';
COMMENT ON COLUMN jev_prune_settings.keep_keys IS '清 state 時保留的頂層欄位（只留數字與短字串，字串截 200 字）：讀取端還在用的小欄位，見 migration 檔頭';
INSERT INTO jev_prune_settings (id, note) VALUES (1, '初值：14 天；每批 5,000 列、最多 5 批；白名單 supported_sources／schema／reason（維護者 2026-11-19 裁示）；enabled 預設 false，小批試跑核對後才開') ON CONFLICT (id) DO NOTHING;

ALTER TABLE jev_prune_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON jev_prune_settings;
CREATE POLICY "Public read" ON jev_prune_settings FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON jev_prune_settings;
CREATE POLICY "Service role write" ON jev_prune_settings FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
DROP TRIGGER IF EXISTS trg_jev_prune_settings_touch ON jev_prune_settings;
CREATE TRIGGER trg_jev_prune_settings_touch BEFORE UPDATE ON jev_prune_settings FOR EACH ROW EXECUTE FUNCTION activity_touch_updated_at();
DROP TRIGGER IF EXISTS trg_jev_prune_settings_audit ON jev_prune_settings;
CREATE TRIGGER trg_jev_prune_settings_audit AFTER INSERT OR UPDATE OR DELETE ON jev_prune_settings FOR EACH ROW EXECUTE FUNCTION activity_audit();

-- ------------------------------------------------------------
-- 4. 清理函式：分批、跳過被鎖住的列，回傳這次處理幾列
--    參數 NULL＝用設定表的值；明給的 p_days 只能比設定長（不能繞過下限）。enabled=false 時一律回 0。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION jev_decisions_prune_state(p_days INTEGER DEFAULT NULL, p_batch INTEGER DEFAULT NULL, p_max_batches INTEGER DEFAULT NULL)
RETURNS BIGINT
LANGUAGE plpgsql
SET lock_timeout = '3s'
AS $$
DECLARE
  s jev_prune_settings%ROWTYPE;
  v_cut TIMESTAMPTZ;
  v_batch INTEGER;
  v_max INTEGER;
  v_total BIGINT := 0;
  n BIGINT;
  i INTEGER;
BEGIN
  SELECT * INTO s FROM jev_prune_settings WHERE id = 1;
  IF NOT FOUND OR NOT s.enabled THEN RETURN 0; END IF;
  v_cut := now() - make_interval(days => GREATEST(COALESCE(p_days, s.days), s.days));
  v_batch := GREATEST(1, LEAST(COALESCE(p_batch, s.batch_size), 50000));
  v_max := GREATEST(1, LEAST(COALESCE(p_max_batches, s.max_batches), 200));

  FOR i IN 1..v_max LOOP
    -- 每批：用已清標記的部分索引依 asked_at 由舊到新挑，FOR UPDATE SKIP LOCKED（碰到正被寫入的列就跳過，不排隊、不擋住 Edge Function）
    WITH picked AS (
      SELECT j.id FROM jev_decisions j
       WHERE j.state_pruned_at IS NULL AND j.asked_at < v_cut
         -- 還在流程中的交件，判決列的 state 是工作資料，不碰（結案後下一輪才清）
         AND NOT (j.subject_type = 'contribution' AND j.subject_id IN (
               SELECT c.id::text FROM contributions c
                WHERE c.status NOT IN ('applied', 'rejected', 'superseded', 'withdrawn', 'reverted')))
       ORDER BY j.asked_at, j.id
       LIMIT v_batch
       FOR UPDATE OF j SKIP LOCKED
    )
    UPDATE jev_decisions d
       SET state = COALESCE((
             SELECT jsonb_object_agg(k, CASE WHEN jsonb_typeof(d.state -> k) = 'number' THEN d.state -> k ELSE to_jsonb(left(d.state ->> k, 200)) END)
               FROM unnest(s.keep_keys) AS k
              WHERE jsonb_typeof(d.state -> k) IN ('number', 'string')
           ), '{}'::jsonb),
           state_pruned_at = now()
      FROM picked p
     WHERE d.id = p.id;
    GET DIAGNOSTICS n = ROW_COUNT;
    v_total := v_total + n;
    EXIT WHEN n < v_batch;
  END LOOP;

  RETURN v_total;
END;
$$;
COMMENT ON FUNCTION jev_decisions_prune_state IS
  '把 asked_at 超過保留天數的判決的 state 清成摘要（只動 state 與 state_pruned_at；不刪列、不動 state_hash 與判決欄）。天數與批量在 jev_prune_settings；還在流程中的交件不碰；回傳這次處理幾列。pg_cron jev-state-prune。2026-11-19';
REVOKE ALL ON FUNCTION jev_decisions_prune_state(INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION jev_decisions_prune_state(INTEGER, INTEGER, INTEGER) TO service_role;

-- ------------------------------------------------------------
-- 5. 排程：每 10 分鐘，:04 起算（存量清完後改每日，指令見檔頭）。pg_cron 不存在的環境（本機、測試）略過
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    EXECUTE $q$SELECT cron.unschedule('jev-state-prune') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'jev-state-prune')$q$;
    EXECUTE $q$SELECT cron.schedule('jev-state-prune', '4-59/10 * * * *', 'SET statement_timeout TO ''120s''; SELECT jev_decisions_prune_state();')$q$;
  END IF;
END $$;
