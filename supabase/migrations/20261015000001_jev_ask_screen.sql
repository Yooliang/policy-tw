-- 公民提問送出時 Jev 先篩（2026-10-15，維護者：「Jev 先上，直接在提交時檢查」）
-- ask 端點在建 citizen_questions 之前問 Jev 一題三選一（可答／無關／隱私），判決記在 jev_decisions：
--   subject_type=citizen_question、subject_id=提問文字的 sha256、question=ask_screen。
-- 只擴 CHECK，不動資料。不存 IP。

ALTER TABLE jev_decisions DROP CONSTRAINT IF EXISTS jev_decisions_subject_type_check;
ALTER TABLE jev_decisions ADD CONSTRAINT jev_decisions_subject_type_check
  CHECK (subject_type IN ('policy', 'identity_review', 'politician_pair', 'contribution', 'vote', 'politician_election', 'news_item', 'politician', 'citizen_question'));
ALTER TABLE jev_decisions DROP CONSTRAINT IF EXISTS jev_decisions_question_check;
ALTER TABLE jev_decisions ADD CONSTRAINT jev_decisions_question_check
  CHECK (question IN ('is_policy', 'duplicate_of', 'election', 'identity', 'same_person', 'source_support', 'second_source', 'extract', 'vote_budget', 'followup', 'news_relevance', 'bio_education', 'bio_experience', 'ask_screen'));
