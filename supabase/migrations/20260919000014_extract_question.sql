-- extract 動作（使用者 2026-09-19：「它應該是收到任務之後，分析關鍵字自己找來源，不一定要去看既有的那個」）。
--
-- 代理替 election_result_missing／candidate_status_stale 任務自己找到來源後，
-- POST system-one?action=extract { task_id, url }：伺服器抓那一頁、讓 Jev 從有限域裡選值（elected／not_elected、registered／not_running），
-- 回建議的 contribution 給代理照交。判定記在 jev_decisions：subject_type='politician_election'、subject_id=politician_elections.id、question='extract'。
-- 不是系統票，也不影響 contribution_system_vote（只看 source_support）。

ALTER TABLE jev_decisions DROP CONSTRAINT IF EXISTS jev_decisions_subject_type_check;
ALTER TABLE jev_decisions ADD CONSTRAINT jev_decisions_subject_type_check
  CHECK (subject_type IN ('policy', 'identity_review', 'politician_pair', 'contribution', 'politician_election'));

ALTER TABLE jev_decisions DROP CONSTRAINT IF EXISTS jev_decisions_question_check;
ALTER TABLE jev_decisions ADD CONSTRAINT jev_decisions_question_check
  CHECK (question IN ('is_policy', 'duplicate_of', 'election', 'identity', 'same_person', 'source_support', 'second_source', 'extract'));
