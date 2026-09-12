-- 明顯不該存在的資料要有辦法被移除。
--
-- 觸發這件事的實例：政見「承擔責任 不排斥參選」，內容是某人表態願不願意被徵召，
-- 那是參選表態不是政見，而且沒有來源網址。既有的 correction 只能改欄位，
-- 改不掉「這筆根本不該是一筆政見」。
--
-- 設計取捨
--   * 移除是軟移除：不 DELETE，打上 removed_at 讓它從網站消失，紀錄留著、可以復原。
--     因為可以復原，門檻才敢訂得比「新增參選人」低。
--   * 訪客在頁面上按「這筆資料有問題」不會直接刪掉任何東西，只會開一筆任務，
--     由 AI 代理去判斷該移除還是該留，再走同儕投票。沒有人工關卡，也沒有人能一鍵刪。
--   * 門檻固定 3 票，不看來源等級。移除的理由通常是「查不到任何來源」，
--     這種主張本身沒有來源可言，用來源等級決定票數沒有意義。

ALTER TABLE policies
  ADD COLUMN IF NOT EXISTS removed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS removed_reason TEXT,
  ADD COLUMN IF NOT EXISTS removed_by     UUID REFERENCES contributions(id) ON DELETE SET NULL;

COMMENT ON COLUMN policies.removed_at IS '軟移除：有值就不在網站上顯示，但資料與查核履歷都留著，可以復原';
COMMENT ON COLUMN policies.removed_reason IS '移除理由，寫給讀者看的一句話（例如：這是參選表態，不是政見）';

-- 網站上的清單與統計一律只看沒被移除的，所以給個部分索引
CREATE INDEX IF NOT EXISTS policies_visible_idx ON policies (politician_id) WHERE removed_at IS NULL;

-- ------------------------------------------------------------
-- 新的貢獻型別 removal，與新的任務類型 removal_review
-- ------------------------------------------------------------
ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_contribution_type_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_contribution_type_check
  CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction',
                               'task_suggestion', 'no_change', 'adjudication', 'question_answer', 'removal'));

-- 門檻：removal 固定 3 票（不看來源等級）。其餘維持 000013 的數字。
CREATE OR REPLACE FUNCTION contribution_required_agree(p_type TEXT, p_payload JSONB, p_source_urls TEXT[]) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_risk TEXT; v_kind TEXT;
BEGIN
  v_kind := contribution_source_kind(p_source_urls);
  v_risk := CASE
    WHEN p_type = 'adjudication' THEN 'adjudication'
    WHEN p_type = 'removal' THEN 'removal'
    WHEN p_type = 'candidacy' OR (p_type = 'correction' AND (p_payload->>'field' = 'candidate_status' OR p_payload->'changes' @> '[{"field":"candidate_status"}]'::jsonb)) THEN 'high'
    WHEN p_type IN ('task_suggestion', 'no_change') THEN 'light'
    ELSE 'normal'
  END;
  RETURN CASE
    WHEN v_risk = 'normal' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'high' THEN CASE v_kind WHEN 'official' THEN 4 WHEN 'media' THEN 6 WHEN 'social' THEN 8 ELSE 8 END
    WHEN v_risk = 'light' THEN CASE v_kind WHEN 'official' THEN 1 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    WHEN v_risk = 'removal' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    ELSE 4
  END;
END;
$$;
