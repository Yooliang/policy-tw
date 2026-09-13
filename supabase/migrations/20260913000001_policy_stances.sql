-- 讀者對既有政見表態：支持／反對／更在意。
--
-- 這不是投票決定政見的真假——真假由同儕共識與來源決定，那條路不受影響。
-- 這是民意訊號：同一條政見，多少人支持、多少人反對、多少人覺得該優先處理。
-- 政見頁上直接顯示，讓候選人與讀者看得到落差。
--
-- 刻意跟 question_stances 同一套做法：計數存在主表（政見頁只讀計數，不讀個別表態），
-- 個別表態連同 IP 雜湊不對外開放，一個來源 IP 一條政見只能表態一次、可以改。
--
-- 為什麼「更在意」跟支持／反對並列而不是另一個軸：實務上讀者想表達的是三件事——
-- 我贊成、我反對、我不一定有立場但這件事對我很重要。第三種在只有贊成／反對的
-- 介面上會被迫選一邊，訊號反而失真。

ALTER TABLE policies
  ADD COLUMN IF NOT EXISTS stance_support  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stance_oppose   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stance_priority INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN policies.stance_support  IS '讀者表態：支持（由 policy_stances 的 trigger 同步，不要手改）';
COMMENT ON COLUMN policies.stance_oppose   IS '讀者表態：反對';
COMMENT ON COLUMN policies.stance_priority IS '讀者表態：更在意（沒有立場但覺得重要）';

CREATE TABLE IF NOT EXISTS policy_stances (
  id            BIGSERIAL PRIMARY KEY,
  policy_id     UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  -- 1=支持 -1=反對 2=更在意。用小整數而不是 enum：改法跟 question_stances 一致，
  -- 而且加第四種時不必動型別。
  stance        SMALLINT NOT NULL CHECK (stance IN (-1, 1, 2)),
  voter_ip_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 一個來源 IP 一條政見只能表態一次（要改就改這一列）
  CONSTRAINT policy_stances_one_per_ip UNIQUE (policy_id, voter_ip_hash)
);
COMMENT ON TABLE policy_stances IS '讀者對政見的表態；個別紀錄不對外，畫面只看 policies 上的三個計數';
CREATE INDEX IF NOT EXISTS policy_stances_voter_idx ON policy_stances (voter_ip_hash, created_at DESC);

ALTER TABLE policy_stances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role all" ON policy_stances;
CREATE POLICY "Service role all" ON policy_stances FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
-- 不開公開讀：個別表態連同 IP 雜湊不對外

-- ------------------------------------------------------------
-- 計數同步：結構性保證，不靠應用層自律。
-- 改表態（UPDATE）、撤回（DELETE）、政見被刪（CASCADE）都要對得上。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_stances_sync() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_pid UUID;
BEGIN
  v_pid := COALESCE(NEW.policy_id, OLD.policy_id);
  UPDATE policies SET
    stance_support  = (SELECT COUNT(*) FROM policy_stances WHERE policy_id = v_pid AND stance = 1),
    stance_oppose   = (SELECT COUNT(*) FROM policy_stances WHERE policy_id = v_pid AND stance = -1),
    stance_priority = (SELECT COUNT(*) FROM policy_stances WHERE policy_id = v_pid AND stance = 2)
  WHERE id = v_pid;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS policy_stances_sync_trg ON policy_stances;
CREATE TRIGGER policy_stances_sync_trg
  AFTER INSERT OR UPDATE OR DELETE ON policy_stances
  FOR EACH ROW EXECUTE FUNCTION policy_stances_sync();

-- ------------------------------------------------------------
-- 重建 policies_with_logs。
--
-- 這個 view 是 `SELECT p.*, …` 建的，而 PostgreSQL 在建立時就把 * 展開並凍結欄位清單。
-- 結果是：policies 後來加的欄位一個都沒進來。實際查到的 view 欄位只有 15 個，
-- 少了今天加的 removed_at，也不會有剛加的三個表態計數。
--
-- removed_at 缺席不只是少一欄：前端整站的政見都從這個 view 讀，沒有這一欄就
-- **過濾不掉已軟移除的政見**。今天才做的「明顯錯誤可以被移除」機制因此形同虛設——
-- 目前剛好 0 筆被移除所以看不出來，等第一筆 removal 通過驗證就會露餡。
--
-- CREATE OR REPLACE 不能用：* 重新展開後新欄位會插在 logs／related_policy_ids 前面，
-- 欄位順序改變，REPLACE 會直接拒絕。所以 DROP 再建。
-- 不加 CASCADE：真的有東西依賴它的話，我要看到錯誤，不是讓它被一起刪掉。
-- ------------------------------------------------------------
DROP VIEW IF EXISTS policies_with_logs;

CREATE VIEW policies_with_logs AS
SELECT
  p.*,
  COALESCE(
    (SELECT json_agg(
      json_build_object('id', tl.id, 'date', tl.date, 'event', tl.event, 'description', tl.description)
      ORDER BY tl.date
    )
    FROM tracking_logs tl
    WHERE tl.policy_id = p.id),
    '[]'::json
  ) AS logs,
  COALESCE(
    (SELECT json_agg(rp.related_policy_id)
     FROM related_policies rp
     WHERE rp.policy_id = p.id),
    '[]'::json
  ) AS related_policy_ids
FROM policies p;

-- 跟其他 view 一樣以呼叫者身分執行，底層表的 RLS 才會生效（見 20260912000016）
ALTER VIEW policies_with_logs SET (security_invoker = on);
