-- Jev（TypeSafe System One）影子模式的判決紀錄。設計理由見 docs/BLUEPRINT-jev-decisions.md。
--
-- 為什麼是一張泛用表、不是在 policies／politician_identity_reviews 上加欄位：
--   判定有五種（是不是政見／重複於誰／哪一屆／同名指認／兩筆人物是不是同一人），
--   主體有三種（政見、身份審查、人物配對）。散在各表會變成五套欄位、五套稽核規則。
--
-- 三個約束用結構保證，不靠呼叫端自律：
--   1. 一次性 —— unique(subject_type, subject_id, question, model)。
--      同一筆同一種判定只會有一筆紀錄，擋掉「重問到滿意為止」。
--   2. 釘版本 —— model 存回應裡的 typesafe/jev-1.13-20260917，不是請求裡的 typesafe/jev-1.13。
--      換版後重問會因為 model 不同而新增一列，舊的定案理由留著。
--   3. 存 state —— 少了它，事後分不出是「資料沒餵夠」還是「判斷錯了」。
--
-- 這張表只記錄，不參與任何計票。Jev 不能投票也不能否決（藍圖 §3）。

CREATE TABLE IF NOT EXISTS jev_decisions (
  id           BIGSERIAL PRIMARY KEY,
  subject_type TEXT        NOT NULL CHECK (subject_type IN ('policy', 'identity_review', 'politician_pair')),
  -- 政見／審查是單一 id；人物配對是兩個 uuid 排序後用 | 接起來，順序不影響唯一性
  subject_id   TEXT        NOT NULL,
  question     TEXT        NOT NULL CHECK (question IN ('is_policy', 'duplicate_of', 'election', 'identity', 'same_person')),
  choice       TEXT        NOT NULL,
  -- 被選中那個選項的機率。門檻用它，不用 confidence（confidence 是整體把握度，會比機率低）
  probability  NUMERIC(5,4) NOT NULL CHECK (probability >= 0 AND probability <= 1),
  confidence   NUMERIC(5,4) CHECK (confidence >= 0 AND confidence <= 1),
  probabilities JSONB,
  model        TEXT        NOT NULL,
  -- 它當時看到的全部事實
  state        JSONB       NOT NULL,
  cost_usd     NUMERIC(12,8),
  asked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (subject_type, subject_id, question, model)
);

CREATE INDEX IF NOT EXISTS jev_decisions_subject_idx ON jev_decisions (subject_type, subject_id);
-- 「有哪些高信心的結論還沒被人看過」是最常問的一句
CREATE INDEX IF NOT EXISTS jev_decisions_question_prob_idx ON jev_decisions (question, probability DESC);

COMMENT ON TABLE jev_decisions IS
  'Jev 影子模式判決紀錄。只記錄、不計票；門檻與落庫規則見 docs/BLUEPRINT-jev-decisions.md';
COMMENT ON COLUMN jev_decisions.model IS
  '回應裡的完整版本（typesafe/jev-1.13-20260917），不是請求裡的 alias';
COMMENT ON COLUMN jev_decisions.state IS
  '送給模型的 state 原文。沒有它就無法重現，也查不出是資料不足還是判斷錯';

ALTER TABLE jev_decisions ENABLE ROW LEVEL SECURITY;

-- 跟全站一致：公開讀。這裡沒有個資，state 裡是本來就公開的政見與人物欄位。
DROP POLICY IF EXISTS "jev_decisions public read" ON jev_decisions;
CREATE POLICY "jev_decisions public read" ON jev_decisions FOR SELECT USING (true);

-- 寫入只走 service role（Edge Function 與批次腳本）。沒有 INSERT／UPDATE／DELETE policy，
-- 等於 anon 與登入使用者都寫不進來。
