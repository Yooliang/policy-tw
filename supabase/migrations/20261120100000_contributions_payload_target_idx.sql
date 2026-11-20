-- 歷史頁「依對象查貢獻」的三個 payload 鍵加表達式索引（#1005）。
-- 原本 `payload->>'politician_id' = $1` 等查詢只能全表掃描（約 9 萬列、讀 8 萬個 buffer、約 190ms）。
-- 條件是等號（嚴格運算子），planner 能推得「值不為 NULL」，所以用部分索引即可命中，並省掉沒有該鍵的列。
-- 回滾：DROP INDEX contributions_payload_politician_idx, contributions_payload_policy_idx, contributions_payload_question_idx;
CREATE INDEX IF NOT EXISTS contributions_payload_politician_idx ON contributions ((payload->>'politician_id')) WHERE payload->>'politician_id' IS NOT NULL;
CREATE INDEX IF NOT EXISTS contributions_payload_policy_idx     ON contributions ((payload->>'policy_id'))     WHERE payload->>'policy_id' IS NOT NULL;
CREATE INDEX IF NOT EXISTS contributions_payload_question_idx   ON contributions ((payload->>'question_id'))   WHERE payload->>'question_id' IS NOT NULL;
