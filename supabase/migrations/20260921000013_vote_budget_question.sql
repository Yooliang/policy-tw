-- 票數預算的影子模式（使用者 2026-09-21）：jev_decisions.question 收 'vote_budget'。
--
-- Jev 對每一種貢獻型別的風險維度各給一個機率，超過閾值的維度各加一票；
-- 門檻 = max(型別地板, 2 − 中選會折扣 + 加成)。設計見 docs/PROPOSAL-jev-vote-budget.md。
--
-- 現在只記錄、不套用：0～5 的加成沒有校準資料，先看真實分布。
-- 記進來的 probabilities 是每一維的機率、state.budget 是當時算出來的整份預算，
-- 之後要回答「當初為什麼加這幾票」靠的就是這兩欄。
--
-- 這個 CHECK 與 _shared/system-one.ts 的 QUESTIONS 是同一份清單的兩份寫法，
-- 漏改一邊的形狀是「測試全綠、線上寫不進去」（CLAUDE.md 記著這個坑）。

ALTER TABLE jev_decisions DROP CONSTRAINT IF EXISTS jev_decisions_question_check;
ALTER TABLE jev_decisions ADD CONSTRAINT jev_decisions_question_check
  CHECK (question IN ('is_policy', 'duplicate_of', 'election', 'identity', 'same_person', 'source_support', 'second_source', 'extract', 'vote_budget'));
